'use strict';
/**
 * Whether the host starts `claude`, from what the session lock said
 * (Extension X1). The rule the rest of the wiring leans on: a BLOCKED host
 * never spawns a session until the person chooses *Open anyway*, and that
 * choice is only offered to a blocked host.
 */
const test = require('node:test');
const assert = require('node:assert');

const { gateFromAcquire, gateOverride, idleExit, gateOnBootError } = require('../host/session-gate');

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
