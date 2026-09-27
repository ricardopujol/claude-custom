'use strict';
/**
 * A cross-process mutex for one file.
 *
 * WHY THIS EXISTS. `host/store.js` does read-modify-write, which is atomic
 * within a process and not across processes. Its own header has said so since
 * the multi-project change landed, and deferred it deliberately: everything in
 * that store was regenerable convenience state, so two hosts racing a counter
 * cost an off-by-one nobody would notice.
 *
 * The bug vault changed the premise. It is the first consumer holding records
 * a user CANNOT reconstruct -- a lost seat is a preference you re-add in two
 * seconds, a lost bug record is evidence typed once and never retyped. And
 * `.harness/state` is install-wide, so the race is not "two windows on one
 * project"; it is every pair of open windows, across every project. Accepting
 * install-wide scope (which the seed data settles) makes this MORE frequent,
 * not less.
 *
 * THE MECHANISM IS ONE LINE: `fs.openSync(path, 'wx')` is an atomic
 * create-or-fail on both Windows and POSIX. If it succeeds, the lock is ours.
 * Everything else in this file is about not deadlocking forever when a holder
 * dies without cleaning up.
 *
 * FAIL CLOSED. If the lock cannot be taken before the deadline, this throws
 * and the work does not run. Proceeding unlocked would be precisely the lost
 * update the module exists to prevent -- a race that "usually works" is worse
 * than a refusal, because the refusal is visible.
 *
 * SCOPE, DELIBERATELY NARROW. `store.update()` is NOT routed through this.
 * Making it lock would turn a silent lost update into a thrown error on a hot
 * path for cooldowns and every other consumer, which contradicts store.js's
 * own rule that one feature's state must never take the session down. The
 * consumers whose data cannot be regenerated opt in; the rest keep the old
 * behaviour and the old, documented, accepted risk.
 */

const fs = require('fs');
const crypto = require('crypto');

// How long a lock may sit before its holder is presumed gone. Generously
// longer than any write this codebase performs -- a serialize plus a
// write-and-rename is single-digit milliseconds -- because breaking a LIVE
// lock reintroduces the race, while waiting too long merely delays a click.
const STALE_MS = 10000;

// How long a caller waits before giving up. Bounded on WALL CLOCK rather than
// on a number of attempts: a retry count cannot tell you how long it blocked
// the person who clicked. Well under STALE_MS, or the waiting branch below
// could never be reached.
const DEADLINE_MS = 3000;

// Gap between attempts. Short enough that the common case (a competing write
// finishing) is invisible, long enough not to spin.
const RETRY_MS = 15;

/**
 * Sleep without spinning, in a synchronous function.
 *
 * `store.write` is synchronous and so is the whole vault API above it, so this
 * cannot be async without rewriting both. `Atomics.wait` blocks the thread
 * properly rather than burning a core in a `while (Date.now() < end)` loop,
 * which is what a busy-wait would do to the host process that also owns the
 * pty.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is this lock's holder gone?
 *
 * Two independent reasons, because neither alone is sufficient. A pid can be
 * dead while the lock is fresh (a crash), and a pid can be alive while the
 * lock is ancient (pid reuse, or a hung holder).
 *
 * THE PID IS NOT TRUSTED. It is whatever was in a file on disk, and
 * `process.kill(0, 0)` addresses the caller's entire PROCESS GROUP while
 * `kill(-1, 0)` addresses every process the user can signal. Anything that is
 * not a positive integer is NEVER PROBED -- and, crucially, is not treated as
 * dead either. The same input class was caught in readIdentity on PR #31.
 */
