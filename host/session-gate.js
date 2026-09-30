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

module.exports = { gateFromAcquire, gateOverride, idleExit };
