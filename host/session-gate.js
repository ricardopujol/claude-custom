'use strict';
/**
 * Whether the host starts `claude`, from what host/session-lock.js said
 * (Extension X1). Kept apart from host.js so the one rule everything else
 * leans on is tested: a BLOCKED host spawns nothing until the person picks
 * *Open anyway* -- and only a blocked host with no session yet can.
 *
 * The `lock` object here is exactly what the window is sent (`hello.lock`,
 * and `{type:'lock'}` when it changes):
 *   { state: 'pending' }                    before the lock has been tried
 *   { state: 'held' }
 *   { state: 'unlocked', reason, code? }    no lock to take; runs anyway
 *   { state: 'blocked', holder }
 *   { state: 'override', holder }           *Open anyway*: not saved anywhere
 */

function gateFromAcquire(result) {
  const state = result && result.state;
  if (state === 'held') return { lock: { state: 'held' }, start: true };
  if (state === 'unlocked') {
    const lock = { state: 'unlocked', reason: result.reason };
    if (result.code !== undefined) lock.code = result.code;
    return { lock, start: true };
  }
  // Blocked -- and anything this doesn't recognise, which must never read as
  // permission to start a second session.
  return { lock: { state: 'blocked', holder: (result && result.holder) || null }, start: false };
}

function gateOverride(lock, started) {
  if (started || !lock || lock.state !== 'blocked') return null;
  return { lock: { state: 'override', holder: lock.holder }, start: true };
}

// A host is spawned detached so a SESSION outlives its window. A blocked host
// has none: once its last window closes it has nothing to keep alive, and the
// next window must re-check the lock instead of reattaching to a host that
// decided "blocked" long ago.
function idleExit(lock, started, clientCount) {
  return Boolean(lock) && lock.state === 'blocked' && !started && clientCount === 0;
}

// What boot does when something throws after -- or before -- the lock was
// tried (Miguel, PR #71 Y1). A blocked verdict stands: an error must never be
// the thing that starts a second session. A taken lock is kept. Anything
// else starts unlocked and says why, so a bug here never costs the session.
function gateOnBootError(lock) {
  const state = lock && lock.state;
  if (state === 'blocked') return { lock, start: false };
  if (state === 'held' || state === 'unlocked' || state === 'override') return { lock, start: true };
  return { lock: { state: 'unlocked', reason: 'error', code: 'BOOT' }, start: true };
}

const sameHolder = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

// *Open anyway* re-checks the lock first (Dexter, PR #71 F1). If the holder
// has gone since the window was blocked, the lock is TAKEN -- overriding a
// free lock would start an unlocked session, and the next window would take
// the lock and start a second one without being blocked. Only a lock that is
// still held is overridden, and the person asked, so the session starts
// whatever the re-check says.
function gateAfterRecheck(result, lock) {
  const state = result && result.state;
  if (state === 'held' || state === 'unlocked') return gateFromAcquire(result);
  const holder = (state === 'blocked' && result.holder) || (lock && lock.holder) || null;
  return { lock: { state: 'override', holder }, start: true };
}

// The periodic re-check (every 30 s) for a host the lock kept out:
//   blocked, holder gone      -> take the lock and start
//   blocked, another holder   -> show who holds it now
//   overridden, lock free     -> take it, so the next window IS blocked
// null means nothing changes. Held, unlocked and pending hosts are never
// re-checked.
function gateRecheck(lock, started, result) {
  const state = lock && lock.state;
  const got = result && result.state;
  if (state === 'blocked' && !started) {
    if (got === 'held') return { lock: { state: 'held' }, start: true };
    if (got === 'blocked' && !sameHolder(result.holder, lock.holder)) {
      return { lock: { state: 'blocked', holder: result.holder }, start: false };
    }
    return null;
  }
  if (state === 'override' && got === 'held') return { lock: { state: 'held' }, start: false };
  return null;
}

module.exports = { gateFromAcquire, gateOverride, idleExit, gateOnBootError, gateAfterRecheck, gateRecheck };
