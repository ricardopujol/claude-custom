'use strict';
/**
 * *Stop that session*, for a window the session lock blocked.
 *
 * A host is detached on purpose (app/main.js spawnHost), so a session outlives
 * its window -- and a session whose window is gone, or whose build is no longer
 * the one being run, holds its worktree's lock with nothing on screen to reach
 * it by. On 2026-09-30 nine such hosts held every lock in this repo; the
 * blocked pane could only *Open anyway* (a second claude) or wait. This is the
 * third way out: end the holder, so this window can take the lock.
 *
 *   stopHolder({ lockPath, shown }, deps) -> { outcome, text, how, reason }
 *   stopHost({ row }, deps)                -> the same, for a ▾ list row (no lock)
 *
 *   'stopped'     the holder ended, its claude too
 *   'gone'        it had already ended (dead pid, or the pid reused)
 *   'has-window'  it has a window open (or one that just left): NOT stopped
 *   'unsure'      it can't be asked and the OS can't count its windows: NOT stopped
 *   'changed'     the lock no longer names the holder the pane showed
 *   'unproven'    the holder couldn't be proven to be the lock's process
 *   'failed'      it was asked and is still running, or answered nonsense
 *   how     'stop-if-idle' | 'stop' | 'kill' when something was ended
 *   reason  why the holder's own controls weren't used, for the log
 *
 * A HOLDER WITH A WINDOW IS NEVER STOPPED (Ricardo, 2026-09-30) -- on every
 * path, including a holder that can't be asked (Dexter + Miguel, PR #76
 * F1/B1). Two ways to know:
 *   - the holder's own `stop-if-idle`: it counts its windows and stops in ONE
 *     step, so none can attach in between (Dexter F2), and it refuses while a
 *     window that just left may be reloading;
 *   - for a build without it, or a holder that can't be reached at all, the OS:
 *     host/window-count.js counts its established connections. Only an OS
 *     count of 0 lets anything be stopped; "couldn't tell" stops nothing.
 *
 * NOTHING IS STOPPED THAT ISN'T PROVEN. The holder is acted on only while its
 * pid is alive with the OS start time recorded in the lock, and only while the
 * lock names the holder the person was shown. A kill re-proves that first,
 * because the ask took time and Windows reuses pids.
 *
 * deps: readLock, isAlive, startTimes, readIdentity({install, port}),
 *       readToken(install, port), sendControl({port, token, msg}),
 *       windowCount(pid, port), killPidTree(pid), sleep(ms), now(),
 *       selfPid, parentPid
 */

const { OLDER_HOST } = require('./host-client');

// Long enough for a host's teardown and its claude's console close (Dexter F5).
const WAIT_MS = 15000;
const POLL_MS = 200;

const validPid = n => Number.isInteger(n) && n > 0;
const validPort = n => Number.isInteger(n) && n > 0 && n < 65536;
const nonEmpty = s => typeof s === 'string' && s.length > 0;

const TEXT = {
  stopped: 'Stopped that session.',
  gone: 'That session had already ended.',
  'has-window': "That session has a window open, so it wasn't stopped. Its window was brought forward.",
  'has-window-recent': "That session's window was open a moment ago (it may be reloading), so it wasn't stopped.",
  // Counted by the OS, with no way to ask it to come forward.
  'has-window-unraised': "That session has a window open, so it wasn't stopped.",
  unsure: "Couldn't tell whether that session has a window open, so it wasn't stopped.",
  changed: 'The lock changed hands, so nothing was stopped.',
  unproven: "Couldn't confirm which process holds the lock, so nothing was stopped.",
  // A ▾ row from an older build: its pid can't be proven exactly, and it didn't
  // answer its own controls, so it is not ended by pid (Dexter, PR 2 F1).
  'unproven-unasked': "That session didn't answer, and an older build's session is only stopped when it does, so it wasn't stopped.",
  failed: "Couldn't stop that session",
};

