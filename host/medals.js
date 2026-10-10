'use strict';
/**
 * The medals Ricardo gives agents (BACKLOG #80), install-wide: one file, `.harness/state/medals.json`, keyed by agent NAME.
 *
 *   createMedals({ store, now, newId })
 *     .all()                         -> [{ agent, medals: [{ id, kind, reason, at }] }] | null   (null: not readable yet, never "no medals")
 *     .give(agent, kind, reason)     -> { ok: true, medals } | { ok: false, reason, medals }
 *     .remove(agent, id)             -> same shape
 *
 * A medal is given by hand and cannot be recomputed, so the file is treated like the wand's:
 *   - An edit never writes over a file it could not read (corrupt, unreadable, the wrong shape: `reason: 'unreadable'`, the file
 *     left alone, so no backup is needed: nothing is ever replaced). Only a MISSING file is created.
 *   - An edit touches ONLY the entry it names. Every other record is written back VERBATIM: a medal of a kind this build doesn't
 *     know (a newer branch's host shares this install-wide file), a reason longer than this build allows, extra fields, other
 *     keys of the file. `all()` shows what this build understands; it never decides what is on disk.
 *   - A file from a NEWER version (`version` above VERSION) is shown but not edited (`reason: 'newer-version'`).
 *   - The read-modify-write runs inside the store's cross-process lock (two windows can be open) and the write is the store's
 *     write-and-rename. A failed write is reported (`write-failed`), never swallowed.
 * `all()` keeps the last set it read: a file held for a moment (the antivirus) must not read as "no medals", so a failed read
 * answers the last good set (null if there never was one) and the next call tries again.
 *
 * The validation (kinds, name length, reason cleaning) is app/medals-display.js's, required rather than restated.
 */

const crypto = require('node:crypto');
const { kindOf, cleanReason, PER_AGENT_MAX, AGENT_MAX } = require('../app/medals-display');

const STORE_KEY = 'medals';
const VERSION = 1;
const AGENTS_MAX = 2000;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** The medals this build understands in a parsed file (a VIEW: unknown kinds and over-long reasons are shaped or left out), or null. */
function entriesOf(value) {
  if (!isObject(value) || !Array.isArray(value.agents)) return null;
  const out = [];
  for (const e of value.agents) {
    if (!isObject(e) || typeof e.agent !== 'string' || !e.agent || e.agent.length > AGENT_MAX || !Array.isArray(e.medals)) continue;
    const medals = e.medals
      .filter((m) => isObject(m) && kindOf(m.kind) && typeof m.id === 'string' && m.id)
      .map((m) => ({ id: m.id, kind: m.kind, reason: cleanReason(m.reason), at: typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : 0 }))
      .slice(0, PER_AGENT_MAX);
    if (medals.length) out.push({ agent: e.agent, medals });
  }
  return out;
}

function createMedals({ store, now = Date.now, newId = () => crypto.randomBytes(6).toString('hex') } = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.write !== 'function' || typeof store.withLock !== 'function') {
    throw new Error('createMedals: a store with readState, write and withLock is required');
  }
  let lastGood = null;

  /** { raw, editable } for a readable file (a missing one is an empty, editable file), or { error }. */
  function load() {
    let state;
    try { state = store.readState(STORE_KEY); } catch { return { error: 'unreadable' }; }
    if (state.status === 'missing') return { raw: { version: VERSION, agents: [] }, editable: true };
    if (state.status !== 'ok' || !isObject(state.value) || !Array.isArray(state.value.agents)) return { error: 'unreadable' };
    const v = state.value.version;
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 1)) return { error: 'unreadable' };
    return { raw: state.value, editable: v === undefined || v <= VERSION };
  }

  function all() {
    const r = load();
    if (r.error) return lastGood;
    lastGood = entriesOf(r.raw);
    return lastGood;
  }

  /** Run one edit on a fresh locked read: edit(rawAgents) -> { agents } | { refuse }. */
  function edit(fn) {
    let result;
    try {
      result = store.withLock(STORE_KEY, () => {
        const r = load();
        if (r.error) return { ok: false, reason: r.error };
        if (!r.editable) return { ok: false, reason: 'newer-version' };
        const next = fn(r.raw.agents);
        if (next.refuse) return { ok: false, reason: next.refuse };
        try { store.write(STORE_KEY, { ...r.raw, version: r.raw.version === undefined ? VERSION : r.raw.version, agents: next.agents }); } catch { return { ok: false, reason: 'write-failed' }; }
        return { ok: true };
      });
    } catch { return { ok: false, reason: 'busy', medals: all() }; }
    return { ...result, medals: all() };
  }

  const sameAgent = (agent) => (e) => isObject(e) && e.agent === agent;

  function give(agent, kind, reason) {
    if (!kindOf(kind) || typeof agent !== 'string' || !agent || agent.length > AGENT_MAX) return { ok: false, reason: 'invalid', medals: all() };
    return edit((agents) => {
      const at = agents.findIndex(sameAgent(agent));
      if (at < 0 && agents.length >= AGENTS_MAX) return { refuse: 'full' };
      const medal = { id: newId(), kind, reason: cleanReason(reason), at: now() };
      if (at < 0) return { agents: [...agents, { agent, medals: [medal] }] };
      if (!Array.isArray(agents[at].medals)) return { refuse: 'unreadable' };
      if (agents[at].medals.length >= PER_AGENT_MAX) return { refuse: 'full' };
      return { agents: agents.map((e, i) => (i === at ? { ...e, medals: [...e.medals, medal] } : e)) };
    });
  }

  function remove(agent, id) {
    return edit((agents) => {
      const at = agents.findIndex(sameAgent(agent));
      if (at < 0 || !Array.isArray(agents[at].medals) || !agents[at].medals.some((m) => isObject(m) && m.id === id)) return { refuse: 'no-such-medal' };
      const medals = agents[at].medals.filter((m) => !(isObject(m) && m.id === id));
      return { agents: medals.length ? agents.map((e, i) => (i === at ? { ...e, medals } : e)) : agents.filter((_, i) => i !== at) };
    });
  }

  return { all, give, remove, STORE_KEY };
}

module.exports = { createMedals, STORE_KEY, entriesOf, VERSION };
