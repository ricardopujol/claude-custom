'use strict';
/**
 * One live `claude` per worktree, across every window and host (Extension X1,
 * documentation/PLAN_WORKTREE_TABS.md, confirmed by Ricardo 2026-09-29).
 *
 * THE LOCK. `<git-dir>/claude-session.lock`, beside the merged marker:
 * `dev\.git\` for dev, `dev\.git\worktrees\<name>\` for a sibling worktree,
 * `.git\` for a flat repo -- git's own per-worktree directory, so it never
 * shows up in `git status` and dies with the worktree. Contents:
 *   {pid, processStartedAt, startedAt, port, claudePid}
 * `pid` is the HOST, not `claude`: the host owns the pty and dies with it, so a
 * crashed or killed host leaves a lock whose pid is dead. `port` and
 * `claudePid` are for whoever is blocked by it -- who holds it, and where.
 *
 * STALE means the holder is gone: its pid is dead, or alive with another start
 * time (Windows reuses pids; host/proc-start.js reads the OS start time, and
 * verify/probe-session-registry.js measured it exact). There is deliberately
 * NO AGE RULE: a session lasts days, so "old" says nothing, and a wrong break
 * is a second `claude` in the worktree. Anything this module can't prove dead
 * is live -- the person gets a blocked window with *Open anyway*, which is
 * visible, rather than two sessions, which isn't.
 *
 * Taking it is a plain `wx`. Breaking a stale one goes through
 * host/lock-breaker.js (one breaker at a time, only the judged file). The
 * judge here is async -- it asks the OS -- so the breaker is handed a verdict
 * bound to the exact file it was reached on: if the file changed meanwhile,
 * the verdict no longer applies and nothing is broken.
 *
 * A lock that can't be created at all (a missing or read-only git-dir) runs the
 * session UNLOCKED and says why. The lock guards against an accidental second
 * session; it is not a reason to refuse the first.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveGitDir } = require('./git-branch');
const { breakIfStale, readLock, removeIfSame, sameFile } = require('./lock-breaker');
const procStart = require('./proc-start');

const LOCK_NAME = 'claude-session.lock';
// A lock with no usable content is being written right now -- `wx` creates the
// file empty and the JSON follows -- or its writer died in that instant. Older
// than this, by its mtime, it is the second.
const GRACE_MS = 5000;
// How long to wait on a lock whose holder can't be judged yet before reporting
// it blocked. Longer than a write, short enough not to hold a window up.
const UNKNOWN_WAIT_MS = 1000;
const RETRY_MS = 50;

const validPid = pid => Number.isInteger(pid) && pid > 0;
const validPort = p => Number.isInteger(p) && p > 0 && p < 65536;
// Strict: `Number(null)` is 0, and "no value" must never read as a value.
const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function lockPathFor(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const gitDir = resolveGitDir(path.resolve(cwd));
  return gitDir ? path.join(gitDir, LOCK_NAME) : null;
}

/**
 * 'live' | 'stale' | 'unknown' for what readLock saw.
 * deps: { isAlive, startTimes, now } -- the real ones by default.
 */
async function judgeHolder(seen, deps = {}) {
  const isAlive = deps.isAlive || procStart.isAlive;
  const startTimes = deps.startTimes || procStart.startTimes;
  const now = deps.now || Date.now;

  const p = seen && seen.parsed;
  if (!p || !validPid(p.pid)) {
    // Not a usable lock, so there is no holder to ask about -- and a pid that
    // came off disk is never probed unless it is a positive integer (kill(0)
    // is the process group). Only its age can tell a write in progress from
    // a writer that died mid-write.
    if (!seen || !seen.st) return 'unknown';
    return now() - seen.st.mtimeMs > GRACE_MS ? 'stale' : 'unknown';
  }

  // Our own pid (Dexter, PR #71 F6): no two live processes share a pid, so a
  // lock naming ours that isn't our own record (acquire checks that first) was
  // written by an earlier process that had it -- stale, start time or not.
  const selfPid = Number.isInteger(deps.selfPid) ? deps.selfPid : process.pid;
  if (p.pid === selfPid) return 'stale';

  const alive = isAlive(p.pid);
  if (alive === false) return 'stale';
  if (alive !== true) return 'live';                 // can't tell: fail closed

  // A holder that couldn't learn its own start time is judged on its pid.
  if (typeof p.processStartedAt !== 'string') return 'live';
  const starts = await startTimes([p.pid]);
  if (starts === null) return 'live';                // couldn't ask
  if (!starts.has(p.pid)) return 'stale';            // died since the check
  const osStart = starts.get(p.pid);
  if (osStart === null) return 'live';               // alive, start unreadable
  return osStart === p.processStartedAt ? 'live' : 'stale';
}

