'use strict';
/**
 * BACKLOG #6 -- app/context-fill-display.js: the coloured circle that steps at
 * 1/5, 2/5, 3/5, 4/5 of the model's context window.
 *
 * The trap this exists to pin is `Number(null)` being 0: a count the CLI has
 * not reported must draw as UNKNOWN (a hollow dashed circle with its own
 * class), never as a confident grey/green.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { contextFill, titleFor, PALETTE, UNKNOWN_CLASS, STEP_CLASSES } = require('../app/context-fill-display');

const at = (fraction, size = 200000) => contextFill({ used: fraction * size, size });

test('the palette is grey, green, yellow, orange, red -- five distinct steps', () => {
  assert.strictEqual(PALETTE.length, 5);
  assert.strictEqual(new Set(PALETTE).size, 5);
  assert.deepStrictEqual(STEP_CLASSES, ['ctx-0', 'ctx-1', 'ctx-2', 'ctx-3', 'ctx-4']);
});

test('boundaries are exact: 0.2 / 0.4 / 0.6 / 0.8 belong to the step ABOVE', () => {
  const cases = [[0.0001, 0], [0.1999, 0], [0.2, 1], [0.3999, 1], [0.4, 2], [0.5999, 2],
    [0.6, 3], [0.7999, 3], [0.8, 4], [0.9999, 4], [1, 4]];
  for (const [f, step] of cases) {
    const r = at(f);
    assert.strictEqual(r.state, 'known', String(f));
    assert.strictEqual(r.step, step, `fraction ${f}`);
    assert.strictEqual(r.colour, PALETTE[step]);
  }
});

test('boundaries stay exact on integer token counts (no float drift at 20% of 200k)', () => {
  assert.strictEqual(contextFill({ used: 40000, size: 200000 }).step, 1);
  assert.strictEqual(contextFill({ used: 39999, size: 200000 }).step, 0);
  assert.strictEqual(contextFill({ used: 160000, size: 200000 }).step, 4);
  assert.strictEqual(contextFill({ used: 159999, size: 200000 }).step, 3);
  assert.strictEqual(contextFill({ used: 600000, size: 1000000 }).step, 3);
  assert.strictEqual(contextFill({ used: 199999, size: 1000000 }).step, 0);
});

test('fractions are of the model\'s ACTUAL window, not a hardcoded one', () => {
  assert.strictEqual(contextFill({ used: 250000, size: 200000 }).step, 4);
  assert.strictEqual(contextFill({ used: 250000, size: 1000000 }).step, 1);
});

test('over 100% clamps to the last step, but the numbers stay real', () => {
  const r = contextFill({ used: 250000, size: 200000 });
  assert.strictEqual(r.step, 4);
  assert.strictEqual(r.fraction, 1.25);
  assert.strictEqual(titleFor(r), 'context: 250,000 / 200,000 (125%)');
});

test('titleFor: thousands separators, whole percent; unknown says so', () => {
  assert.strictEqual(titleFor(contextFill({ used: 123456, size: 200000 })), 'context: 123,456 / 200,000 (62%)');
  assert.strictEqual(titleFor(contextFill(null)), 'context: unknown');
  assert.strictEqual(titleFor(undefined), 'context: unknown');
  assert.strictEqual(titleFor({ state: 'unknown' }), 'context: unknown');
});

test('unknown: null, missing, zero, negative, NaN, strings -- never a colour', () => {
  const bad = [null, undefined, 5, 'x', [], {}, { used: 1 }, { size: 1 }, { used: null, size: 200000 },
    { used: 5, size: null }, { used: 0, size: 200000 }, { used: 5, size: 0 }, { used: -5, size: 200000 },
    { used: 5, size: -200000 }, { used: NaN, size: 200000 }, { used: 5, size: Infinity },
    { used: Infinity, size: 200000 }, { used: '5', size: 200000 }, { used: 5, size: '200000' },
    { used: true, size: 200000 }];
  for (const c of bad) {
    const r = contextFill(c);
    assert.deepStrictEqual(r, { state: 'unknown' }, JSON.stringify(c));
  }
});

test('property: step is monotone non-decreasing in fraction, within 0..4', () => {
  fc.assert(fc.property(fc.double({ min: 1e-6, max: 3, noNaN: true }), fc.double({ min: 1e-6, max: 3, noNaN: true }), (a, b) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const s1 = at(lo).step;
    const s2 = at(hi).step;
    return s1 <= s2 && s1 >= 0 && s2 <= 4;
  }));
});

test('property: any non-finite or non-positive input is unknown, and unknown has no palette colour', () => {
  const badNum = fc.oneof(fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity), fc.constant(0),
    fc.double({ max: 0, noNaN: true }), fc.constant(null), fc.constant(undefined), fc.string());
  const good = fc.integer({ min: 1, max: 2000000 });
  fc.assert(fc.property(badNum, good, (bad, ok) => {
    for (const c of [{ used: bad, size: ok }, { used: ok, size: bad }, { used: bad, size: bad }]) {
      const r = contextFill(c);
      if (r.state !== 'unknown') return false;
      if ('colour' in r || 'step' in r || PALETTE.includes(r.colour)) return false;
    }
    return true;
  }));
});

test('property: a known fill always has fraction = used / size and a palette colour', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 3000000 }), fc.integer({ min: 1, max: 2000000 }), (used, size) => {
    const r = contextFill({ used, size });
    return r.state === 'known' && r.fraction === used / size && r.colour === PALETTE[r.step]
      && r.used === used && r.size === size;
  }));
});

test('the unknown class is not one of the five step classes', () => {
  assert.ok(!STEP_CLASSES.includes(UNKNOWN_CLASS));
  assert.match(UNKNOWN_CLASS, /unknown/);
});
