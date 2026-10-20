'use strict';
/**
 * Invisible usage counters (audit move 2): which features earn their rail slot. One install-wide file,
 * `.harness/state/usage-counters.json`, `{ "<key>": { "count": N, "last": "<ISO>" } }`. Keys and timestamps only: no text, no
 * paths, no project names. Nothing in the UI reads it; `scripts/usage-report.js` prints it.
 *
 *   createUsageCounters({ store, now, debounceMs })
 *     .bump(key)  -> { ok: true, count } | { ok: false, reason }   reasons: invalid, debounced, rate, unreadable, busy, full, write-failed
 *     .all()      -> { key: { count, last } } | null               (null: the file can't be read; {} when it's missing)
 *
 * Guarantees (test/usage-counters.test.js):
 *   - A count only goes up. The read-modify-write runs inside the store's cross-process lock (every tab is its own host).
 *   - A file it can't read (corrupt, the wrong shape, a bad entry for the key) is NEVER written over: it's copied to
 *     `usage-counters.json.bad` once, left where it is, and the bump is refused (`unreadable`). Only a MISSING file is created.
 *   - Every other key is written back verbatim (a newer branch's keys survive).
 *   - The key must pass `isValidKey` (a fixed set, `panel:<id>`, `game:<name>:start`); anything else is ignored.
 *   - A `panel:` key, and `style:changed`, count once per 2 s per process (a hover flicker is one show, not ten). So a 10 s
 *     slider drag in the Style panel counts 5: read `style:changed` as "the Style panel was touched", not as a number of edits.
 *     The debounce runs on the wall clock; a clock stepped backwards silences a key until it catches up (accepted).
 *   - The key must be a REAL one: `panel:<id>` is a dock panel (PANEL_IDS, app/side-tabs.js) and `game:<name>:start` a real game
 *     (GAME_IDS, app/games-display.js ORDER); test/usage-counters.test.js keeps both lists equal to those files. So junk can't
 *     fill the file and lock real keys out (`full`, KEYS_MAX).
 *   - At most RATE_PER_SEC bumps a second per process (`rate`), and the lock is waited for at most LOCK_WAIT_MS (`busy`): a
 *     counter loses a count before it costs the pty host or Electron main a frame.
 *   - What panel counts MEAN: a panel shown after the layout loaded, by a user gesture (a tab, the rail, the Window menu). Startup,
 *     layout loads and leaving lean mode are not counted. A rail hover-peek counts as a show.
 */

const fs = require('node:fs');

const STORE_KEY = 'usage-counters';
const KEYS_MAX = 100;
const RATE_PER_SEC = 20;
const LOCK_WAIT_MS = 250;
const PANEL_DEBOUNCE_MS = 2000;

const STATIC_KEYS = Object.freeze([
  'ask:question', 'ask:place-opened', 'medal:given', 'wand:click', 'style:changed', 'vault:opened', 'git:opened',
  'projects:switch', 'canvas:render', 'focus:on', 'lean:on', 'terminal:file-link', 'terminal:drop', 'tab:new-worktree',
  'tab:merged-close', 'bedtime:start', 'quota:countdown-shown', 'ask:explain',
]);
const STATIC_SET = new Set(STATIC_KEYS);
const PANEL_IDS = Object.freeze(['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style', 'wand', 'resources', 'canvas', 'preview', 'ask', 'games']);
const GAME_IDS = Object.freeze(['stack', 'merge', 'pipeline']);
const PANEL_SET = new Set(PANEL_IDS.map((id) => `panel:${id}`));
const GAME_SET = new Set(GAME_IDS.map((id) => `game:${id}:start`));

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const validEntry = (e) => isObject(e) && Number.isSafeInteger(e.count) && e.count >= 0;

const isDebounced = (key) => key.startsWith('panel:') || key === 'style:changed';

function isValidKey(key) {
  return typeof key === 'string' && (STATIC_SET.has(key) || PANEL_SET.has(key) || GAME_SET.has(key));
}

function createUsageCounters({ store, now = Date.now, debounceMs = PANEL_DEBOUNCE_MS, log = () => {} } = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.write !== 'function' || typeof store.withLock !== 'function') {
    throw new Error('createUsageCounters: a store with readState, write and withLock is required');
  }
  const lastShown = new Map();
  let tokens = RATE_PER_SEC;
  let refilledAt = null;

  /** A token bucket: RATE_PER_SEC a second, a burst of as many. */
  function takeToken(t) {
    if (refilledAt !== null && t > refilledAt) tokens = Math.min(RATE_PER_SEC, tokens + ((t - refilledAt) * RATE_PER_SEC) / 1000);
    if (refilledAt === null || t > refilledAt) refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

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
    } catch (err) { log(`[usage] could not set the unreadable counters file aside: ${err && err.message}`); }
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
    if (!takeToken(t)) return { ok: false, reason: 'rate' };
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
      }, { deadlineMs: LOCK_WAIT_MS });
    } catch { return { ok: false, reason: 'busy' }; }
    if (result.ok && isDebounced(key)) lastShown.set(key, t);
    return result;
  }

  return { bump, all, STORE_KEY };
}

module.exports = { createUsageCounters, isValidKey, STATIC_KEYS, PANEL_IDS, GAME_IDS, STORE_KEY, PANEL_DEBOUNCE_MS, KEYS_MAX, RATE_PER_SEC, LOCK_WAIT_MS };