function isStale(lock, now) {
  // AGE FIRST, and it is the only reason that can stand alone. A lock older
  // than any write could possibly take is presumed abandoned whatever it
  // claims about its holder.
  const at = lock && lock.at;
  const ageKnown = Number.isFinite(at);
  if (ageKnown && now - at > STALE_MS) return true;

  const pid = lock && lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    // NOT STALE. The pid is unusable, so the holder cannot be probed -- and
    // "cannot prove it is dead" must not mean "assume it is dead".
    //
    // The first version of this function returned true here, and the
    // concurrent test caught it losing records with the lock in place:
    // `openSync(path, 'wx')` CREATES THE FILE EMPTY and writes the pid a
    // moment later, so a competitor reading in that window gets no usable pid
    // and broke a live lock instantly. The unit test that pinned the old rule
    // was pinning the bug.
    //
    // Refusing to break it is the fail-closed direction: at worst the caller
    // waits out its deadline and reports a refusal, which is visible. Breaking
    // it loses a record silently, which is not.
    return false;
  }

  try {
    process.kill(pid, 0);                          // signal 0 tests existence only
    return false;
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists and belongs to someone else,
    // which means it is very much alive -- breaking that lock would be wrong.
    return err.code === 'ESRCH';
  }
}

// What is on disk. One of:
//   { gone: true }        -- it vanished between our open and our read
//   { unreadable: true }  -- it is there and could not be read
//   { lock, identity }    -- `lock` is what isStale judges (null when nothing
//                            usable could be learned, which is breakable);
//                            `identity` is what breakStale later checks, so a
//                            break can only ever remove THIS file.
// An unparseable lock still has an mtime, and its age is read from that
// instead: a corrupt lock file must not become a permanent tombstone.
function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    // Unreadable is NOT "nothing to judge, so break it". Dexter, PR #57 F1: a
    // waiter may only delete the exact file it judged stale, and it judged
    // nothing here -- a scanner's sharing violation on a LIVE lock looks
    // exactly like this. Fail closed: wait, and refuse at the deadline.
    return err.code === 'ENOENT' ? { gone: true } : { unreadable: true };
  }
  let parsed = null;
  try {
    const candidate = JSON.parse(raw);
    if (candidate && typeof candidate === 'object') parsed = candidate;
  } catch { /* not JSON, or written only partially -- mtime decides below */ }

  // An age ALWAYS comes back, from the file itself when the contents do not
  // carry a usable one. Without this a lock holding `{}` -- or caught in the
  // instant between its creation and its first write -- would have no age, and
  // isStale would never break it: a permanent tombstone over the vault.
  let st = null;
  try { st = fs.statSync(lockPath); } catch { /* age unknown, see below */ }
  const identity = { raw, st };
  if (st === null) return { lock: parsed, identity };
  if (parsed === null) return { lock: { pid: null, at: st.mtimeMs }, identity };
  return { lock: Number.isFinite(parsed.at) ? parsed : { ...parsed, at: st.mtimeMs }, identity };
}

// Is the file now in hand the one that was judged? Same bytes, and -- where
// both stats are known -- the same file on disk. A fresh lock written in the
// gap differs in its pid or its time, and in its inode and mtime besides.
function sameFile(judged, raw, st) {
  if (raw !== judged.raw) return false;
  if (!judged.st || !st) return true;
  return st.ino === judged.st.ino && st.size === judged.st.size && st.mtimeMs === judged.st.mtimeMs;
}

/**
 * Remove the lock at `lockPath` only if it is still the file that was judged
 * stale. Returns true when the path is now free (we removed it, or somebody
 * else already had), false when it is still held or could not be removed.
 *
 * WHY NOT unlinkSync(lockPath). Dexter, PR #57 review, F1 (High): unlink by
 * path deletes whatever is there NOW. Two waiters judge the same dead lock L0;
 * W1 removes it and takes a fresh L1; W2's late unlink removes L1, W2 takes
 * the lock, and both run fn -- a silently lost record, the exact failure this
 * module exists to prevent.
 *
 * `renameSync` to a name nobody else uses is atomic: it takes exactly one
 * file, whichever sits at the path at that instant. Only then is it checked.
 * If it is the judged file, deleting it is safe -- nobody can be holding it.
 * If not, it is somebody's live lock, and it goes straight back with a
 * create-or-fail link, which can never overwrite a lock taken in between.
 */
