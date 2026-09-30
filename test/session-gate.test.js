'use strict';
/**
 * Whether the host starts `claude`, from what the session lock said
 * (Extension X1). The rule the rest of the wiring leans on: a BLOCKED host
 * never spawns a session until the person chooses *Open anyway*, and that
 * choice is only offered to a blocked host.
 */
const test = require('node:test');
const assert = require('node:assert');

const { gateFromAcquire, gateOverride } = require('../host/session-gate');

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
