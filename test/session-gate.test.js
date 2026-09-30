'use strict';
/**
 * Whether the host starts `claude`, from what the session lock said
 * (Extension X1). The rule the rest of the wiring leans on: a BLOCKED host
 * never spawns a session until the person chooses *Open anyway*, and that
 * choice is only offered to a blocked host.
 */
const test = require('node:test');
const assert = require('node:assert');

const { gateFromAcquire, gateOverride, idleExit, gateOnBootError, gateAfterRecheck, gateRecheck } = require('../host/session-gate');

const HOLDER = { pid: 101, startedAt: 1790000000000, port: 7710, claudePid: 555 };

test('a held lock starts the session', () => {
  assert.deepStrictEqual(gateFromAcquire({ state: 'held' }), { lock: { state: 'held' }, start: true });
});

test('no lock to take (not a repo, or it could not be written) still starts, and says why', () => {
  assert.deepStrictEqual(gateFromAcquire({ state: 'unlocked', reason: 'not-a-repo' }),
    { lock: { state: 'unlocked', reason: 'not-a-repo' }, start: true });
  assert.deepStrictEqual(gateFromAcquire({ state: 'unlocked', reason: 'error', code: 'EACCES' }),
    { lock: { state: 'unlocked', reason: 'error', code: 'EACCES' }, start: true });
});

test('a blocked lock does NOT start the session, and carries the holder', () => {
  assert.deepStrictEqual(gateFromAcquire({ state: 'blocked', holder: HOLDER }),
    { lock: { state: 'blocked', holder: HOLDER }, start: false });
});

test('anything unrecognised is treated as blocked, never as a licence to start', () => {
  for (const r of [null, undefined, {}, { state: 'weird' }, { state: 'held ' }]) {
    const g = gateFromAcquire(r);
    assert.strictEqual(g.start, false, JSON.stringify(r));
    assert.strictEqual(g.lock.state, 'blocked');
  }
});

test('Open anyway turns a blocked host into an overridden one that starts', () => {
  assert.deepStrictEqual(gateOverride({ state: 'blocked', holder: HOLDER }, false),
    { lock: { state: 'override', holder: HOLDER }, start: true });
});

test('Open anyway does nothing unless the host is blocked and has no session yet', () => {
  assert.strictEqual(gateOverride({ state: 'held' }, true), null);
  assert.strictEqual(gateOverride({ state: 'unlocked', reason: 'not-a-repo' }, true), null);
  assert.strictEqual(gateOverride({ state: 'override', holder: HOLDER }, true), null);
  assert.strictEqual(gateOverride({ state: 'blocked', holder: HOLDER }, true), null, 'already started');
  assert.strictEqual(gateOverride({ state: 'pending' }, false), null);
  assert.strictEqual(gateOverride(null, false), null);
});

// A host is spawned detached so a SESSION outlives its window. A blocked host
// has no session: once its last window closes there is nothing left for it to
// keep alive, and a later window must re-check the lock rather than reattach
// to a host that decided "blocked" hours ago.

test('a blocked host with no session and no window exits', () => {
  assert.strictEqual(idleExit({ state: 'blocked', holder: HOLDER }, false, 0), true);
});

test('a host with a session, a window, or no block stays', () => {
  assert.strictEqual(idleExit({ state: 'blocked', holder: HOLDER }, false, 1), false, 'a window is still open');
  assert.strictEqual(idleExit({ state: 'blocked', holder: HOLDER }, true, 0), false, 'it has a session');
  for (const lock of [{ state: 'held' }, { state: 'override', holder: HOLDER }, { state: 'pending' },
    { state: 'unlocked', reason: 'not-a-repo' }, null]) {
    assert.strictEqual(idleExit(lock, false, 0), false, JSON.stringify(lock));
  }
});

// Miguel, PR #71 Y1: the boot sequence's catch started a session whatever the
// lock had said. A failure AFTER a blocked verdict must not start claude #2.

test('a boot error after a blocked verdict stays blocked and starts nothing', () => {
  const lock = { state: 'blocked', holder: HOLDER };
  assert.deepStrictEqual(gateOnBootError(lock), { lock, start: false });
});

