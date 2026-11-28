'use strict';
/**
 * Jiandu's own record of the projects it opened, with the pins and the removed set (documentation/DESIGN_PROJECT_HUB.md §3, H2, H7;
 * plan documentation/PLAN_PROJECT_HUB.md H-PR1). Install-wide, in main's uiStore under STORE_KEY:
 *
 *   { version: 1, projects: [{ root, lastOpened }], pins: [root], removed: [root] }
 *
 *   read()            -> { projects, pins, removed }, sanitized. Never throws: a missing, corrupt, unreadable or newer file is empty.
 *                        A corrupt, malformed or newer file is said in one log line (PR #262 Miguel G2), once until a good read; a
 *                        file that could not be read just now (EBUSY / EPERM) is not, as it is transient (H-PR2 keeps the last
 *                        good record across one: Dexter 5).
 *   readFresh()       -> read(), or null when the file could not be read just now (H-PR2's Home keeps its last good record then).
 *   opened(root)      -> the record after it, or null. lastOpened = now(); the root leaves the removed set (design §6 default: an
 *                        open puts a removed project back).
 *   pin(root, on)     -> the record after it, or null. `on` must be a real boolean. A pin takes the root out of the removed set
 *                        (Dexter 3, an open question: the default built), so a pinned card stays when its sessions end.
 *   remove(root)      -> the record after it, or null. The root joins the removed set; its pin and its entry go. Nothing on disk
 *                        outside this file changes.
 *
 * Pins are made by hand, so like the wand and the medals every edit runs on a fresh readState inside the store's cross-process lock
 * and writes only over 'ok' or 'missing': a corrupt or unreadable file, or a newer version, is never written over (the edit answers
 * null and logs one line). Roots are compared by keyOf (normPath: case, separators, junctions) and stored as first spelled.
 *
 * Caps (Dexter 4, Miguel G5). The UNPINNED entries of `projects` are capped: past MAX_PROJECTS, an open drops the oldest unpinned
 * entries (no time is oldest) until the list fits, and never the root it just opened. A pinned entry is never dropped, so with
 * more than MAX_PROJECTS pins the list holds every pinned entry plus the one just opened. Pins and removed hold MAX_LIST each (the
 * oldest goes first), which bounds that too.
 *
 * Main-process only (required, never a page <script>).
 */

const { normPath, projectOf: realProjectOf } = require('../host/project-layout');
const { timeOf, isPath } = require('./home-values');

const STORE_KEY = 'home-projects';
const VERSION = 1;
const MAX_PROJECTS = 200;
const MAX_LIST = 500;
// The lock is waited on synchronously (host/file-lock.js, Atomics.wait) and this runs on Electron main: the default 3 s would freeze
// every window while another process holds the file. A record missed for that is one line in the log.
const LOCK_WAIT_MS = 500;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const EMPTY = () => ({ projects: [], pins: [], removed: [] });