function result(outcome, { detail = null, how = null, reason = null, variant = null } = {}) {
  let text = TEXT[variant || outcome];
  if (outcome === 'failed' && detail) text = `${TEXT.failed}: ${detail}.`;
  return { outcome, text, how, reason };
}

// The pane's holder is host/session-lock.js holderOf(): no start time, so a
// lock is matched on its host pid and the time it was taken.
const sameHolder = (lock, shown) =>
  Boolean(shown) && validPid(shown.pid) && lock.pid === shown.pid && lock.startedAt === shown.startedAt;

// 'same' | 'gone' | 'unknown': is `pid` still the process that took the lock?
async function proveStart(pid, startedAt, deps) {
  const alive = deps.isAlive(pid);
  if (alive === false) return 'gone';
  if (alive !== true) return 'unknown';
  const starts = await deps.startTimes([pid]);
  if (starts === null) return 'unknown';
  if (!starts.has(pid)) return 'gone';
  const os = starts.get(pid);
  if (os === null || os === undefined) return 'unknown';
  return os === startedAt ? 'same' : 'gone';
}

// The holder's token, once its identity file names its pid -- or why not.
function reach(lock, deps) {
  if (!nonEmpty(lock.install)) return { reason: 'its lock has no install (an older build)' };
  if (!validPort(lock.port)) return { reason: 'its lock has no port' };
  let identity = null;
  try { identity = deps.readIdentity({ install: lock.install, port: lock.port }); } catch { identity = null; }
  if (!identity) return { reason: 'its identity file is missing' };
  if (identity.pid !== lock.pid) return { reason: `another host (pid ${identity.pid}) is on its port` };
  let token = null;
  try { token = deps.readToken(lock.install, lock.port); } catch { token = null; }
  if (!nonEmpty(token)) return { reason: 'its token file is missing' };
  return { token };
}

// Ended means the host AND its claude (Dexter F5): a re-check that took the
// lock while claude #1 was still closing would start claude #2 beside it.
async function waitForEnd(lock, deps) {
  const deadline = deps.now() + WAIT_MS;
  const claude = validPid(lock.claudePid) ? lock.claudePid : null;
  for (;;) {
    const hostGone = deps.isAlive(lock.pid) === false;
    const claudeGone = claude === null || deps.isAlive(claude) === false;
    if (hostGone && claudeGone) return { ended: true };
    if (deps.now() >= deadline) {
      if (!hostGone && (await proveStart(lock.pid, lock.processStartedAt, deps)) !== 'gone') {
        return { ended: false, detail: 'it is still running' };
      }
      return claudeGone ? { ended: true } : { ended: false, detail: `its claude (pid ${claude}) is still running` };
    }
    await deps.sleep(POLL_MS);
  }
}

async function ended(lock, deps, how, reason) {
  const w = await waitForEnd(lock, deps);
  return w.ended ? result('stopped', { how, reason }) : result('failed', { detail: w.detail, how, reason });
}

// No answer from the holder itself: the OS counts its windows, and only a 0
// lets it be stopped -- through its own `stop` when it can take one, else by
// its re-proven pid. `asked` says a stop-if-idle may already be under way.
async function stopUnasked(lock, deps, { token, reason, asked, mayKill = true }) {
  const windows = await deps.windowCount(lock.pid, lock.port);
  if (windows === null || windows === undefined) return result('unsure', { reason });
  if (!(Number.isInteger(windows) && windows >= 0)) return result('unsure', { reason });
  if (windows > 0) {
    // Brought forward when it can be asked -- and the pane says so only then.
    let raised = false;
    if (token) {
      try {
        const r = await deps.sendControl({ port: lock.port, token, msg: { type: 'raise' } });
        raised = Boolean(r && r.ok);
      } catch { raised = false; }
    }
    return result('has-window', { reason, variant: raised ? null : 'has-window-unraised' });
  }
  if (token) {
    const s = await deps.sendControl({ port: lock.port, token, msg: { type: 'stop' } });
    if (s && s.ok) return ended(lock, deps, 'stop', reason);
  }
  const again = await proveStart(lock.pid, lock.processStartedAt, deps);
  if (again === 'gone') return asked ? ended(lock, deps, 'stop-if-idle', reason) : result('gone', { reason });
  if (again !== 'same') return result('unproven', { reason });
  if (!mayKill) return result('unproven', { reason, variant: 'unproven-unasked' });
  deps.killPidTree(lock.pid);
  return ended(lock, deps, 'kill', reason);
}

