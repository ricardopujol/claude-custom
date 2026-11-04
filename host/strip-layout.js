'use strict';
/**
 * What the tab strip keeps between runs, with the project's other state (BACKLOG #141; documentation/DESIGN_TAB_STRIP.md):
 * the order the person dragged the lanes into, and the lanes they closed by hand, so a closed tab stays closed after a restart
 * (it is a row in the Lanes menu until they reopen it).
 *
 *   <project>\.claude-custom\tab-strip.json   { version: 1, order: [laneKey], closed: [{ key, path, branch }] }
 *
 * A key is the shell's own (app/tab-shell.js keyOf: the lower-cased worktree path), so it is only compared, never parsed.
 * `closed` is most recent first. Parsing is strict and drops what it doesn't understand one entry at a time; a FILE that
 * can't be read (any error but "missing") or isn't an object is an unknown store: load reports an error, and save refuses to
 * write over it (the person's data, in a state this code doesn't understand; the same rule as host/issue-links.js). With no
 * file (the look folder is a link elsewhere, host/style.js) the layout lives in memory for this run.
 */

const fs = require('fs');
const path = require('path');
const { lookDirState, ensureLookDir } = require('./style');
const { writeFileAtomic } = require('./atomic-write');
const { normPath } = require('./project-layout');

const FILE_NAME = 'tab-strip.json';
const VERSION = 1;
const MAX_ORDER = 500;
const MAX_CLOSED = 100;

const text = (s) => (typeof s === 'string' && s !== '' ? s : null);

/** <stateRoot>\.claude-custom\tab-strip.json, or null when .claude-custom is a link to somewhere else. */
function stripLayoutFileFor(stateRoot, fsImpl = fs) {
  if (lookDirState(stateRoot, fsImpl) === 'foreign') return null;
  return path.join(ensureLookDir(stateRoot, fsImpl), FILE_NAME);
}

function cleanOrder(list) {
  const out = [];
  for (const k of Array.isArray(list) ? list : []) if (text(k) && !out.includes(k)) out.push(k);
  return out.slice(0, MAX_ORDER);
}

function cleanClosed(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const key = text(c.key);
    const p = text(c.path);
    if (!key || !p || out.some(x => x.key === key)) continue;
    // Reopen finds a lane by `key` and un-closes it by `path`; a pair that disagrees would leave it closed for good (PR #227 Dexter 7).
    if (normPath(p) !== key) continue;
    out.push({ key, path: p, branch: text(c.branch) });
  }
  return out.slice(0, MAX_CLOSED);
}

/** The clean `{ order, closed }` of a file's text; throws when the text isn't a JSON object. */
function parseLayout(body) {
  const raw = JSON.parse(body);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  // A file of a later version is the person's data in a shape this code doesn't know: an unknown store, never read as v1 and rewritten.
  if (raw.version !== undefined && raw.version !== VERSION) throw new Error('unknown version');
  return { order: cleanOrder(raw.order), closed: cleanClosed(raw.closed) };
}

const stamp = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * When each lane was last closed, and when each was last reopened, from a file's text (PR #227 Dexter r2 C). The newer action on a
 * lane wins whichever window made it, so a close carries `at` and a reopen leaves a tombstone `{ key, at }` in `reopened`. They live
 * beside parseLayout's clean `{ order, closed }`, never in it: a file written before this has none, and reads as stamp 0.
 */
function parseStamps(body) {
  const closedAt = new Map();
  const reopenedAt = new Map();
  try {
    const raw = JSON.parse(body);
    for (const c of Array.isArray(raw.closed) ? raw.closed : []) if (c && text(c.key)) closedAt.set(c.key, Math.max(stamp(c.at), closedAt.get(c.key) || 0));
    for (const r of Array.isArray(raw.reopened) ? raw.reopened : []) if (r && text(r.key)) reopenedAt.set(r.key, Math.max(stamp(r.at), reopenedAt.get(r.key) || 0));
  } catch { /* parseLayout has already judged the text */ }
  return { closedAt, reopenedAt };
}

