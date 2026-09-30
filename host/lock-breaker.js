'use strict';
/**
 * Breaking a stale lock file, one breaker at a time.
 *
 * WHY THIS EXISTS. host/file-lock.js shipped (PR #57) with three accepted
 * residuals from Dexter's re-review, all inside the stale-lock BREAK:
 *   - the three-waiter window: W1 moves a live lock aside by mistake while W2
 *     races its put-back;
 *   - Finding A: an empty lock whose stat failed was broken at once, though
 *     empty is exactly what a lock looks like in the instant after `wx`;
 *   - Finding B: a holder that released while its lock sat in a waiter's tomb
 *     came back as an orphan -- a lock nobody held, naming a live pid.
 * Each needs two breakers inside the break at the same time (backlog #22). The
 * session lock (host/session-lock.js, Extension X1) breaks the same way, and
 * there a wrong break means two `claude`s in one worktree for days, not one
 * lost write.
 *
 * THE MECHANISM. Breakers take `<lock>.break` with `wx` first, so only one is
 * ever inside. Under it they re-read the lock, ask the caller's judge, and
 * remove only the very file that was judged (rename it aside, compare, delete
 * it -- or put it back if something else was there). Taking the lock itself is
 * still a plain `wx` by the caller; `.break` only guards the removal.
 *
 * `.break` can itself be left behind by a breaker that died. It is cleared
 * when its pid is dead, or when it is older than BREAK_STALE_MS (a break takes
 * milliseconds). The one residual: a breaker that STALLS for BREAK_STALE_MS
 * inside the break can have its `.break` cleared under it, and then two
 * breakers overlap -- which is still safe for removal, because removal is
 * identity-checked, and at worst puts a live lock back.
 */

const fs = require('fs');
const crypto = require('crypto');
const { isAlive } = require('./proc-start');

// How long a `.break` may sit before its holder is presumed gone. A break is a
// read, a stat, a judge and a rename; ten seconds is three orders of magnitude
// more than that.
const BREAK_STALE_MS = 10000;
// How long a caller waits for another breaker to finish before reporting busy.
const BREAK_WAIT_MS = 1000;
const RETRY_MS = 15;

/**
 * Sleep without spinning, in a synchronous function. `Atomics.wait` blocks the
 * thread rather than burning a core -- the host that calls this owns the pty.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * What is on disk at `lockPath`. One of:
 *   { gone: true }          it isn't there
 *   { unreadable: true }    it is there and couldn't be read (a scanner's
 *                           sharing violation looks exactly like this, so it
 *                           is never judged)
 *   { raw, st, parsed }     the bytes, the stat (null if it failed) and the
 *                           content as an object (null if it isn't one)
 * Read BEFORE stat, always: a file replaced in between then differs from the
 * judged one in its inode, and the removal refuses it.
 */
function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? { gone: true } : { unreadable: true };
  }
  let parsed = null;
  try {
    const candidate = JSON.parse(raw);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate;
  } catch { /* not JSON, or caught mid-write */ }
  let st = null;
  try { st = fs.statSync(lockPath); } catch { /* compared on bytes alone */ }
  return { raw, st, parsed };
}

// Is the file now in hand the one that was judged? Same bytes, and -- where
// both stats are known -- the same file on disk.
function sameFile(judged, raw, st) {
  if (raw !== judged.raw) return false;
  if (!judged.st || !st) return true;
  return st.ino === judged.st.ino && st.size === judged.st.size && st.mtimeMs === judged.st.mtimeMs;
}

/**
 * Remove the file at `filePath` only if it is still the one that was judged.
 * True when the path is now free (removed, or already gone), false when it
 * still holds something else.
 *
 * `renameSync` to a name nobody else uses takes exactly one file, whichever sat
 * at the path at that instant; only then is it checked. The wrong file goes
 * straight back with a create-or-fail link, which can never overwrite a lock
 * taken in between. (Moved here from file-lock.js's breakStale, PR #57 F1.)
 */
