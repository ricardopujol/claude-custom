'use strict';
/**
 * host/resource-warning.js (BACKLOG #63): the per-session "over 40% for 30 s" counter. Three samples at 10 s.
 * It shows up slowly and clears quickly: one sample below the threshold ends it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const W = require('../host/resource-warning');

const run = (pcts, start = W.initial()) => pcts.reduce((s, p) => W.step(s, p), start);

test('three consecutive samples at or over 40% turn the warning on, two do not', () => {
  assert.strictEqual(run([50, 50]).on, false);
  assert.strictEqual(run([50, 50, 50]).on, true);
});

test('the boundary: exactly 40 counts as over, 39.99 does not', () => {
  assert.strictEqual(run([40, 40, 40]).on, true);
  assert.strictEqual(run([39.99, 39.99, 39.99, 39.99]).on, false);
  assert.strictEqual(run([40, 40, 39.99]).on, false);
});

test('one sample below 40% clears it and restarts the count', () => {
  const on = run([60, 60, 60]);
  assert.strictEqual(on.on, true);
  const cleared = W.step(on, 10);
  assert.strictEqual(cleared.on, false);
  assert.strictEqual(cleared.over, 0);
  assert.strictEqual(run([60, 60], cleared).on, false, 'the count starts again from zero');
});

test('level: amber from 40, red from exactly 75, and only while the warning is on', () => {
  assert.strictEqual(run([40, 40, 40]).level, 'amber');
  assert.strictEqual(run([74.9, 74.9, 74.9]).level, 'amber');
  assert.strictEqual(run([75, 75, 75]).level, 'red');
  assert.strictEqual(run([75, 75]).level, null);
  assert.strictEqual(run([10]).level, null);
});

test('the chip shows the latest figure, so a spike inside the warning turns it red at once', () => {
  const s = run([50, 50, 50, 90]);
  assert.strictEqual(s.level, 'red');
  assert.strictEqual(s.pct, 90);
});

test('a missing measurement (null, undefined, NaN, a string) holds the state: no warning from nothing, none cleared by nothing', () => {
  const on = run([60, 60, 60]);
  for (const bad of [null, undefined, NaN, '80', Infinity]) assert.deepStrictEqual(W.step(on, bad), on);
  const two = run([60, 60]);
  assert.deepStrictEqual(W.step(two, null), two);
  assert.strictEqual(W.step(two, 60).on, true);
});

test('options: another threshold and sample count', () => {
  const s = [10, 10].reduce((st, p) => W.step(st, p, { threshold: 5, needed: 2 }), W.initial());
  assert.strictEqual(s.on, true);
});

test('prune keeps the sessions that are still live and drops the rest', () => {
  const m = new Map([[1, run([60, 60, 60])], [2, run([60])]]);
  const out = W.prune(m, new Set([2, 3]));
  assert.deepStrictEqual([...out.keys()], [2]);
  assert.strictEqual(m.size, 2, 'the input is not changed');
});

test('property: on is true exactly when the last three measured samples were all at or over the threshold', () => {
  const pctArb = fc.oneof(fc.double({ min: 0, max: 120, noNaN: true }), fc.constant(40), fc.constant(null));
  fc.assert(fc.property(fc.array(pctArb, { maxLength: 30 }), (pcts) => {
    const s = run(pcts);
    const measured = pcts.filter(p => p !== null);
    const last3 = measured.slice(-3);
    const expected = last3.length === 3 && last3.every(p => p >= 40);
    assert.strictEqual(s.on, expected);
    assert.strictEqual(s.level === null, !expected);
  }));
});