async function stopHolder({ lockPath, shown } = {}, deps = {}) {
  const seen = deps.readLock(lockPath);
  if (seen.gone) return result('gone');
  const lock = seen.parsed;
  if (!lock || !validPid(lock.pid) || !sameHolder(lock, shown)) return result('changed');
  return stopProven(lock, deps);
}

/**
 * *Stop* from the strip's ▾ list (Windowless sessions PR 2): a row of
 * host/background-hosts.js, which may hold no lock at all (a host serving a
 * non-repo folder). Proven the same way, against the OS start time the list
 * read for it, and stopped by the same rules. Its claude pid isn't known
 * without a lock; a stop or a tree kill ends it with its host.
 */
//
// KILLED BY PID ONLY ON AN EXACT PROOF (Dexter, PR 2 F1): `row.exact` says the
// identity file carried the host's OS start time and it matched. A row proven
// by the wall clock alone (an older build) may name an unrelated process once
// the clock has stepped back, so it ends only through its own token-checked
// controls -- which that process can't answer. Anything but `exact: true` is
// read as wall-proven.
async function stopHost({ row } = {}, deps = {}) {
  if (!row || !validPid(row.pid)) return result('unproven');
  return stopProven({
    // Its claude, when the identity named one (Dexter, PR #83 F1): "stopped"
    // waits for both, as PR 1's lock path always did.
    pid: row.pid, processStartedAt: row.processStartedAt, port: row.port, install: row.install,
    claudePid: validPid(row.claudePid) ? row.claudePid : null,
  }, deps, { mayKill: row.exact === true });
}

// `lock` is the holder: { pid, processStartedAt, port, install, claudePid }.
// `mayKill`: false keeps every path but the pid kill.
async function stopProven(lock, deps, { mayKill = true } = {}) {
  // Never this host or the window that started it (Miguel S1): a lock naming
  // either is not a holder to end, whatever else it says.
  const self = Number.isInteger(deps.selfPid) ? deps.selfPid : process.pid;
  const parent = Number.isInteger(deps.parentPid) ? deps.parentPid : process.ppid;
  if (lock.pid === self || lock.pid === parent) return result('unproven');
  if (typeof lock.processStartedAt !== 'string') return result('unproven');

  const proof = await proveStart(lock.pid, lock.processStartedAt, deps);
  if (proof === 'gone') return result('gone');
  if (proof !== 'same') return result('unproven');

  const r = reach(lock, deps);
  if (!r.token) return stopUnasked(lock, deps, { reason: r.reason, mayKill });

  const answer = await deps.sendControl({ port: lock.port, token: r.token, msg: { type: 'stop-if-idle' } });
  if (answer && answer.ok) {
    const reply = answer.reply || {};
    if (reply.stopped === true) return ended(lock, deps, 'stop-if-idle', null);
    if (reply.stopped === false) {
      return result('has-window', { variant: reply.recent === true && reply.windows === 0 ? 'has-window-recent' : null });
    }
    return result('failed', { detail: "it gave an answer that wasn't yes or no" });
  }
  const error = (answer && answer.error) || 'no answer';
  if (error === OLDER_HOST('stop-if-idle')) {
    return stopUnasked(lock, deps, { token: r.token, reason: 'its build has no stop-if-idle', mayKill });
  }
  // Timed out, refused, hung up: it may be busy, hung, or already stopping.
  return stopUnasked(lock, deps, { reason: `stop-if-idle: ${error}`, asked: true, mayKill });
}

module.exports = { stopHolder, stopHost, WAIT_MS, POLL_MS, TEXT };
