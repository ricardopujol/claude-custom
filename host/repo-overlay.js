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

function rollUp(fogFiles) {
  if (!Array.isArray(fogFiles)) return { files: [], dirs: [] };
  const files = new Map();
  for (const e of fogFiles) {
    if (!e || typeof e.path !== 'string' || e.path === '') continue;
    if (e.tier !== TIER_EDITED && e.tier !== TIER_READ) continue;
    const edits = e.tier === TIER_EDITED ? editsOf(e) : 0;
    const cur = files.get(e.path);
    if (!cur) { files.set(e.path, { path: e.path, tier: e.tier, edits }); continue; }
    cur.edits += edits;
    if (e.tier === TIER_EDITED) cur.tier = TIER_EDITED;
  }

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
