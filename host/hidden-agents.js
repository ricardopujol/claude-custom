'use strict';
/**
 * Hide sleeping agents (BACKLOG #14), host side: the persisted, per-project set
 * of agents the user has hidden from the Active roster.
 *
 * THE HOST IS AUTHORITATIVE. It refuses to hide anything that is not asleep
 * right now, and it applies the same reconcile rule the renderer does
 * (app/hidden-agents-display.js `reconcileHidden` -- the two cannot import each
 * other, so test/hidden-agents.test.js pins that they agree) on every mood
 * update: an agent that wakes is un-hidden and the clearing is persisted. A
 * hidden flag on a live agent therefore cannot outlive the next mood tick,
 * even if a renderer is out of date or a window was closed at the time.
 *
 * PERSISTENCE. `.harness/state` is install-wide (see host/store.js's header),
 * so the set is keyed per project, and each project gets its OWN file --
 * `hidden-agents-<hash of the project path>.json` -- rather than one blob with
 * a key per project. Read-modify-write is not atomic across processes, and two
 * hosts on two projects are the normal case; separate files mean they cannot
 * lose each other's update. Regenerable convenience state, like cooldowns:
 * a corrupt file reads as "nothing hidden", never as an exception.
 *
 * A hidden name that has not been seen this host lifetime is KEPT by reconcile.
 * After a restart the roster is empty, and dropping the set at that moment
 * would forget everything the user hid.
 */

const crypto = require('node:crypto');

const MAX_NAME = 200;

const nameOf = (v) => (typeof v === 'string' && v ? v : null);

/** Distinct valid names, first-seen order. */
function cleanNames(names) {
  const out = [];
  for (const n of Array.isArray(names) ? names : []) {
    const name = nameOf(n);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Shape check for `{ type:'roster', action:'hide'|'unhide', agent }`. */
function validRosterMsg(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.action !== 'hide' && msg.action !== 'unhide') return false;
  return typeof msg.agent === 'string' && msg.agent.length > 0 && msg.agent.length <= MAX_NAME;
}

function storeKey(project) {
  const h = crypto.createHash('sha1').update(project).digest('hex').slice(0, 16);
  return `hidden-agents-${h}`;
}

function createHiddenAgents({ store, project } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new Error('createHiddenAgents: store is required');
  }
  if (typeof project !== 'string' || !project) throw new Error('createHiddenAgents: project is required');

  const key = storeKey(project);
  const saved = store.read(key, null);
  let hidden = cleanNames(saved && typeof saved === 'object' ? saved.hidden : null);

  // Persist and say whether it stuck. A failed write must not take the session
  // down (regenerable state), but it must not be reported as success either.
  function persist() {
    try {
      store.write(key, { project, hidden });
      return true;
    } catch {
      return false;
    }
  }

  return {
    list: () => hidden.slice(),

    /** Hide `agent` -- only if `rows` says it is sleeping right now. */
    hide(agent, rows) {
      const name = nameOf(agent);
      if (!name) return { ok: false, reason: 'bad-name', hidden: hidden.slice() };
      const asleep = (Array.isArray(rows) ? rows : [])
        .some(r => r && r.agent === name && r.state === 'sleeping');
      const awake = (Array.isArray(rows) ? rows : [])
        .some(r => r && r.agent === name && r.state !== 'sleeping');
      if (!asleep || awake) return { ok: false, reason: 'not-sleeping', hidden: hidden.slice() };
      if (hidden.includes(name)) return { ok: true, persisted: true, hidden: hidden.slice() };
      hidden = [...hidden, name];
      return { ok: true, persisted: persist(), hidden: hidden.slice() };
    },

    unhide(agent) {
      const name = nameOf(agent);
      if (!name || !hidden.includes(name)) return { changed: false, hidden: hidden.slice() };
      hidden = hidden.filter(n => n !== name);
      return { changed: true, persisted: persist(), hidden: hidden.slice() };
    },

    /** Apply the wake rule to the live roster; persist only if something cleared. */
    reconcile(rows) {
      const awake = new Set((Array.isArray(rows) ? rows : [])
        .filter(r => r && typeof r === 'object' && nameOf(r.agent) && r.state !== 'sleeping')
        .map(r => r.agent));
      const cleared = hidden.filter(n => awake.has(n));
      if (cleared.length === 0) return { hidden: hidden.slice(), cleared: [] };
      hidden = hidden.filter(n => !awake.has(n));
      const persisted = persist();
      return { hidden: hidden.slice(), cleared, persisted };
    },
  };
}

module.exports = { createHiddenAgents, validRosterMsg, storeKey, MAX_NAME };
