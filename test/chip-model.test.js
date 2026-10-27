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
