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
const { breakIfStale, sleepSync, BREAK_WAIT_MS } = require('./lock-breaker');

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

// `store.write` is synchronous and so is the whole vault API above it, so the
// waiting here is too: host/lock-breaker.js's sleepSync blocks the thread with
// Atomics.wait rather than burning a core in the process that owns the pty.

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

/**
 * The verdict host/lock-breaker.js asks for, from what it read off disk
 * (`{ raw, st, parsed }`). Breaking, reading and the removal of exactly the
 * judged file live there now (backlog #22); what counts as stale is this
 * module's own business and stays here.
 *
 * An age ALWAYS comes back when the file has one, from the file itself when the
 * contents don't carry a usable one. Without that a lock holding `{}` would
 * have no age and isStale would never break it: a permanent tombstone over the
 * vault. A corrupt lock file is aged by its mtime the same way.
 */
function judge(seen) {
  const { raw, st, parsed } = seen;
  if (st === null && parsed === null) {
    // Nothing usable in it and no age to read. Content that is there and isn't
    // a lock is broken rather than left as a tombstone (Mortimer's second
    // correction). But an EMPTY file is what a live lock looks like between
    // its `wx` and its write, so it tells us nothing about the holder: wait,
    // and refuse at the deadline (Dexter, PR #57 re-review, Finding A).
    return raw === '' ? 'unknown' : 'stale';
  }
  let lock = parsed;
  if (parsed === null) lock = { pid: null, at: st.mtimeMs };
  else if (st !== null && !Number.isFinite(parsed.at)) lock = { ...parsed, at: st.mtimeMs };
  return isStale(lock, Date.now()) ? 'stale' : 'live';
}

/**
 * Run `fn` holding an exclusive lock on `lockPath`. Returns fn's value.
 * Throws if the lock could not be taken, and always releases.
 */
function withFileLock(lockPath, fn, opts = {}) {
  const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEADLINE_MS;
  // `now` times THIS caller's deadline and nothing else. A lock's age -- the
  // `at` we write and the one isStale judges -- is read by OTHER processes
  // against their own clocks, so it is always wall clock (Dexter, PR #57 F2):
  // an injected monotonic clock written into the file would make every
  // competitor judge a live lock decades stale.
  const now = opts.now || Date.now;
  const giveUpAt = now() + deadlineMs;

  let fd = null;
  let extraTryAfterBreak = false;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;        // a real filesystem problem
    }

    // Somebody holds it. Break it only if its holder is gone, only one breaker
    // at a time, and only the very file that was judged (lock-breaker.js).
    // The break waits at most this caller's whole deadline for another
    // breaker -- never the remaining time, which would take another read of
    // the injected clock.
    const { outcome, seen } = breakIfStale(lockPath, judge,
      { breakWaitMs: Math.min(BREAK_WAIT_MS, deadlineMs) });
    const held = (seen && seen.parsed) || null;
    const broke = outcome === 'freed';            // free now; retry at once

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
    // `extraTryAfterBreak` keeps a path that is re-staled as fast as we clear
    // it from looping past the deadline.
    if (now() >= giveUpAt) {
      if (broke && !extraTryAfterBreak) { extraTryAfterBreak = true; continue; }
      throw new Error(
        `could not take the lock on ${lockPath} within ${deadlineMs}ms` +
        `${extraTryAfterBreak ? ' and one more attempt after breaking a stale lock' : ''}` +
        `${held && held.pid ? ` (held by pid ${held.pid})` : ''}; nothing was written`);
    }

    // No wait after a successful break -- the lock is free and the next open
    // should win it. Waiting only makes sense when somebody else still holds
    // it, or when the path itself refuses to go away.
    if (!broke) sleepSync(RETRY_MS);
  }

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
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
