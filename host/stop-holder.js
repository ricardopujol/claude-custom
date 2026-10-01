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
 *   stopHolder({ lockPath, shown }, deps) -> { outcome, text }
 *
 *   'stopped'     the holder ended
 *   'gone'        it had already ended (dead pid, or the pid reused)
 *   'has-window'  it has a window open: brought forward, NOT stopped
 *   'changed'     the lock no longer names the holder the pane showed
 *   'unproven'    the holder couldn't be proven to be the lock's process
 *   'failed'      it was asked and it is still running
 *
 * NOTHING IS STOPPED THAT ISN'T PROVEN. host/session-lock.js judges a holder
 * it can't read as LIVE (fail closed: a wrong break is a second claude). Here
 * the same doubt must fail the other way -- a wrong stop ends somebody's
 * session -- so the holder is acted on only when its pid is alive AND the OS
 * start time equals the one in the lock, and only when the lock still names
 * the holder the person was shown.
 *
 * A HOLDER WITH A WINDOW IS NEVER STOPPED (Ricardo, 2026-09-30). It is asked
 * `raise` first: that answers how many windows it has, and when there are any
 * it brings them forward -- which is *Go to that session*, the right answer
 * for a session someone is looking at.
 *
 * deps: readLock, isAlive, startTimes, readIdentity({install, port}),
 *       readToken(install, port), sendControl({port, token, msg}),
 *       killPidTree(pid), sleep(ms), now()
 */

const WAIT_MS = 8000;
const POLL_MS = 200;

const validPid = n => Number.isInteger(n) && n > 0;
const validPort = n => Number.isInteger(n) && n > 0 && n < 65536;
const nonEmpty = s => typeof s === 'string' && s.length > 0;

const TEXT = {
  stopped: 'Stopped that session.',
  gone: 'That session had already ended.',
  'has-window': "That session has a window open, so it wasn't stopped. Its window was brought forward.",
  changed: 'The lock changed hands, so nothing was stopped.',
  unproven: "Couldn't confirm which process holds the lock, so nothing was stopped.",
  failed: "Couldn't stop that session",
};

function result(outcome, detail) {
  const text = outcome === 'failed' && detail ? `${TEXT.failed}: ${detail}.` : TEXT[outcome];
  return { outcome, text };
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

// Through the holder's own controls: raise (how many windows?), then stop.
async function askToStop(lock, deps) {
  if (!nonEmpty(lock.install) || !validPort(lock.port)) return { kind: 'unreachable' };
  let identity = null;
  try { identity = deps.readIdentity({ install: lock.install, port: lock.port }); } catch { identity = null; }
  if (!identity || identity.pid !== lock.pid) return { kind: 'unreachable' };
  let token = null;
  try { token = deps.readToken(lock.install, lock.port); } catch { token = null; }
  if (!nonEmpty(token)) return { kind: 'unreachable' };

  const raised = await deps.sendControl({ port: lock.port, token, msg: { type: 'raise' } });
  if (!raised || !raised.ok) return { kind: 'unreachable' };
  const windows = raised.reply && raised.reply.windows;
  // Strict: `Number(null)` is 0, and "didn't say" must never read as "none".
  if (!(Number.isInteger(windows) && windows >= 0)) return { kind: 'unclear' };
  if (windows > 0) return { kind: 'has-window' };
  const stopped = await deps.sendControl({ port: lock.port, token, msg: { type: 'stop' } });
  if (!stopped || !stopped.ok) return { kind: 'unreachable' };
  return { kind: 'stop-sent' };
}

async function waitForEnd(lock, deps) {
  const deadline = deps.now() + WAIT_MS;
  for (;;) {
    if (deps.isAlive(lock.pid) === false) return true;
    if (deps.now() >= deadline) return (await proveStart(lock.pid, lock.processStartedAt, deps)) === 'gone';
    await deps.sleep(POLL_MS);
  }
}

async function stopHolder({ lockPath, shown } = {}, deps = {}) {
  const seen = deps.readLock(lockPath);
  if (seen.gone) return result('gone');
  const lock = seen.parsed;
  if (!lock || !validPid(lock.pid) || !sameHolder(lock, shown)) return result('changed');
  if (typeof lock.processStartedAt !== 'string') return result('unproven');

  const proof = await proveStart(lock.pid, lock.processStartedAt, deps);
  if (proof === 'gone') return result('gone');
  if (proof !== 'same') return result('unproven');

  const asked = await askToStop(lock, deps);
  if (asked.kind === 'has-window') return result('has-window');
  if (asked.kind === 'unclear') return result('failed', "it didn't say whether it has a window open");

  // It can't take the controls: a lock older than `install`, a build older
  // than `raise`/`stop`, another host on its port, or a hung host. Its tree is
  // ended by pid -- proven AGAIN first, because the ask took time and Windows
  // reuses pids.
  if (asked.kind === 'unreachable') {
    const again = await proveStart(lock.pid, lock.processStartedAt, deps);
    if (again === 'gone') return result('gone');
    if (again !== 'same') return result('unproven');
    deps.killPidTree(lock.pid);
  }

  return (await waitForEnd(lock, deps)) ? result('stopped') : result('failed', 'it is still running');
}

module.exports = { stopHolder, WAIT_MS, POLL_MS, TEXT };
