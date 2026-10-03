'use strict';
/**
 * The Files tab's overlay (#45): host/fog.js's read / edited data, rolled up so a folder can say what is
 * under it.
 *
 *   rollUp(fogFiles) -> { files: [{ path, tier, edits }], dirs: [{ path, edits, edited, read }] }
 *
 * files  one row per touched path: tier 'edited' (Claude wrote it) or 'read'. `edits` is Claude's Edit /
 *        Write calls on it (the `●N`); 0 for a read-only file. DARK files (never touched) and anything of
 *        an unknown tier are not part of the overlay: the tree lists the repo, this says what Claude did.
 * dirs   one row per folder that has a touched file anywhere under it, the root as ''. `edits` is the SUM
 *        of its files' edits, `edited` how many of them were edited, `read` how many were only read.
 *
 * Arrays, not objects keyed by path: a file may be named `__proto__` or `constructor`, and an object keyed
 * by it would be the wrong object. (The page builds its own Map.)
 *
 * An edited file with no usable count is ONE edit, never zero: the tier says an edit happened, and a zero
 * badge on an edited file is the absence-reported-as-zero this project keeps catching.
 */

const posix = require('path').posix;

const TIER_EDITED = 'edited';
const TIER_READ = 'read';

/** ['', 'a', 'a/b'] for 'a/b/c.js': every folder above a file, outermost first, the root included. */
function ancestorsOf(p) {
  const parts = String(p).split('/');
  const out = [''];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

function editsOf(entry) {
  const n = entry.edits;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// A path as the listing writes one: forward slashes, no `.` or `..` segments. null for what is no file of this
// worktree (it climbs out, is absolute, or is nothing).
function cleanPath(p) {
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n === '.' || n === '..' || n.startsWith('../') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  return n.replace(/^(\.\/)+/, '');
}

// `resolve(path)` is the listing's word on a file (host/repo-index.js): its own spelling (a string), null for
// "not listed", undefined for "can't say". Windows paths are case-insensitive and a transcript spells them any
// way, so two spellings of one file are ONE row (PR #95 Dexter D3): the listing's spelling when it has one,
// else the first seen.
function rollUp(fogFiles, { resolve } = {}) {
  if (!Array.isArray(fogFiles)) return { files: [], dirs: [] };
  const files = new Map();
  for (const e of fogFiles) {
    if (!e || typeof e.path !== 'string' || e.path === '') continue;
    if (e.tier !== TIER_EDITED && e.tier !== TIER_READ) continue;
    const p = cleanPath(e.path);
    if (p === null) continue;
    const edits = e.tier === TIER_EDITED ? editsOf(e) : 0;
    const key = p.toLowerCase();
    const listed = typeof resolve === 'function' ? resolve(p) : undefined;
    const cur = files.get(key);
    if (!cur) { files.set(key, { path: typeof listed === 'string' ? listed : p, tier: e.tier, edits, listed: typeof listed === 'string' }); continue; }
    cur.edits += edits;
    if (e.tier === TIER_EDITED) cur.tier = TIER_EDITED;
  }

  // FOLDERS ARE CASE-INSENSITIVE TOO: `A/b.js` and `a/c.js` sit in one folder. One spelling per folder, the
  // listing's first (a listed file spells its folders the way the tree does), then the first seen.
  const spelling = new Map();
  const ordered = [...files.values()].sort((a, b) => Number(b.listed) - Number(a.listed));
  for (const f of ordered) {
    const parts = f.path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts.slice(0, i + 1).join('/').toLowerCase();
      if (!spelling.has(k)) spelling.set(k, parts[i]);
    }
    f.path = parts.map((part, i) => (i < parts.length - 1 ? spelling.get(parts.slice(0, i + 1).join('/').toLowerCase()) : part)).join('/');
  }
  for (const f of files.values()) delete f.listed;

  const dirs = new Map();
  for (const f of files.values()) {
    for (const d of ancestorsOf(f.path)) {
      let row = dirs.get(d);
      if (!row) { row = { path: d, edits: 0, edited: 0, read: 0 }; dirs.set(d, row); }
      row.edits += f.edits;
      if (f.tier === TIER_EDITED) row.edited += 1; else row.read += 1;
    }
  }
  return { files: [...files.values()], dirs: [...dirs.values()] };
}

module.exports = { rollUp, ancestorsOf };
