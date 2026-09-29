'use strict';
/**
 * Hide sleeping agents (BACKLOG #14), host side: the persisted, per-project set
 * of agents the user has hidden from the Active roster.
 *
 * THE HOST IS AUTHORITATIVE. It refuses to hide anything that is not asleep
 * right now, and it applies the wake rule on every mood update: an agent that
 * wakes is un-hidden and the clearing is persisted. A hidden flag on a live
 * agent therefore cannot outlive the next mood tick, even if a renderer is out
 * of date or a window was closed at the time.
 *
 * ONE RULE, ONE PLACE (Miguel M1, PR #66). The rule lives in
 * app/hidden-agents-display.js (`reconcileHidden`, `cleanNames`,
 * `HIDDEN_NAME_MAX`) and is REQUIRED from there, not restated. That file is an
 * IIFE with a module.exports branch precisely so both ends can share it.
 *
 * PERSISTENCE. `.harness/state` is install-wide (see host/store.js's header),
 * so the set is keyed per project, and each project gets its OWN file --
 * `hidden-agents-<hash of the normalised project path>.json`. The path goes
 * through `normalizeProjectPath` first (Dexter F2 / Miguel M5): `C:\p` and
 * `c:\p` are one project everywhere else in the host, so they must be one
 * file here. Regenerable convenience state, like cooldowns: a corrupt file
 * reads as "nothing hidden", never as an exception.
 *
 * KNOWN LIMIT, CHOSEN NOT FIXED (Dexter F6). Two hosts on the SAME project
 * (a second window started with CLAUDE_CUSTOM_PORT) each hold their own
 * in-memory set and rewrite the whole file, so the last writer wins. Separate
 * files stop two different PROJECTS losing each other's update, which is the
 * normal case; they do not protect the same project. Locking and merge-on-write
 * would cost more than a lost hide is worth: the set is a convenience the user
 * can redo with one click.
 *
 * A FAILED WRITE IS RETRIED (Dexter F3). Memory moves first and the write is
 * best-effort, so a write that throws leaves disk stale. That is remembered in
 * `dirty` and the next `reconcile` -- which runs on every mood change -- writes
 * again, instead of letting a cleared flag come back after a restart.
 *
 * A hidden name that has not been seen this host lifetime is KEPT by reconcile.
 * After a restart the roster is empty, and dropping the set at that moment
 * would forget everything the user hid. The set is capped at HIDDEN_MAX names,
 * oldest dropped (Miguel M4): every hidden name must have been a sleeping row
 * when hidden, so growth was already bounded by history, but `hello` ships the
 * whole list and nothing else ever prunes it.
 */

const crypto = require('node:crypto');
const { normalizeProjectPath } = require('./project-path');
const { reconcileHidden, cleanNames, HIDDEN_NAME_MAX } = require('../app/hidden-agents-display');

const HIDDEN_MAX = 200;

const nameOf = (v) => (typeof v === 'string' && v && v.length <= HIDDEN_NAME_MAX ? v : null);

/** Shape check for `{ type:'roster', action:'hide'|'unhide', agent }`. */
function validRosterMsg(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.action !== 'hide' && msg.action !== 'unhide') return false;
  return nameOf(msg.agent) !== null;
}

function storeKey(project) {
  const id = normalizeProjectPath(project);
  if (id === null) throw new Error('hidden-agents: project is not a usable path');
  const h = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
  return `hidden-agents-${h}`;
}

function createHiddenAgents({ store, project } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new Error('createHiddenAgents: store is required');
  }
  if (typeof project !== 'string' || !project.trim()) throw new Error('createHiddenAgents: project is required');

  const key = storeKey(project);
  const saved = store.read(key, null);
  let hidden = cleanNames(saved && typeof saved === 'object' ? saved.hidden : null).slice(-HIDDEN_MAX);
  let dirty = false;

  // Persist and say whether it stuck. A failed write must not take the session
  // down (regenerable state), but it must not be reported as success either,
  // and it must be tried again (`dirty`).
  function persist() {
    try {
      store.write(key, { project, hidden });
      dirty = false;
    } catch {
      dirty = true;
    }
    return !dirty;
  }

  return {
    list: () => hidden.slice(),

    /** Hide `agent` -- only if `rows` says it is sleeping right now. */
    hide(agent, rows) {
      const name = nameOf(agent);
      if (!name) return { ok: false, reason: 'bad-name', hidden: hidden.slice() };
      const list = Array.isArray(rows) ? rows : [];
      const asleep = list.some(r => r && r.agent === name && r.state === 'sleeping');
      const awake = list.some(r => r && r.agent === name && r.state !== 'sleeping');
      if (!asleep || awake) return { ok: false, reason: 'not-sleeping', hidden: hidden.slice() };
      if (hidden.includes(name)) return { ok: true, persisted: !dirty || persist(), hidden: hidden.slice() };
      hidden = [...hidden, name].slice(-HIDDEN_MAX);
      return { ok: true, persisted: persist(), hidden: hidden.slice() };
    },

    unhide(agent) {
      const name = nameOf(agent);
      if (!name || !hidden.includes(name)) return { changed: false, hidden: hidden.slice() };
      hidden = hidden.filter(n => n !== name);
      return { changed: true, persisted: persist(), hidden: hidden.slice() };
    },

    /**
     * Apply the wake rule to the live roster. Writes only when something
     * cleared, or when an earlier write failed and disk is still stale.
     */
    reconcile(rows) {
      const out = reconcileHidden(hidden, rows);
      hidden = out.hidden;
      const persisted = (out.cleared.length > 0 || dirty) ? persist() : true;
      return { hidden: hidden.slice(), cleared: out.cleared, persisted };
    },
  };
}

module.exports = {
  createHiddenAgents, validRosterMsg, storeKey, HIDDEN_MAX, MAX_NAME: HIDDEN_NAME_MAX,
};