test('a boot error after the lock was taken keeps it and starts the session', () => {
  assert.deepStrictEqual(gateOnBootError({ state: 'held' }), { lock: { state: 'held' }, start: true });
});

test('a boot error before any verdict starts unlocked, and says so', () => {
  const unlocked = { lock: { state: 'unlocked', reason: 'error', code: 'BOOT' }, start: true };
  assert.deepStrictEqual(gateOnBootError({ state: 'pending' }), unlocked);
  assert.deepStrictEqual(gateOnBootError(null), unlocked);
  assert.deepStrictEqual(gateOnBootError({ state: 'unlocked', reason: 'not-a-repo' }),
    { lock: { state: 'unlocked', reason: 'not-a-repo' }, start: true }, 'an unlocked verdict is kept as it was');
});

// Dexter, PR #71 F1: a blocked host never re-checked the lock. The holder
// exits, *Open anyway* starts an UNLOCKED claude on a free lock, and the next
// window takes that free lock and starts claude #2 without being blocked.

const NEW_HOLDER = { pid: 202, startedAt: 1790000009000, port: 7720, claudePid: 666 };

test('Open anyway re-checks first: a lock that is free now is TAKEN, not overridden', () => {
  assert.deepStrictEqual(gateAfterRecheck({ state: 'held' }, { state: 'blocked', holder: HOLDER }),
    { lock: { state: 'held' }, start: true });
});

test('Open anyway on a lock that is still held overrides it, naming whoever holds it now', () => {
  assert.deepStrictEqual(gateAfterRecheck({ state: 'blocked', holder: NEW_HOLDER }, { state: 'blocked', holder: HOLDER }),
    { lock: { state: 'override', holder: NEW_HOLDER }, start: true });
});

test('Open anyway where no lock can be taken at all starts unlocked, as boot would', () => {
  assert.deepStrictEqual(gateAfterRecheck({ state: 'unlocked', reason: 'error', code: 'EACCES' }, { state: 'blocked', holder: HOLDER }),
    { lock: { state: 'unlocked', reason: 'error', code: 'EACCES' }, start: true });
});

test('Open anyway with a garbled re-check result still honours the click, with the old holder', () => {
  assert.deepStrictEqual(gateAfterRecheck(null, { state: 'blocked', holder: HOLDER }),
    { lock: { state: 'override', holder: HOLDER }, start: true });
});

test('the periodic re-check: a blocked window whose holder has gone takes the lock and starts', () => {
  assert.deepStrictEqual(gateRecheck({ state: 'blocked', holder: HOLDER }, false, { state: 'held' }),
    { lock: { state: 'held' }, start: true });
});

test('the periodic re-check: still blocked by the same holder changes nothing; a new holder is shown', () => {
  assert.strictEqual(gateRecheck({ state: 'blocked', holder: HOLDER }, false, { state: 'blocked', holder: { ...HOLDER } }), null);
  assert.deepStrictEqual(gateRecheck({ state: 'blocked', holder: HOLDER }, false, { state: 'blocked', holder: NEW_HOLDER }),
    { lock: { state: 'blocked', holder: NEW_HOLDER }, start: false });
});

test('the periodic re-check: an overridden session takes the lock once it is free, so the next window IS blocked', () => {
  assert.deepStrictEqual(gateRecheck({ state: 'override', holder: HOLDER }, true, { state: 'held' }),
    { lock: { state: 'held' }, start: false });
  assert.strictEqual(gateRecheck({ state: 'override', holder: HOLDER }, true, { state: 'blocked', holder: HOLDER }), null);
});

test('the periodic re-check never touches a held, unlocked or pending host', () => {
  for (const lock of [{ state: 'held' }, { state: 'unlocked', reason: 'not-a-repo' }, { state: 'pending' }, null]) {
    assert.strictEqual(gateRecheck(lock, true, { state: 'held' }), null, JSON.stringify(lock));
  }
  assert.strictEqual(gateRecheck({ state: 'blocked', holder: HOLDER }, true, { state: 'held' }), null,
    'a blocked host that somehow has a session is not started twice');
});