function createStripLayout({
  file = null,
  readText = (f) => fs.readFileSync(f, 'utf8'),
  writeText = (f, body) => writeFileAtomic(f, body),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  now = () => Date.now(),
} = {}) {
  let unknown = null;     // why the file can't be written over, once load has seen it
  let last = { order: [], closed: [] };   // what THIS window last loaded or saved: the base a save is merged against
  let lastAt = new Map();                 // key -> when the lane in `last.closed` was closed (what this window holds it closed since)

  /** `{ order, closed, error }`: read from disk each time it's asked (the shell asks once, at its start). */
  function load() {
    unknown = null;
    last = { order: [], closed: [] };
    lastAt = new Map();
    if (!file) return { order: [], closed: [], error: null };
    let body;
    try { body = readText(file); } catch (err) {
      if (err && err.code === 'ENOENT') return { order: [], closed: [], error: null };
      unknown = `can't read ${file}: ${(err && err.message) || String(err)}`;
      return { order: [], closed: [], error: unknown };
    }
    try {
      const l = parseLayout(body);
      last = { order: l.order, closed: l.closed };
      lastAt = parseStamps(body).closedAt;
      return { ...l, error: null };
    } catch {
      unknown = `${file} isn't a tab strip file; left alone`;
      return { order: [], closed: [], error: unknown };
    }
  }

  /** Save `{ order, closed }`. `{ ok: true }`, or `{ ok: false, error }`; never a throw. */
  function save(layout) {
    if (unknown) return { ok: false, error: unknown };
    const src = layout && typeof layout === 'object' ? layout : {};
    const mine = { order: cleanOrder(src.order), closed: cleanClosed(src.closed) };
    if (!file) return { ok: true };
    try {
      // Other windows of this project write the same file, each from its own memory: merge into what is on disk instead of
      // replacing it (PR #227 Dexter 2). A lane THIS window reopened (it was closed when it loaded or last saved) is removed;
      // a lane another window closed stays closed; the order is this window's only if this window changed it.
      let onDisk = { order: [], closed: [] };
      let diskStamps = { closedAt: new Map(), reopenedAt: new Map() };
      try {
        const body = readText(file);
        onDisk = parseLayout(body);
        diskStamps = parseStamps(body);
      } catch (err) {
        if (!(err && err.code === 'ENOENT')) {
          // not sticky: a scan holding the file now may let go by the next save
          return { ok: false, error: `can't merge into ${file}: ${(err && err.message) || String(err)}` };
        }
      }
      const t = now();
      const reopened = new Set(last.closed.filter(c => !mine.closed.some(m => m.key === c.key)).map(c => c.key));
      // The newer action on a lane wins (PR #227 Dexter r2 C). A lane this window closed since its last save is closed NOW. A lane it
      // only still holds closed (it never heard of another window's reopen) keeps the time it was closed at, and gives way to a reopen
      // recorded since. A lane this window reopened leaves a tombstone for the windows that still hold it.
      const candidates = [];      // { c, at }, this window's first, then the disk's
      for (const c of mine.closed) candidates.push({ c, at: lastAt.has(c.key) ? lastAt.get(c.key) : t });
      for (const c of onDisk.closed) if (!reopened.has(c.key)) candidates.push({ c, at: diskStamps.closedAt.get(c.key) || 0 });
      const tombs = new Map(diskStamps.reopenedAt);
      for (const k of reopened) tombs.set(k, Math.max(t, tombs.get(k) || 0));
      const best = new Map();     // key -> the newest close of it that no reopen is newer than
      for (const cand of candidates) {
        if ((tombs.get(cand.c.key) ?? -1) >= cand.at) continue;
        const have = best.get(cand.c.key);
        if (!have || cand.at > have.at) best.set(cand.c.key, cand);
      }
      const kept = cleanClosed(candidates.filter(cand => best.get(cand.c.key) === cand).map(cand => cand.c));
      for (const c of kept) tombs.delete(c.key);      // a close newer than its tombstone supersedes it
      const closed = kept;
      const keptAt = new Map(kept.map(c => [c.key, best.get(c.key).at]));
      const tombList = [...tombs].map(([key, at]) => ({ key, at })).sort((a, b) => b.at - a.at).slice(0, MAX_CLOSED);
      // A prune (the shell drops a lane git no longer lists) is not a drag: only keys added, or the keys both lists share in
      // a different order, count as this window changing the order (PR #227 Dexter r2 B).
      const lastKeys = new Set(last.order);
      const shared = mine.order.filter(k => lastKeys.has(k));
      const orderChanged = mine.order.some(k => !lastKeys.has(k)) || JSON.stringify(shared) !== JSON.stringify(last.order.filter(k => mine.order.includes(k)));
      const merged = { order: orderChanged ? mine.order : onDisk.order, closed };
      mkdir(path.dirname(file));
      const stamped = { order: merged.order, closed: merged.closed.map(c => ({ ...c, at: keptAt.get(c.key) })), reopened: tombList };
      writeText(file, JSON.stringify({ version: VERSION, ...stamped }, null, 2) + '\n');
      // What this window holds closed is what it was given, at the time it is held since: a stale hold the file dropped is still held.
      lastAt = new Map(mine.closed.map(c => [c.key, keptAt.has(c.key) ? keptAt.get(c.key) : (lastAt.has(c.key) ? lastAt.get(c.key) : t)]));
      last = mine;
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    return { ok: true };
  }

  return { load, save };
}

module.exports = { createStripLayout, stripLayoutFileFor, parseLayout, FILE_NAME };