function breakStale(lockPath, judged) {
  const tomb = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockPath, tomb);
  } catch (err) {
    // ENOENT: another waiter already removed it -- the outcome we wanted, safe
    // to retry at once. ANYTHING ELSE means the path is there and will not
    // move, and retrying that at full speed is how this loop once spun forever.
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

  // Not what we judged: a live holder's lock. Put it back, create-or-fail.
  // If a third waiter took the empty path in the instant it was away, there
  // is nothing safe left to do -- overwriting would hand the lock to a third
  // holder -- so the tomb is simply dropped. That needs two races to coincide
  // inside a window of a rename and a read, where unlink-by-path needed one.
  try {
    fs.linkSync(tomb, lockPath);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      // No hard links on this volume (FAT, some network shares): copy, still
      // exclusive, so it too can only fill an empty path.
      try { fs.copyFileSync(tomb, lockPath, fs.constants.COPYFILE_EXCL); } catch { /* see above */ }
    }
  }
  try { fs.unlinkSync(tomb); } catch { /* litter at worst */ }
  return false;
}

/**
 * Run `fn` holding an exclusive lock on `lockPath`. Returns fn's value.
 * Throws if the lock could not be taken, and always releases.
 */
function withFileLock(lockPath, fn, opts = {}) {
  const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEADLINE_MS;
  const now = opts.now || Date.now;
  const giveUpAt = now() + deadlineMs;

  let fd = null;
  let lastTry = false;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;        // a real filesystem problem
    }

    // Somebody holds it. Break it only if its holder is gone -- and break
    // only the very file that was judged (breakStale).
    const seen = readLock(lockPath);
    const held = seen.lock || null;
    let broke = false;
    if (seen.gone) {
      broke = true;                                // already free; retry at once
    } else if (!seen.unreadable && (held === null || isStale(held, now()))) {
      broke = breakStale(lockPath, seen.identity);
    }

    // EVERY PATH REACHES HERE. Mortimer, PR #29 mutation gate: the breaking
    // branch used to end in `continue`, which jumped this check. A lock path
    // that could be neither read nor deleted -- a directory, or a file another
    // process holds open without share-delete, which an antivirus scanner or a
    // crashed host routinely does on Windows -- looped forever. `sleepSync`
    // uses Atomics.wait, so the thread blocks; the host owns the pty; the
    // Claude session dies with it. A hang is strictly worse than the throw
    // Dexter F2 closed, and this module's own header promises the opposite in
    // capitals.
    //
    // BUT A BREAK EARNS ONE MORE OPEN, deadline or not. Checking the clock
    // between freeing a stale lock and re-opening it threw away a lock we had
    // just recovered whenever one slow pass (read, stat, pid probe, unlink)
    // outlasted the deadline -- the full-suite flake of 2026-09-26/27, and a
    // refused record in production on any host slow enough. Exactly one:
    // `lastTry` keeps a path that is re-staled as fast as we clear it from
    // looping past the deadline.
    if (now() >= giveUpAt) {
      if (broke && !lastTry) { lastTry = true; continue; }
      throw new Error(
        `could not take the lock on ${lockPath} within ${deadlineMs}ms` +
        `${held && held.pid ? ` (held by pid ${held.pid})` : ''}; nothing was written`);
    }

    // No wait after a successful break -- the lock is free and the next open
    // should win it. Waiting only makes sense when somebody else still holds
    // it, or when the path itself refuses to go away.
    if (!broke) sleepSync(RETRY_MS);
  }

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
  } catch { /* the lock is held either way; its contents are only a hint */ }
  try { fs.closeSync(fd); } catch { /* already closed */ }

  try {
    return fn();
  } finally {
    // Released even when fn throws. A leaked lock is a vault that refuses
    // every write for STALE_MS, which reads to the user as the feature being
    // broken.
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

module.exports = { withFileLock, isStale, STALE_MS, DEADLINE_MS, RETRY_MS };
