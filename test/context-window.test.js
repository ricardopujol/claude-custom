'use strict';
/**
 * BACKLOG #6 -- the context-fill indicator's host half: readContext
 * (host/hook-session.js).
 *
 * MEASURED (verify/probe-context-window.js, claude 2.1.284): the statusLine
 * document carries
 *   context_window: { total_input_tokens: number, total_output_tokens: number,
 *                     context_window_size: number (200000, or 1000000 after
 *                     /model sonnet[1m]), current_usage: null,
 *                     used_percentage: null, remaining_percentage: null }
 * and BEFORE the first turn used_percentage is null, not 0. That null is the
 * whole reason for this file: `Number(null)` is 0, and a coercing reader turns
 * "the CLI has not counted yet" into a confident 0% grey circle.
 *
 * NOT MEASURED (a billed turn): the populated forms. The `current_usage` field
 * names below come from Claude Code's statusLine documentation. The tests pin
 * the policy that FAILS TOWARD UNKNOWN when the shape is not what was expected.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { readContext } = require('../host/hook-session');

const doc = (cw) => ({ model: { id: 'claude-opus-5-5' }, context_window: cw });
const fresh = { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 200000,
  current_usage: null, used_percentage: null, remaining_percentage: null };
const usage = (i, c, r) => ({ input_tokens: i, output_tokens: 7, cache_creation_input_tokens: c, cache_read_input_tokens: r });

test('readContext: the measured fresh-session document is unknown (used_percentage is null)', () => {
  assert.strictEqual(readContext(doc(fresh)), null);
});

test('readContext: a percentage of the window becomes used tokens of that size', () => {
  assert.deepStrictEqual(readContext(doc({ ...fresh, used_percentage: 20 })), { used: 40000, size: 200000 });
  assert.deepStrictEqual(readContext(doc({ ...fresh, context_window_size: 1000000, used_percentage: 62 })),
    { used: 620000, size: 1000000 });
});

test('readContext: the size is the model\'s own window, never a constant', () => {
  const a = readContext(doc({ ...fresh, context_window_size: 200000, used_percentage: 50 }));
  const b = readContext(doc({ ...fresh, context_window_size: 1000000, used_percentage: 50 }));
  assert.strictEqual(a.size, 200000);
  assert.strictEqual(b.size, 1000000);
});

test('readContext: more than 100% is reported as it is, not clamped here', () => {
  assert.deepStrictEqual(readContext(doc({ ...fresh, used_percentage: 110 })), { used: 220000, size: 200000 });
});

test('readContext: absence is never coerced (Number(null) is 0)', () => {
  const bad = [undefined, null, '', '50', 'x', -1, NaN, Infinity, -Infinity, true, {}, []];
  for (const v of bad) {
    assert.strictEqual(readContext(doc({ ...fresh, used_percentage: v })), null, `used_percentage ${String(v)}`);
  }
  for (const v of [undefined, null, '', '200000', 0, -1, NaN, Infinity, true, {}, []]) {
    assert.strictEqual(readContext(doc({ ...fresh, used_percentage: 10, context_window_size: v })), null, `size ${String(v)}`);
  }
});

test('readContext: a document that is not an object, or has no context_window, is null', () => {
  for (const d of [undefined, null, 'x', 5, [], {}, { context_window: null }, { context_window: 'x' }, { context_window: [] }]) {
    assert.strictEqual(readContext(d), null, JSON.stringify(d));
  }
});

// --- the zero policy (Dexter F5, Miguel S1): a COUNTED zero is a known empty
// context, not "unknown". Only size stays strictly positive.
test('zero policy: used_percentage 0 is a counted, empty context -- known, used 0', () => {
  assert.deepStrictEqual(readContext(doc({ ...fresh, used_percentage: 0 })), { used: 0, size: 200000 });
});

test('zero policy: a current_usage that sums to 0 is a known empty context', () => {
  assert.deepStrictEqual(readContext(doc({ ...fresh, current_usage: usage(0, 0, 0) })), { used: 0, size: 200000 });
});

test('zero policy: a tiny percentage rounds to 0 tokens and is still KNOWN (the CLI did count)', () => {
  assert.deepStrictEqual(readContext(doc({ ...fresh, used_percentage: 1e-9 })), { used: 0, size: 200000 });
});

test('zero policy: the window size must still be strictly positive', () => {
  assert.strictEqual(readContext(doc({ ...fresh, context_window_size: 0, used_percentage: 0 })), null);
  assert.strictEqual(readContext(doc({ ...fresh, context_window_size: 0, current_usage: usage(0, 0, 0) })), null);
});

// --- absolute counts win (Dexter F1/F2): a wrong percent scale paints a
// confident wrong colour; an absent object paints unknown.
test('current_usage: the absolute count is input + cache_creation + cache_read (output is not context)', () => {
  assert.deepStrictEqual(readContext(doc({ ...fresh, current_usage: usage(1000, 20000, 103000) })),
    { used: 124000, size: 200000 });
});

test('current_usage wins over used_percentage when both are present and well-formed', () => {
  // A wrong-scale percentage (0.5 instead of 50) must not be able to paint anything.
  const r = readContext(doc({ ...fresh, current_usage: usage(100000, 0, 0), used_percentage: 0.5 }));
  assert.deepStrictEqual(r, { used: 100000, size: 200000 });
});

test('current_usage is divided by the CURRENT window, so a mid-session /model follows the new size', () => {
  const cu = usage(0, 0, 180000);
  assert.deepStrictEqual(readContext(doc({ ...fresh, context_window_size: 1000000, current_usage: cu })), { used: 180000, size: 1000000 });
  assert.deepStrictEqual(readContext(doc({ ...fresh, context_window_size: 200000, current_usage: cu, used_percentage: 18 })),
    { used: 180000, size: 200000 });
});

test('current_usage ill-formed or absent falls through to used_percentage, never coerces', () => {
  const pct = { used_percentage: 20 };
  const ill = [null, undefined, 5, 'x', [], {}, usage(1, 2, null), usage(1, 2, undefined), usage(1, 2, '3'),
    usage(1, 2, -3), usage(1, NaN, 3), usage(Infinity, 2, 3), usage(true, 2, 3),
    { input_tokens: 1, cache_creation_input_tokens: 2 }];
  for (const cu of ill) {
    assert.deepStrictEqual(readContext(doc({ ...fresh, ...pct, current_usage: cu })), { used: 40000, size: 200000 }, JSON.stringify(cu));
    assert.strictEqual(readContext(doc({ ...fresh, current_usage: cu })), null, `no percent either: ${JSON.stringify(cu)}`);
  }
});

test('current_usage: a summed count that overflows to Infinity is unknown, not known', () => {
  assert.strictEqual(readContext(doc({ ...fresh, current_usage: usage(1.7e308, 1.7e308, 0) })), null);
});

// --- trust rule (Dexter F6): the same as readStatus -- no model.id, no trust.
test('a document with no model.id is not trusted (matches readStatus)', () => {
  const cw = { ...fresh, used_percentage: 50 };
  for (const d of [{ context_window: cw }, { model: null, context_window: cw }, { model: {}, context_window: cw },
    { model: { id: '' }, context_window: cw }, { model: { id: 5 }, context_window: cw }]) {
    assert.strictEqual(readContext(d), null, JSON.stringify(d));
  }
  assert.deepStrictEqual(readContext({ model: { id: 'x' }, context_window: cw }), { used: 100000, size: 200000 });
});

const numArb = fc.oneof(fc.constant(undefined), fc.constant(null), fc.string(), fc.boolean(),
  fc.double({ noNaN: false }), fc.integer());

test('property: readContext is total, and any non-null answer is a finite used >= 0 over a finite positive size', () => {
  fc.assert(fc.property(numArb, numArb, numArb, (pct, size, tok) => {
    const r = readContext(doc({ used_percentage: pct, context_window_size: size, current_usage: usage(tok, tok, tok) }));
    if (r === null) return true;
    return Number.isFinite(r.used) && r.used >= 0 && Number.isFinite(r.size) && r.size > 0 && typeof size === 'number';
  }));
});

test('property: a document missing the size, or with nothing countable, is null', () => {
  fc.assert(fc.property(fc.double({ min: 0.5, max: 300, noNaN: true }), fc.integer({ min: 1000, max: 2000000 }), (pct, size) => {
    assert.ok(readContext(doc({ used_percentage: pct, context_window_size: size })) !== null);
    assert.strictEqual(readContext(doc({ used_percentage: pct })), null);
    assert.strictEqual(readContext(doc({ context_window_size: size })), null);
  }));
});
