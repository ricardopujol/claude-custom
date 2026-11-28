'use strict';
/**
 * Jiandu Home's disk facts per path, off the hot path (PR #263 Miguel Y2). A Home sync runs on Electron main at every window event and
 * strip push, and the record and the model ask projectOf (a statSync climb) and exists for every path in every list pass. So:
 *
 *   createHomePaths({ projectOf, exists }) -> { projectOf(p), exists(p), clear() }
 *     Each path asks the disk once; the answer is kept until clear(). Main clears when the source lists change (a refresh that read
 *     different recents or windowless sessions, or a forced one: Home shown). A throw is kept as its answer (null / false).
 *     A UNC or \\?\ path (isRemote) never asks the disk: projectOf null (a path it cannot place is its own root) and exists true (shown;
 *     the open path says when it is gone). An offline share would otherwise be an SMB timeout on main, per path, per sync.
 *     At most MAX paths are kept; past that the cache starts again.
 *
 * Main-process only (required, never a page <script>).
 */

const MAX = 2000;

const isRemote = (p) => typeof p === 'string' && /^[\\/]{2}/.test(p);

function createHomePaths({ projectOf, exists }) {
  let places = new Map();
  let there = new Map();

  const keep = (map, p, value) => { if (map.size >= MAX) map.clear(); map.set(p, value); return value; };

  function placeOf(p) {
    if (isRemote(p)) return null;
    if (places.has(p)) return places.get(p);
    let v = null;
    try { v = projectOf(p); } catch { v = null; }
    return keep(places, p, v === undefined ? null : v);
  }

  function isThere(p) {
    if (isRemote(p)) return true;
    if (there.has(p)) return there.get(p);
    let v = false;
    try { v = exists(p) === true; } catch { v = false; }
    return keep(there, p, v);
  }

  function clear() { places = new Map(); there = new Map(); }

  return { projectOf: placeOf, exists: isThere, clear };
}

module.exports = { createHomePaths, isRemote, MAX };