function removeIfSame(filePath, judged) {
  const tomb = `${filePath}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(filePath, tomb);
  } catch (err) {
    // ENOENT: it's already gone, which is what we wanted. Anything else: the
    // path is there and won't move -- not free.
    return err.code === 'ENOENT';
  }

  let raw = null;
  let st = null;
  try { raw = fs.readFileSync(tomb, 'utf8'); } catch { /* compared as a mismatch */ }
  try { st = fs.statSync(tomb); } catch { /* compared on bytes alone */ }

  if (raw !== null && sameFile(judged, raw, st)) {
    try { fs.unlinkSync(tomb); } catch { /* litter at worst; the path is free */ }
    return true;
  }

  try {
    fs.linkSync(tomb, filePath);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      // No hard links on this volume (FAT, some shares): copy, still exclusive.
      try { fs.copyFileSync(tomb, filePath, fs.constants.COPYFILE_EXCL); } catch { /* see above */ }
    }
  }
  try { fs.unlinkSync(tomb); } catch { /* litter at worst */ }
  return false;
}

// A `.break` whose breaker is gone: dead pid, or older than any break could
// take. An unreadable-content `.break` is aged by its mtime, so a breaker that
// died between `wx` and its write doesn't leave a permanent tombstone.
function breakIsStale(seen) {
  const p = seen.parsed;
  const at = p && Number.isFinite(p.at) ? p.at : (seen.st ? seen.st.mtimeMs : null);
  if (at !== null && Date.now() - at > BREAK_STALE_MS) return true;
  return Boolean(p) && isAlive(p.pid) === false;
}

// Take `.break`. Returns the exact bytes written (to recognise it on release),
// or null when another breaker still holds it after `waitMs`.
function takeBreak(breakPath, waitMs) {
  const mine = JSON.stringify({ pid: process.pid, at: Date.now(), id: crypto.randomBytes(6).toString('hex') });
  const giveUpAt = Date.now() + waitMs;
  let extraTryAfterClear = false;
  for (;;) {
    try {
      const fd = fs.openSync(breakPath, 'wx');
      let written = mine;
      try { fs.writeSync(fd, mine); } catch { written = ''; }
      try { fs.closeSync(fd); } catch { /* already closed */ }
      return written;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const seen = readLock(breakPath);
    const cleared = seen.gone ||
      (!seen.unreadable && breakIsStale(seen) && removeIfSame(breakPath, seen));

    // Every path reaches the deadline check (file-lock.js, Mortimer PR #29): a
    // `.break` re-staled as fast as it is cleared must not loop forever. A
    // clear earns one more open, as a break does there.
    if (Date.now() >= giveUpAt) {
      if (cleared && !extraTryAfterClear) { extraTryAfterClear = true; continue; }
      return null;
    }
    if (!cleared) sleepSync(RETRY_MS);
  }
}

// Release `.break` only if it is still the one we wrote.
function releaseBreak(breakPath, mine) {
  const seen = readLock(breakPath);
  if (seen.raw === mine) removeIfSame(breakPath, seen);
}

/**
 * Remove the lock at `lockPath` if `judge` calls it stale, with no other
 * breaker inside at the same time.
 *
 * `judge(seen)` gets `{ raw, st, parsed }` and must return exactly 'stale' to
 * break it; 'live', 'unknown' or anything else keeps it.
 *
 * Returns `{ outcome, seen }`:
 *   'freed'   the path is free now (removed, or already gone)
 *   'held'    the lock stays (live, unknown, unreadable, or replaced meanwhile)
 *   'busy'    another breaker held `.break` for all of `opts.breakWaitMs`
 */
function breakIfStale(lockPath, judge, opts = {}) {
  const waitMs = Number.isFinite(opts.breakWaitMs) ? opts.breakWaitMs : BREAK_WAIT_MS;
  const breakPath = `${lockPath}.break`;
  const mine = takeBreak(breakPath, waitMs);
  if (mine === null) return { outcome: 'busy', seen: null };
  try {
    const seen = readLock(lockPath);
    if (seen.gone) return { outcome: 'freed', seen };
    if (seen.unreadable) return { outcome: 'held', seen };
    if (judge(seen) !== 'stale') return { outcome: 'held', seen };
    return { outcome: removeIfSame(lockPath, seen) ? 'freed' : 'held', seen };
  } finally {
    releaseBreak(breakPath, mine);
  }
}

module.exports = { breakIfStale, readLock, removeIfSame, sameFile, sleepSync, BREAK_STALE_MS, BREAK_WAIT_MS };
