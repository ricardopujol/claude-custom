'use strict';
/**
 * Invisible usage counters (audit move 2): which features earn their rail slot. One install-wide file,
 * `.harness/state/usage-counters.json`, `{ "<key>": { "count": N, "last": "<ISO>" } }`. Keys and timestamps only: no text, no
 * paths, no project names. Nothing in the UI reads it; `scripts/usage-report.js` prints it.
 *
 *   createUsageCounters({ store, now, debounceMs })
 *     .bump(key)  -> { ok: true, count } | { ok: false, reason }   reasons: invalid, debounced, unreadable, busy, write-failed
 *     .all()      -> { key: { count, last } } | null               (null: the file can't be read; {} when it's missing)
 *
 * Guarantees (test/usage-counters.test.js):
 *   - A count only goes up. The read-modify-write runs inside the store's cross-process lock (every tab is its own host).
 *   - A file it can't read (corrupt, the wrong shape, a bad entry for the key) is NEVER written over: it's copied to
 *     `usage-counters.json.bad` once, left where it is, and the bump is refused (`unreadable`). Only a MISSING file is created.
 *   - Every other key is written back verbatim (a newer branch's keys survive).
 *   - The key must pass `isValidKey` (a fixed set, `panel:<id>`, `game:<name>:start`); anything else is ignored.
 *   - A `panel:` key, and `style:changed` (a slider drag), count once per 2 s (a hover flicker is one show, not ten).
 */

const fs = require('node:fs');

const STORE_KEY = 'usage-counters';
const KEYS_MAX = 500;
const PANEL_DEBOUNCE_MS = 2000;

const STATIC_KEYS = Object.freeze([
  'ask:question', 'ask:place-opened', 'medal:given', 'wand:click', 'style:changed', 'vault:opened', 'git:opened',
  'projects:switch', 'canvas:render', 'focus:on', 'lean:on', 'terminal:file-link', 'terminal:drop', 'tab:new-worktree',
  'tab:merged-close', 'bedtime:start', 'quota:countdown-shown', 'ask:explain',
]);
const STATIC_SET = new Set(STATIC_KEYS);
const PANEL_KEY = /^panel:[a-z0-9-]{1,32}$/;
const GAME_KEY = /^game:[a-z0-9-]{1,24}:start$/;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const validEntry = (e) => isObject(e) && Number.isSafeInteger(e.count) && e.count >= 0;

const isDebounced = (key) => key.startsWith('panel:') || key === 'style:changed';

function isValidKey(key) {
  return typeof key === 'string' && (STATIC_SET.has(key) || PANEL_KEY.test(key) || GAME_KEY.test(key));
}

function createUsageCounters({ store, now = Date.now, debounceMs = PANEL_DEBOUNCE_MS } = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.write !== 'function' || typeof store.withLock !== 'function') {
    throw new Error('createUsageCounters: a store with readState, write and withLock is required');
  }
  const lastShown = new Map();

  /** { value } for a readable file (missing: an empty one), or { error: 'unreadable' } after setting a corrupt one aside. */
  function load() {
    let state;
    try { state = store.readState(STORE_KEY); } catch { return { error: 'unreadable' }; }
    if (state.status === 'missing') return { value: {} };
    if (state.status !== 'ok' || !isObject(state.value)) {
      if (state.status === 'corrupt' || state.status === 'ok') keepAside();
      return { error: 'unreadable' };
    }
    return { value: state.value };
  }

  /** Copy the unreadable file to `<file>.bad` unless one is already there (the first evidence is the one worth keeping). */
  function keepAside() {
    try {
      const file = store.pathOf(STORE_KEY);
      if (!fs.existsSync(`${file}.bad`)) fs.copyFileSync(file, `${file}.bad`);
    } catch { /* best effort: the original is untouched either way */ }
  }

  function all() {
    const r = load();
    return r.error ? null : r.value;
  }

  function bump(key) {
    if (!isValidKey(key)) return { ok: false, reason: 'invalid' };
    const t = now();
    if (isDebounced(key)) {
      const prev = lastShown.get(key);
      if (prev !== undefined && t - prev < debounceMs) return { ok: false, reason: 'debounced' };
    }
    let result;
    try {
      result = store.withLock(STORE_KEY, () => {
        const r = load();
        if (r.error) return { ok: false, reason: r.error };
        const entry = r.value[key];
        if (entry !== undefined && !validEntry(entry)) return { ok: false, reason: 'unreadable' };
        if (entry === undefined && Object.keys(r.value).length >= KEYS_MAX) return { ok: false, reason: 'full' };
        const count = (entry ? entry.count : 0) + 1;
        if (!Number.isSafeInteger(count)) return { ok: false, reason: 'full' };
        const next = { ...r.value, [key]: { ...(entry || {}), count, last: new Date(t).toISOString() } };
        try { store.write(STORE_KEY, next); } catch { return { ok: false, reason: 'write-failed' }; }
        return { ok: true, count };
      });
    } catch { return { ok: false, reason: 'busy' }; }
    if (result.ok && isDebounced(key)) lastShown.set(key, t);
    return result;
  }

  return { bump, all, STORE_KEY };
}

module.exports = { createUsageCounters, isValidKey, STATIC_KEYS, STORE_KEY, PANEL_DEBOUNCE_MS };
