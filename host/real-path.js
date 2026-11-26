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
 *     `real\new` still agree. The climb goes up ONLY on ENOENT / ENOTDIR
 *     ("not there"). Any other error ("cannot reach", a timeout, access
 *     denied) returns the input as given at once: one blocking call, never
 *     one per level (Dexter 4 / Miguel 3, PR #257).
 *   - Never throws. Anything the disk will not answer leaves the path as
 *     given, which is exactly the behaviour before this module.
 *   - NETWORK PATHS ARE RETURNED AS GIVEN, so their key never depends on
 *     whether the network is up, and an offline share (~20 s per call,
 *     port-blocks.js, Dexter PR #71 F3) never blocks the UI's hot paths:
 *       - UNC and `\\?\` paths: by their spelling, no disk call.
 *       - Drive letters: each letter is asked ONCE per process, by the
 *         realpath of its root. Only a root that answers with a local path
 *         (not `\\...`) makes the letter "local". A mapped network drive
 *         answers `\\server\share\`, an offline one or a missing letter
 *         answers an error: both are "not local" for the rest of the process.
 *         So an offline mapped drive costs one blocking call per process, not
 *         one per path or per 30 s. Asking Windows for the drive type
 *         (GetDriveType, `net use`) needs a native addon or a child process;
 *         the root's realpath is the cheap answer in plain Node.
 *
 * Cost (measured 2026-11-25 on Raider, 3 runs): uncached ~110-125 us per call
 * for a path that exists, ~155 us for one that does not (the climb); a cache
 * hit ~0.9 us, the same as the old string-only key. The occupancy readers call
 * this once per file path in a transcript tail, so the cache is what keeps
 * them cheap. An entry answers for CACHE_MS, so a junction made or moved while
 * the app runs is seen within that long; an entry from the "future" (the clock
 * went back) is a miss, never a longer life (Dexter 6). The cache is cleared
 * whole at CACHE_MAX entries.
 */

const fs = require('fs');
const path = require('path');

const CACHE_MS = 30_000;
const CACHE_MAX = 4000;
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);
const isUnc = (p) => /^[\\/]{2}/.test(p);

// `realpath` is the seam the unit tests use (an offline drive cannot be made in a test).
function createRealPath({ realpath = fs.realpathSync.native, cacheMs = CACHE_MS, cacheMax = CACHE_MAX } = {}) {
  const cache = new Map();    // resolved input -> { out, at }
  const drives = new Map();   // 'C' -> true (local) | false (network, offline, missing)

  function driveIsLocal(resolved) {
    const m = /^([a-z]):/i.exec(resolved);
    if (!m) return true;                                // not a drive path (POSIX): nothing to ask
    const letter = m[1].toUpperCase();
    if (drives.has(letter)) return drives.get(letter);
    let local = false;
    try {
      const root = realpath(`${letter}:\\`);
      local = typeof root === 'string' && root !== '' && !isUnc(root);
    } catch { /* offline, missing, or refused: not local */ }
    drives.set(letter, local);
    return local;
  }

  function walk(resolved) {
    const rest = [];
    let cur = resolved;
    for (;;) {
      try {
        const real = realpath(cur);
        if (typeof real !== 'string' || real === '') return resolved;
        return rest.length ? path.join(real, ...rest.reverse()) : real;
      } catch (err) {
        if (!err || !NOT_THERE.has(err.code)) return resolved;   // cannot reach: never climb
        const parent = path.dirname(cur);
        if (parent === cur) return resolved;            // not even the root answered
        rest.push(path.basename(cur));
        cur = parent;
      }
    }
  }

  function realPathLoose(resolved, now = Date.now()) {
    if (typeof resolved !== 'string' || resolved === '') return resolved;
    if (isUnc(resolved)) return resolved;
    const hit = cache.get(resolved);
    if (hit) {
      const age = now - hit.at;
      if (age >= 0 && age < cacheMs) return hit.out;
    }
    const out = driveIsLocal(resolved) ? walk(resolved) : resolved;
    if (cache.size >= cacheMax) cache.clear();
    cache.set(resolved, { out, at: now });
    return out;
  }

  function clear() {
    cache.clear();
    drives.clear();
  }

  return { realPathLoose, clear, cacheSize: () => cache.size };
}

const shared = createRealPath();

module.exports = {
  realPathLoose: shared.realPathLoose,
  clearRealPathCache: shared.clear,
  createRealPath,
  CACHE_MS,
  CACHE_MAX,
};
