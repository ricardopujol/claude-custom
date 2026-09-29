'use strict';
/**
 * BACKLOG #6 -- the context-fill indicator's host half: readContext
 * (host/hook-session.js) and its wiring in host/host.js.
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
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { readContext } = require('../host/hook-session');

const doc = (cw) => ({ model: { id: 'claude-opus-5-5' }, context_window: cw });
const fresh = { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 200000,
  current_usage: null, used_percentage: null, remaining_percentage: null };

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
  const bad = [undefined, null, '', '50', 'x', 0, -1, NaN, Infinity, -Infinity, true, {}, []];
  for (const v of bad) {
    assert.strictEqual(readContext(doc({ ...fresh, used_percentage: v })), null, `used_percentage ${String(v)}`);
    assert.strictEqual(readContext(doc({ ...fresh, used_percentage: 10, context_window_size: v })), null, `size ${String(v)}`);
  }
});

test('readContext: a document that is not an object, or has no context_window, is null', () => {
  for (const d of [undefined, null, 'x', 5, [], {}, { context_window: null }, { context_window: 'x' }, { context_window: [] }]) {
    assert.strictEqual(readContext(d), null, JSON.stringify(d));
  }
});

test('readContext: a percentage that rounds to zero tokens is unknown, not zero', () => {
  assert.strictEqual(readContext(doc({ ...fresh, used_percentage: 1e-9 })), null);
});

const numArb = fc.oneof(fc.constant(undefined), fc.constant(null), fc.string(), fc.boolean(),
  fc.double({ noNaN: false }), fc.integer());

test('property: readContext is total, and any non-null answer is two finite positive numbers', () => {
  fc.assert(fc.property(numArb, numArb, (pct, size) => {
    const r = readContext(doc({ used_percentage: pct, context_window_size: size }));
    if (r === null) return true;
    return Number.isFinite(r.used) && r.used > 0 && Number.isFinite(r.size) && r.size > 0
      && typeof pct === 'number' && typeof size === 'number';
  }));
});

test('property: a document missing either field is null', () => {
  fc.assert(fc.property(fc.double({ min: 0.5, max: 300, noNaN: true }), fc.integer({ min: 1000, max: 2000000 }), (pct, size) => {
    assert.ok(readContext(doc({ used_percentage: pct, context_window_size: size })) !== null);
    assert.strictEqual(readContext(doc({ context_window_size: size })), null);
    assert.strictEqual(readContext(doc({ used_percentage: pct })), null);
  }));
});
