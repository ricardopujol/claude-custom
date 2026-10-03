'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { tabStatus, afterSelected, sameStatus, pendingAfter } = require('../app/tab-status');

// A stand-in with the real marker's contract ({ text } or null). The renderer
// injects worktreeStatus.healthMarker; requiring it here would put a mutated
// module under this test (test/stryker-config.test.js).
const healthMarker = (h) => {
  if (h && h.kind === 'tab' && h.behindDevelop > 0) return { text: `↓${h.behindDevelop}` };
  if (h && h.kind === 'dev' && h.developAheadOfMain > 0) return { text: `+${h.developAheadOfMain}` };
  return null;
};

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

test('finished is exactly pendingFinished === true (#31)', () => {
  assert.strictEqual(ts({ pendingFinished: true }).finished, true);
  for (const v of [false, undefined, null, 1, 'true']) {
    assert.strictEqual(ts({ pendingFinished: v }).finished, false);
  }
});

test('afterSelected clears needsInput and finished, and leaves the rest', () => {
  const s = ts({ mainMood: 'working', pendingUrgent: true, pendingFinished: true, lock: { state: 'held' }, health: { kind: 'tab', behindDevelop: 2 } });
  assert.strictEqual(s.needsInput, true);
  assert.strictEqual(s.finished, true);
  const cleared = afterSelected(s);
  assert.deepStrictEqual(cleared, { ...s, needsInput: false, finished: false });
  assert.strictEqual(s.needsInput, true, 'does not mutate');
  assert.strictEqual(s.finished, true, 'does not mutate');
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
  assert.deepStrictEqual(ts(undefined), { working: false, needsInput: false, finished: false, lock: null, health: null });
  assert.deepStrictEqual(ts({}), { working: false, needsInput: false, finished: false, lock: null, health: null });
});

test('sameStatus: field by field, and null handling', () => {
  const base = { working: true, needsInput: false, finished: false, lock: 'held', health: '↓3' };
  assert.strictEqual(sameStatus(base, { ...base }), true);
  for (const [k, v] of [['working', false], ['needsInput', true], ['finished', true], ['lock', null], ['health', null]]) {
    assert.strictEqual(sameStatus(base, { ...base, [k]: v }), false, k);
  }
  assert.strictEqual(sameStatus(null, null), true);
  assert.strictEqual(sameStatus(undefined, null), false);
  assert.strictEqual(sameStatus(base, null), false);
  assert.strictEqual(sameStatus(null, base), false);
  assert.strictEqual(sameStatus(undefined, undefined), true);
});

test('pendingAfter: a finished turn answers a pending urgent need; a new turn ends a finished one (#31)', () => {
  const none = { urgent: false, finished: false };
  assert.deepStrictEqual(pendingAfter(none, 'urgent'), { urgent: true, finished: false });
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: false }, 'finished'), { urgent: false, finished: true },
    'the prompt was answered somewhere (Remote Control): finished shows, not the urgent look');
  assert.deepStrictEqual(pendingAfter({ urgent: false, finished: true }, 'working'), { urgent: false, finished: false },
    'a new turn: "done, come look" is no longer true');
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: true }, 'working'), { urgent: true, finished: false },
    'working says nothing about a prompt that is waiting');
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: true }, 'looked'), none);
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: false }, 'nonsense'), { urgent: true, finished: false });
  for (const bad of [null, undefined, 5, 'x', { urgent: 1, finished: 'yes' }]) {
    assert.deepStrictEqual(pendingAfter(bad, 'nonsense'), none, 'only a real true counts');
  }
});

test('PROPERTY: after a finished turn nothing urgent is pending, whatever came before', () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom('urgent', 'finished', 'working', 'looked'), { maxLength: 12 }),
    (events) => {
      let p = { urgent: false, finished: false };
      for (const e of events) {
        p = pendingAfter(p, e);
        if (e === 'finished') assert.deepStrictEqual(p, { urgent: false, finished: true });
        if (e === 'looked') assert.deepStrictEqual(p, { urgent: false, finished: false });
      }
    }));
});
