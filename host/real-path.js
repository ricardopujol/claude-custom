'use strict';
/**
 * The folder a path really names, for COMPARING paths -- never for showing one,
 * starting a process in one, or naming a Claude transcript folder.
 *
 * Why (lane fix/junction-paths, 2026-11-25): on Raider `C:\Users\ricar` is a
 * directory junction to `C:\Users\Ricardo Pujol`. git follows it and prints the
 * real path in `git worktree list`; a project opened through the junction then
 * matched none of its own worktrees, and the strip said "No worktrees yet."
 * String arithmetic (`path.resolve`) cannot see a junction; the disk can.
 *
 * Rules:
 *   - Input is an absolute, already `path.resolve`d path. Output is the same
 *     path with every junction / symlink along it followed, in the case the
 *     disk stores (callers still lowercase on Windows).
 *   - A path that does not exist (yet, or any more) resolves its deepest
 *     existing ancestor and appends the rest as given, so `link\new` and
 *     `real\new` still agree.
 *   - Never throws. Anything the disk will not answer leaves that part as
 *     given, which is exactly the behaviour before this module.
 *   - UNC paths (`\\server\share\...`) are returned as given, untouched: an
 *     offline share can hold a filesystem call for ~20 s (port-blocks.js,
 *     Dexter PR #71 F3), and these helpers run on the UI's hot paths.
 *
 * Cost (measured 2026-11-25 on Raider, 3 runs): uncached ~110-125 us per call
 * for a path that exists, ~155 us for one that does not (the climb); a cache
 * hit ~0.9 us, the same as the old string-only key. The occupancy readers call
 * this once per file path in a transcript tail, so the cache is what keeps
 * them cheap. It answers for CACHE_MS, so a junction made or moved while the
 * app runs is seen within that long; it is cleared whole at CACHE_MAX entries.
 */

const fs = require('fs');
const path = require('path');

const CACHE_MS = 30_000;
const CACHE_MAX = 4000;
const cache = new Map();   // resolved input -> { out, at }

function walk(resolved) {
  const rest = [];
  let cur = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return resolved;            // not even the root answered
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function realPathLoose(resolved, now = Date.now()) {
  if (typeof resolved !== 'string' || resolved === '') return resolved;
  if (/^[\\/]{2}/.test(resolved)) return resolved;     // UNC or \\?\ -- see the header
  const hit = cache.get(resolved);
  if (hit && now - hit.at < CACHE_MS) return hit.out;
  const out = walk(resolved);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(resolved, { out, at: now });
  return out;
}

function clearRealPathCache() {
  cache.clear();
}

module.exports = { realPathLoose, clearRealPathCache, CACHE_MS };
