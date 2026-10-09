'use strict';
/**
 * The medals Ricardo gives agents (BACKLOG #80), install-wide: one file, `.harness/state/medals.json`, keyed by agent NAME.
 *
 *   createMedals({ store, now, newId })
 *     .all()                         -> [{ agent, medals: [{ id, kind, reason, at }] }]   (never throws; [] when unreadable)
 *     .give(agent, kind, reason)     -> { ok: true, medals } | { ok: false, reason, medals }
 *     .remove(agent, id)             -> same shape
 *
 * A medal is given by hand and cannot be recomputed, so the file is treated like the wand's: an edit never writes over a file
 * it could not read (corrupt, unreadable, the wrong shape: refused with `reason: 'unreadable'`, the file left alone). Only a
 * MISSING file is created. The read-modify-write runs inside the store's cross-process lock (two windows can be open), and the
 * write is the store's write-and-rename (atomic). A failed write is reported (`write-failed`), never swallowed.
 *
 * The validation (kinds, name length, reason cleaning) is app/medals-display.js's, required rather than restated.
 */

const crypto = require('node:crypto');
const { kindOf, cleanReason, PER_AGENT_MAX, AGENT_MAX } = require('../app/medals-display');

const STORE_KEY = 'medals';
const VERSION = 1;
const AGENTS_MAX = 2000;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** The entries in a parsed file, or null when the file is not ours. Bad entries inside a good file are dropped. */
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

  /** { entries } when the file can be edited (present and ours, or missing), else { entries: null }. */
  function load() {
    let state;
    try { state = store.readState(STORE_KEY); } catch { return { entries: null }; }
    if (state.status === 'missing') return { entries: [] };
    if (state.status !== 'ok') return { entries: null };
    return { entries: entriesOf(state.value) };
  }

  function all() {
    const { entries } = load();
    return entries || [];
  }

  /** Run one edit on a fresh locked read: edit(entries) -> { entries } | { refuse }. */
  function edit(fn) {
    let result;
    try {
      result = store.withLock(STORE_KEY, () => {
        const { entries } = load();
        if (entries === null) return { ok: false, reason: 'unreadable' };
        const next = fn(entries);
        if (next.refuse) return { ok: false, reason: next.refuse };
        try { store.write(STORE_KEY, { version: VERSION, agents: next.entries }); } catch { return { ok: false, reason: 'write-failed' }; }
        return { ok: true };
      });
    } catch { return { ok: false, reason: 'busy', medals: all() }; }
    return { ...result, medals: all() };
  }

  function give(agent, kind, reason) {
    if (!kindOf(kind) || typeof agent !== 'string' || !agent || agent.length > AGENT_MAX) return { ok: false, reason: 'invalid', medals: all() };
    return edit((entries) => {
      const at = entries.findIndex((e) => e.agent === agent);
      if (at < 0 && entries.length >= AGENTS_MAX) return { refuse: 'full' };
      if (at >= 0 && entries[at].medals.length >= PER_AGENT_MAX) return { refuse: 'full' };
      const medal = { id: newId(), kind, reason: cleanReason(reason), at: now() };
      if (at < 0) return { entries: [...entries, { agent, medals: [medal] }] };
      return { entries: entries.map((e, i) => (i === at ? { agent, medals: [...e.medals, medal] } : e)) };
    });
  }

  function remove(agent, id) {
    return edit((entries) => {
      const at = entries.findIndex((e) => e.agent === agent);
      if (at < 0 || !entries[at].medals.some((m) => m.id === id)) return { refuse: 'no-such-medal' };
      const medals = entries[at].medals.filter((m) => m.id !== id);
      return { entries: medals.length ? entries.map((e, i) => (i === at ? { agent, medals } : e)) : entries.filter((_, i) => i !== at) };
    });
  }

  return { all, give, remove, STORE_KEY };
}

module.exports = { createMedals, STORE_KEY, entriesOf };
