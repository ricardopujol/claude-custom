'use strict';
/**
 * BACKLOG #27: host/hook-session.js readStatusFields -- what the CLI's status
 * row showed that the tab header doesn't yet (cost, lines, duration,
 * ctx>200k), read off the statusLine document. Absent is null, never 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { readStatusFields } = require('../host/hook-session');

// MEASURED, verify/probe-footer-rows.js (claude 2.1.287), before any turn.
const MEASURED = {
  model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
  cost: { total_cost_usd: 0, total_duration_ms: 2478, total_api_duration_ms: 0,
    total_lines_added: 0, total_lines_removed: 0 },
  exceeds_200k_tokens: false,
};

test('the measured pre-turn document reads as counted zeros, not unknowns', () => {
  assert.deepStrictEqual(readStatusFields(MEASURED),
    { costUsd: 0, durationMs: 2478, linesAdded: 0, linesRemoved: 0, over200k: false });
});

test('no model id -> null (the trust rule of readStatus / readContext)', () => {
  assert.strictEqual(readStatusFields({ cost: MEASURED.cost }), null);
  assert.strictEqual(readStatusFields({ model: { id: '' }, cost: MEASURED.cost }), null);
  assert.strictEqual(readStatusFields(null), null);
  assert.strictEqual(readStatusFields('x'), null);
});

test('absent or malformed fields are null, never 0 (the Number(null) trap)', () => {
  assert.deepStrictEqual(
    readStatusFields({ model: { id: 'm' }, cost: { total_cost_usd: null, total_lines_added: '3' } }),
    { costUsd: null, durationMs: null, linesAdded: null, linesRemoved: null, over200k: null });
  assert.deepStrictEqual(readStatusFields({ model: { id: 'm' }, cost: 'nope', exceeds_200k_tokens: 'yes' }),
    { costUsd: null, durationMs: null, linesAdded: null, linesRemoved: null, over200k: null });
});

test('property: every count is null or a finite number >= 0, over200k null or boolean', () => {
  const junk = fc.oneof(fc.constant(null), fc.constant(undefined), fc.double(), fc.integer(),
    fc.string(), fc.boolean(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-1));
  fc.assert(fc.property(junk, junk, junk, junk, junk, (c, d, a, r, o) => {
    const out = readStatusFields({ model: { id: 'm' }, exceeds_200k_tokens: o,
      cost: { total_cost_usd: c, total_duration_ms: d, total_lines_added: a, total_lines_removed: r } });
    for (const k of ['costUsd', 'durationMs', 'linesAdded', 'linesRemoved']) {
      const v = out[k];
      assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0), `${k}=${v}`);
    }
    assert.ok(out.over200k === null || typeof out.over200k === 'boolean');
  }));
});

test('property: a well-formed value passes through unchanged', () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.nat(), fc.nat(), fc.nat(), fc.boolean(),
    (c, d, a, r, o) => {
      const out = readStatusFields({ model: { id: 'm' }, exceeds_200k_tokens: o,
        cost: { total_cost_usd: c, total_duration_ms: d, total_lines_added: a, total_lines_removed: r } });
      assert.deepStrictEqual(out, { costUsd: c, durationMs: d, linesAdded: a, linesRemoved: r, over200k: o });
    }));
});
