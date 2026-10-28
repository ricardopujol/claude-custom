'use strict';
/**
 * Chrome grammar A (2026-10-26): app/chip-model.js, the pure decisions behind the header chips: the 28 px micro-bar and the one
 * warnings chip with a count.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { BAR_PX, microBar, warningsChip } = require('../app/chip-model');

test('the micro-bar is 28 px wide', () => assert.strictEqual(BAR_PX, 28));

test('microBar: a fraction becomes whole pixels of fill, clamped to the bar', () => {
  assert.deepStrictEqual(microBar(0), { known: true, px: 0 });
  assert.deepStrictEqual(microBar(0.5), { known: true, px: 14 });
  assert.deepStrictEqual(microBar(1), { known: true, px: 28 });
  assert.deepStrictEqual(microBar(1.7), { known: true, px: 28 }, 'over full is full');
  assert.deepStrictEqual(microBar(-0.2), { known: true, px: 0 });
});

test('microBar: no value is UNKNOWN, never an empty bar (Number(null) is 0)', () => {
  for (const v of [null, undefined, NaN, Infinity, '0.5', {}, [], true]) {
    assert.deepStrictEqual(microBar(v), { known: false, px: 0 }, String(v));
  }
});

test('property: px is an integer in [0, 28] for any number', () => {
  fc.assert(fc.property(fc.double(), (f) => {
    const b = microBar(f);
    assert.ok(Number.isInteger(b.px) && b.px >= 0 && b.px <= BAR_PX);
    assert.strictEqual(b.known, Number.isFinite(f));
  }));
});

test('warningsChip: nothing to say hides the chip', () => {
  assert.deepStrictEqual(warningsChip([]), { shown: false, count: 0, label: '', title: '' });
  assert.deepStrictEqual(warningsChip(null), { shown: false, count: 0, label: '', title: '' });
  assert.deepStrictEqual(warningsChip([null, {}, { text: '' }, { text: 3 }]), { shown: false, count: 0, label: '', title: '' });
});

test('warningsChip: one chip with a count, the detail one line each in the hover text', () => {
  const w = warningsChip([{ text: 'behind develop', title: 'Behind develop by 3 commits' }, { text: 'lock', title: 'Second session' }]);
  assert.deepStrictEqual(w, { shown: true, count: 2, label: '2', title: 'Behind develop by 3 commits\nSecond session' });
});

test('warningsChip: a warning with no title falls back to its text; the count is never a sentence', () => {
  const w = warningsChip([{ text: 'behind develop' }]);
  assert.strictEqual(w.title, 'behind develop');
  assert.strictEqual(w.label, '1');
});

test('property: label is the count as digits, and shown means count > 0', () => {
  const item = fc.record({ text: fc.string(), title: fc.option(fc.string(), { nil: undefined }) });
  fc.assert(fc.property(fc.array(fc.oneof(item, fc.anything())), (items) => {
    const w = warningsChip(items);
    assert.strictEqual(w.shown, w.count > 0);
    assert.strictEqual(w.label, w.count > 0 ? String(w.count) : '');
  }));
});

// ---- Miguel, PR #215 round 1, finding 2: while the suite runs the chip keeps its last known value, dimmed ----------------------

const { healthChip } = require('../app/chip-model');

test('healthChip: a finished run shows passed/total and a bar, and hands back what to remember', () => {
  const c = healthChip({ state: 'healthy', fraction: 0.5, passed: 7, total: 14, running: false }, null);
  assert.strictEqual(c.label, '7/14');
  assert.deepStrictEqual(c.bar, { known: true, px: 14 });
  assert.strictEqual(c.running, false);
  assert.strictEqual(c.stale, false);
  assert.deepStrictEqual(c.known, { label: '7/14', fraction: 0.5 });
});

test('healthChip: while running it keeps the last known value and bar, both stale (dimmed), and remembers nothing new', () => {
  const last = { label: '7/14', fraction: 0.5 };
  const c = healthChip({ state: 'unknown', fraction: null, running: true }, last);
  assert.strictEqual(c.label, '7/14');
  assert.deepStrictEqual(c.bar, { known: true, px: 14 });
  assert.strictEqual(c.running, true);
  assert.strictEqual(c.stale, true);
  assert.strictEqual(c.known, null);
});

test('healthChip: running with nothing known yet is a dash and no bar, not stale', () => {
  const c = healthChip({ state: 'unknown', fraction: null, running: true }, null);
  assert.strictEqual(c.label, '—');
  assert.deepStrictEqual(c.bar, { known: false, px: 0 });
  assert.strictEqual(c.running, true);
  assert.strictEqual(c.stale, false);
});

test('healthChip: unknown and not running is a dash, never shimmering, and keeps nothing', () => {
  const c = healthChip({ state: 'unknown', fraction: null, running: false }, { label: '7/14', fraction: 0.5 });
  assert.strictEqual(c.label, '—');
  assert.strictEqual(c.running, false);
  assert.strictEqual(c.stale, false);
  assert.strictEqual(c.known, null);
});

test('healthChip: a run that finishes replaces the old value', () => {
  const c = healthChip({ state: 'hurt', fraction: 0.9, passed: 9, total: 10, running: false }, { label: '7/14', fraction: 0.5 });
  assert.strictEqual(c.label, '9/10');
  assert.deepStrictEqual(c.known, { label: '9/10', fraction: 0.9 });
});
