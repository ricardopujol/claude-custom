'use strict';
/**
 * What the tab strip keeps between runs, with the project's other state (BACKLOG #141; documentation/DESIGN_TAB_STRIP.md):
 * the order the person dragged the lanes into, and the lanes they closed by hand, so a closed tab stays closed after a restart
 * (it is a row in the Lanes menu until they reopen it).
 *
 *   <project>\.claude-custom\tab-strip.json   { version: 1, order: [laneKey], closed: [{ key, path, branch, at }], reopened: [{ key, at }] }
 *
 * `at` is when the lane was closed and `reopened` holds a tombstone for each lane reopened, both in ms and both taken when the person
 * ACTED, not when the file was written: with two windows open, the newer action on a lane wins whichever window made it (PR #227
 * Dexter r2 C; PR #231 Dexter 8). A window's own stamps only ever go up, a tie goes to the close, and a tombstone is forgotten after
 * 30 days (and at most 100 are kept). The version stays 1: the new fields are additive and an older reader ignores them, but a window
 * running code from before them rewrites the file without them, which wipes the tombstones and degrades to "a lane this window
 * reopened is removed, one another window closed stays closed" for as long as the two builds share a project.
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

/** A reopen's tombstone is forgotten after this long: by then every window that could hold the old close has long been restarted. */
const TOMB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The closed lanes a save writes, merged from what one window holds and what is on disk. PURE: nothing is read or written here.
 * The newer action on a lane wins; a tie goes to the close.
 *
 *   mine      this window's closed entries, [{ key, path, branch }]
 *   mineAt    Map key -> when this window closed the lane (or, for a lane it only still holds, when it was closed)
 *   reopens   Map key -> when this window reopened the lane, for the reopens not yet in the file
 *   disk      { closed: [entries], closedAt: Map, reopenedAt: Map } as the file says now
 *   now       the clock, for forgetting old tombstones
 * -> { closed: [{ key, path, branch, at }], reopened: [{ key, at }] }
 */
function mergeClosed({ mine, mineAt, reopens, disk, now }) {
  const tombs = new Map(disk.reopenedAt);
  for (const [k, at] of reopens) tombs.set(k, Math.max(at, tombs.get(k) || 0));
  const candidates = [];      // { c, at }: this window's first (it is the more recent first), then the disk's
  for (const c of mine) candidates.push({ c, at: mineAt.get(c.key) || 0 });
  for (const c of disk.closed) candidates.push({ c, at: disk.closedAt.get(c.key) || 0 });
  const best = new Map();     // key -> the newest close of it that no reopen is newer than
  for (const cand of candidates) {
    const tomb = tombs.get(cand.c.key);
    if (tomb !== undefined && tomb > cand.at) continue;
    const have = best.get(cand.c.key);
    if (!have || cand.at > have.at) best.set(cand.c.key, cand);
  }
  const closed = cleanClosed(candidates.filter(cand => best.get(cand.c.key) === cand).map(cand => cand.c));
  for (const c of closed) tombs.delete(c.key);      // a close at least as new as its tombstone supersedes it
  const cutoff = now - TOMB_TTL_MS;
  const reopened = [...tombs].filter(([, at]) => at >= cutoff).map(([key, at]) => ({ key, at })).sort((x, y) => y.at - x.at).slice(0, MAX_CLOSED);
  return { closed: closed.map(c => ({ ...c, at: best.get(c.key).at })), reopened };
}

function createStripLayout({
  file = null,
  readText = (f) => fs.readFileSync(f, 'utf8'),
  writeText = (f, body) => writeFileAtomic(f, body),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  now = () => Date.now(),
} = {}) {
  let unknown = null;     // why the file can't be written over, once load has seen it
  let last = { order: [], closed: [] };   // what THIS window last loaded or saved: the base the ORDER is merged against
  // What this window holds closed NOW (its view), and since when. Updated by every save CALL, whether or not the write works, so the
  // time of an action is the time it was made and a failed write doesn't move it (PR #231 Dexter 8b).
  let held = new Map();                   // key -> entry
  let heldAt = new Map();                 // key -> when it was closed
  const pendingReopens = new Map();       // key -> when this window reopened it, until a write has carried it
  let clock = 0;                          // the last stamp handed out: a window's own actions only go up, whatever its clock does

  /** `{ order, closed, error }`: read from disk each time it's asked (the shell asks once, at its start). */
  function load() {
    unknown = null;
    last = { order: [], closed: [] };
    held = new Map();
    heldAt = new Map();
    pendingReopens.clear();
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
      const at = parseStamps(body).closedAt;
      held = new Map(l.closed.map(c => [c.key, c]));
      heldAt = new Map(l.closed.map(c => [c.key, at.get(c.key) || 0]));
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
    // The actions this save carries are stamped NOW, at the call: a lane that wasn't held closed and is, was closed; one that was
    // and isn't, was reopened. One stamp per call, and always above this window's last.
    let stampNow = null;
    const at = () => { if (stampNow === null) { stampNow = Math.max(now(), clock + 1); clock = stampNow; } return stampNow; };
    for (const c of mine.closed) if (!held.has(c.key)) { heldAt.set(c.key, at()); pendingReopens.delete(c.key); }
    for (const key of held.keys()) if (!mine.closed.some(c => c.key === key)) { pendingReopens.set(key, at()); heldAt.delete(key); }
    held = new Map(mine.closed.map(c => [c.key, c]));
    try {
      // Other windows of this project write the same file, each from its own memory: merge into what is on disk instead of
      // replacing it (PR #227 Dexter 2); the order is this window's only if this window changed it.
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
      const merged = mergeClosed({
        mine: mine.closed, mineAt: heldAt, reopens: pendingReopens,
        disk: { closed: onDisk.closed, closedAt: diskStamps.closedAt, reopenedAt: diskStamps.reopenedAt }, now: now(),
      });
      // A prune (the shell drops a lane git no longer lists) is not a drag: only keys added, or the keys both lists share in
      // a different order, count as this window changing the order (PR #227 Dexter r2 B).
      const lastKeys = new Set(last.order);
      const shared = mine.order.filter(k => lastKeys.has(k));
      const orderChanged = mine.order.some(k => !lastKeys.has(k)) || JSON.stringify(shared) !== JSON.stringify(last.order.filter(k => mine.order.includes(k)));
      mkdir(path.dirname(file));
      writeText(file, JSON.stringify({ version: VERSION, order: orderChanged ? mine.order : onDisk.order, closed: merged.closed, reopened: merged.reopened }, null, 2) + '\n');
      pendingReopens.clear();     // the file carries them now
      for (const c of merged.closed) if (held.has(c.key)) heldAt.set(c.key, c.at);
      last = mine;
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    return { ok: true };
  }

  return { load, save };
}

module.exports = { createStripLayout, stripLayoutFileFor, parseLayout, mergeClosed, TOMB_TTL_MS, FILE_NAME };