function createHomeRecord({ store, keyOf = normPath, projectOf = realProjectOf, now = Date.now, log = () => {} } = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.write !== 'function' || typeof store.withLock !== 'function') {
    throw new Error('createHomeRecord: a store with readState, write and withLock is required');
  }
  // ONE identity with app/home-model.js (PR #262 Dexter R2-1): a path is its project root (projectOf; a path it cannot place is its
  // own root), compared by keyOf. So a lane path in any list matches its card, and an edit stores the root, never the lane.
  const rootOf = (p) => {
    try {
      const pr = projectOf(p);
      return pr && isPath(pr.root) ? pr.root : p;
    } catch { return p; }
  };
  const keyFor = (p) => { try { return keyOf(rootOf(p)); } catch { return null; } };

  /** A list of roots: paths only, once each by key (the first spelling), the newest MAX_LIST kept. */
  function rootList(v) {
    const seen = new Set();
    const out = [];
    for (const p of Array.isArray(v) ? v : []) {
      const k = isPath(p) ? keyFor(p) : null;
      if (k === null || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out.slice(-MAX_LIST);
  }

  function projectList(v) {
    const byKey = new Map();
    for (const p of Array.isArray(v) ? v : []) {
      if (!isObject(p) || !isPath(p.root)) continue;
      const k = keyFor(p.root);
      if (k === null) continue;
      const t = timeOf(p.lastOpened);
      const had = byKey.get(k);
      if (!had) byKey.set(k, { root: p.root, lastOpened: t });
      else if (t !== null && (had.lastOpened === null || t > had.lastOpened)) had.lastOpened = t;
    }
    return [...byKey.values()];
  }

  const sanitize = (raw) => ({ projects: projectList(raw.projects), pins: rootList(raw.pins), removed: rootList(raw.removed) });

  /** { record } for a file that may be written over (a missing one is empty), or { error }. */
  function load() {
    let st;
    try { st = store.readState(STORE_KEY); } catch (err) { return { error: `unreadable (${err && err.message})` }; }
    return loadFrom(st);
  }

  /** load() on a readState already read (readFresh checks and answers from ONE read: PR #263 Dexter 6). */
  function loadFrom(st) {
    if (!isObject(st)) return { error: 'unreadable (no state)' };
    if (st.status === 'missing') return { record: EMPTY() };
    if (st.status !== 'ok') return { error: st.status };
    if (!isObject(st.value)) return { error: 'not a record' };
    const v = st.value.version;
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 1)) return { error: 'a bad version' };
    if (typeof v === 'number' && v > VERSION) return { error: `version ${v}, newer than this build's ${VERSION}` };
    return { record: sanitize(st.value) };
  }

  // The damage last said in the log (Miguel G2): read() runs on every Home push, so it is said once, and again only after a good read.
  let saidDamage = null;
  function read() { return answer(load()); }

  function answer(r) {
    if (!r.error) { saidDamage = null; return r.record; }
    if (!r.error.startsWith('unreadable') && r.error !== saidDamage) {
      saidDamage = r.error;
      log(`[main] ${STORE_KEY}: the file is ${r.error}; Home shows no pins or removed set until it is fixed`);
    }
    return EMPTY();
  }

  /** read(), but null when the file could not be read just now (EBUSY / EPERM): the caller keeps its last good record (Dexter 5).
   *  ONE read: the answer comes from the state it checked, so a second read failing cannot hand back an empty record (PR #263 Dexter 6). */
  function readFresh() {
    let st;
    try { st = store.readState(STORE_KEY); } catch { return null; }
    if (!isObject(st) || st.status === 'unreadable') return null;
    return answer(loadFrom(st));
  }

  /** One edit on a fresh locked read: fn(record, key) -> the next record. Null when it was refused or failed. */
  function edit(root, fn) {
    const key = isPath(root) ? keyFor(root) : null;
    if (key === null) return null;
    try {
      return store.withLock(STORE_KEY, () => {
        const r = load();
        if (r.error) {
          log(`[main] ${STORE_KEY}: the file is ${r.error}; not written`);
          return null;
        }
        const next = fn(r.record, key, rootOf(root));
        store.write(STORE_KEY, { version: VERSION, ...next });
        return next;
      }, { deadlineMs: LOCK_WAIT_MS });
    } catch (err) {
      log(`[main] ${STORE_KEY}: ${err && err.message}; not written`);
      return null;
    }
  }

  const without = (list, key) => list.filter((p) => keyFor(p) !== key);
  const withoutEntry = (list, key) => list.filter((p) => keyFor(p.root) !== key);

  function opened(root) {
    return edit(root, (rec, key, folded) => {
      const t = timeOf(now());
      const had = rec.projects.find((p) => keyFor(p.root) === key);
      let projects = had
        ? rec.projects.map((p) => (p === had ? { root: p.root, lastOpened: t } : p))
        : [...rec.projects, { root: folded, lastOpened: t }];
      if (projects.length > MAX_PROJECTS) projects = capProjects(projects, new Set([...rec.pins.map(keyFor), key]));
      return { projects, pins: rec.pins, removed: without(rec.removed, key) };
    });
  }

  /** Drop the oldest entries not in `kept` (the pins and the root just opened; no time is oldest) until the list fits, or none is left to drop. */
  function capProjects(projects, kept) {
    const order = projects.map((p, i) => ({ p, i })).filter(({ p }) => !kept.has(keyFor(p.root)))
      .sort((a, b) => (a.p.lastOpened || 0) - (b.p.lastOpened || 0) || a.i - b.i);
    const drop = new Set(order.slice(0, projects.length - MAX_PROJECTS).map(({ p }) => p));
    return projects.filter((p) => !drop.has(p));
  }

  function pin(root, on) {
    if (typeof on !== 'boolean') return null;
    return edit(root, (rec, key, folded) => {
      const has = rec.pins.some((p) => keyFor(p) === key);
      const pins = on ? (has ? rec.pins : [...rec.pins, folded].slice(-MAX_LIST)) : without(rec.pins, key);
      return { projects: rec.projects, pins, removed: on ? without(rec.removed, key) : rec.removed };
    });
  }

  function remove(root) {
    return edit(root, (rec, key, folded) => {
      const has = rec.removed.some((p) => keyFor(p) === key);
      return {
        projects: withoutEntry(rec.projects, key),
        pins: without(rec.pins, key),
        removed: has ? rec.removed : [...rec.removed, folded].slice(-MAX_LIST),
      };
    });
  }

  return { read, readFresh, opened, pin, remove };
}

module.exports = { createHomeRecord, STORE_KEY, VERSION, MAX_PROJECTS, MAX_LIST };
