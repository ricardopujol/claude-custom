'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tabStatus, afterSelected, sameStatus } = require('../app/tab-status');
const { healthMarker } = require('../app/worktree-status-display');

const ts = (inputs) => tabStatus(inputs, { healthMarker });

test('working is exactly mainMood === working', () => {
  assert.strictEqual(ts({ mainMood: 'working' }).working, true);
  for (const mood of ['idle', 'thinking', undefined, null, 'WORKING']) {
    assert.strictEqual(ts({ mainMood: mood }).working, false);
  }
});

test('needsInput is exactly pendingUrgent === true', () => {
  assert.strictEqual(ts({ pendingUrgent: true }).needsInput, true);
  for (const v of [false, undefined, null, 1, 'true']) {
    assert.strictEqual(ts({ pendingUrgent: v }).needsInput, false);
  }
});

test('afterSelected clears needsInput and leaves the rest', () => {
  const s = ts({ mainMood: 'working', pendingUrgent: true, lock: { state: 'held' }, health: { kind: 'tab', behindDevelop: 2 } });
  assert.strictEqual(s.needsInput, true);
  const cleared = afterSelected(s);
  assert.deepStrictEqual(cleared, { ...s, needsInput: false });
  assert.strictEqual(s.needsInput, true, 'does not mutate');
});

test('lock is the message state when known, else null (never held)', () => {
  for (const st of ['held', 'unlocked', 'blocked', 'override', 'pending']) {
    assert.strictEqual(ts({ lock: { state: st } }).lock, st);
  }
  for (const bad of [{ state: 'weird' }, { state: 5 }, {}, null, undefined, 'held']) {
    assert.strictEqual(ts({ lock: bad }).lock, null);
  }
});

test('health is the marker text or null', () => {
  assert.strictEqual(ts({ health: { kind: 'tab', behindDevelop: 3 } }).health, '↓3');
  assert.strictEqual(ts({ health: { kind: 'dev', developAheadOfMain: 12 } }).health, '+12');
  assert.strictEqual(ts({ health: { kind: 'tab', behindDevelop: 0 } }).health, null);
  assert.strictEqual(ts({ health: null }).health, null);
});

test('without an injected healthMarker, health is null rather than a throw', () => {
  assert.strictEqual(tabStatus({ health: { kind: 'tab', behindDevelop: 3 } }).health, null);
  assert.strictEqual(tabStatus({ health: 1 }, { healthMarker: () => ({}) }).health, null);
});

test('no inputs at all is a quiet status', () => {
  assert.deepStrictEqual(ts(undefined), { working: false, needsInput: false, lock: null, health: null });
  assert.deepStrictEqual(ts({}), { working: false, needsInput: false, lock: null, health: null });
});

test('sameStatus: field by field, and null handling', () => {
  const base = { working: true, needsInput: false, lock: 'held', health: '↓3' };
  assert.strictEqual(sameStatus(base, { ...base }), true);
  for (const [k, v] of [['working', false], ['needsInput', true], ['lock', null], ['health', null]]) {
    assert.strictEqual(sameStatus(base, { ...base, [k]: v }), false, k);
  }
  assert.strictEqual(sameStatus(null, null), true);
  assert.strictEqual(sameStatus(undefined, null), false);
  assert.strictEqual(sameStatus(base, null), false);
  assert.strictEqual(sameStatus(null, base), false);
  assert.strictEqual(sameStatus(undefined, undefined), true);
});