function holderOf(seen) {
  const p = (seen && seen.parsed) || {};
  return {
    pid: validPid(p.pid) ? p.pid : null,
    startedAt: finiteOrNull(p.startedAt),
    port: validPort(p.port) ? p.port : null,
    claudePid: validPid(p.claudePid) ? p.claudePid : null,
  };
}

/**
 * Who holds the lock right now, or null when there is no lock. A blocked host
 * read the holder once, possibly before the holder wrote its claude pid in
 * (updateOwn) -- this re-reads it (Dexter, PR #71 F8).
 */
function readHolder(lockPath) {
  if (!lockPath) return null;
  const seen = readLock(lockPath);
  return seen.parsed ? holderOf(seen) : null;
}

const record = o => ({
  pid: o.pid,
  processStartedAt: o.processStartedAt,
  startedAt: o.startedAt,
  port: o.port,
  claudePid: o.claudePid,
});

// true when we created it, false when it exists. Any other failure throws.
function tryCreate(lockPath, owner) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify(record(owner)));
  } catch (err) {
    // An empty lock we can never recognise as ours, and that others would age
    // out after GRACE_MS while we still hold it: give it up instead.
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* aged out by GRACE_MS */ }
    throw err;
  }
  try { fs.closeSync(fd); } catch { /* already closed */ }
  return true;
}

/**
 * Take the worktree's session lock for `owner`.
 *   { state: 'held' }
 *   { state: 'blocked', holder: { pid, startedAt, port, claudePid } }
 *   { state: 'unlocked', reason: 'not-a-repo' | 'error', code? }
 */
async function acquire(lockPath, owner, deps = {}) {
  if (!lockPath) return { state: 'unlocked', reason: 'not-a-repo' };
  const now = deps.now || Date.now;
  const waitMs = Number.isFinite(deps.unknownWaitMs) ? deps.unknownWaitMs : UNKNOWN_WAIT_MS;
  const retryMs = Number.isFinite(deps.retryMs) ? deps.retryMs : RETRY_MS;
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const giveUpAt = now() + waitMs;

  let extraTryAfterBreak = false;
  for (;;) {
    try {
      if (tryCreate(lockPath, owner)) return { state: 'held' };
    } catch (err) {
      return { state: 'unlocked', reason: 'error', code: err.code || String(err.message) };
    }

    const seen = readLock(lockPath);
    let broke = false;
    if (seen.gone) {
      broke = true;                                  // free now; retry at once
    } else if (isOurs(seen, owner)) {
      return { state: 'held' };                      // already ours: acquiring twice is harmless
    } else if (!seen.unreadable) {
      const verdict = await judgeHolder(seen, { ...deps, selfPid: owner.pid });
      if (verdict === 'live') return { state: 'blocked', holder: holderOf(seen) };
      if (verdict === 'stale') {
        // The verdict is about THIS file. Under .break the breaker re-reads;
        // anything else there now is left alone.
        const { outcome } = breakIfStale(lockPath, s => (sameFile(seen, s.raw, s.st) ? 'stale' : 'unknown'));
        broke = outcome === 'freed';
      }
    }

    // Every path reaches the deadline (host/file-lock.js, Mortimer PR #29),
    // and a break earns one more try past it.
    if (now() >= giveUpAt) {
      if (broke && !extraTryAfterBreak) { extraTryAfterBreak = true; continue; }
      return { state: 'blocked', holder: holderOf(seen) };
    }
    if (!broke) await sleep(retryMs);
  }
}

function isOurs(seen, owner) {
  const p = seen && seen.parsed;
  return Boolean(p && owner) &&
    p.pid === owner.pid &&
    p.processStartedAt === owner.processStartedAt &&
    p.startedAt === owner.startedAt;
}

/**
 * Remove our own lock. Never anyone else's -- including a later process on our
 * reused pid. Synchronous, so it can run from an 'exit' handler.
 */
function release(lockPath, owner) {
  if (!lockPath) return false;
  const seen = readLock(lockPath);
  if (!isOurs(seen, owner)) return false;
  return removeIfSame(lockPath, seen);
}

/**
 * Add facts learnt after taking the lock (the claude pid, once spawned).
 * Written to a temp file and renamed over ours, so no reader ever sees a
 * half-written lock. Who holds it can't be changed this way.
 */
function updateOwn(lockPath, owner, patch) {
  if (!lockPath) return false;
  const seen = readLock(lockPath);
  if (!isOurs(seen, owner)) return false;
  const p = seen.parsed;
  const next = record({ ...p, ...patch, pid: p.pid, processStartedAt: p.processStartedAt, startedAt: p.startedAt });
  const tmp = `${lockPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next), { flag: 'wx' });
    fs.renameSync(tmp, lockPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return false;
  }
}

module.exports = { lockPathFor, judgeHolder, acquire, release, updateOwn, readHolder, LOCK_NAME, GRACE_MS, UNKNOWN_WAIT_MS };
