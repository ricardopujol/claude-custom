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

// What is on disk, or null if it cannot be read or parsed. An unparseable lock
// still has an mtime, and its age is read from that instead: a corrupt lock
// file must not become a permanent tombstone over the vault.
function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;                                   // vanished, or unreadable
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
  let mtime = null;
  try { mtime = fs.statSync(lockPath).mtimeMs; } catch { return parsed; }
  if (parsed === null) return { pid: null, at: mtime };
  return Number.isFinite(parsed.at) ? parsed : { ...parsed, at: mtime };
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
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;        // a real filesystem problem
    }

    // Somebody holds it. Break it only if its holder is gone.
    const held = readLock(lockPath);
    let broke = false;
    if (held === null || isStale(held, now())) {
      try {
        fs.unlinkSync(lockPath);
        broke = true;
      } catch (err) {
        // ENOENT means another waiter removed it first, which is exactly the
        // outcome we wanted and is safe to retry immediately. ANYTHING ELSE
        // means the path is there and cannot be removed, and retrying that at
        // full speed is how this loop used to spin forever.
        broke = err.code === 'ENOENT';
      }
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
    if (now() >= giveUpAt) {
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
