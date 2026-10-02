'use strict';
/**
 * BACKLOG #27: app/status-fields-display.js -- the tab header's copy of the
 * CLI status row, in warpaint's formats (warpaint\src\statusline.js), so moving
 * the row changes where it is, not what it says.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { statusFieldsText } = require('../app/status-fields-display');

const fields = (o) => ({ costUsd: null, durationMs: null, linesAdded: null, linesRemoved: null, over200k: null, ...o });

test('null or not an object -> nothing (unknown draws nothing, never "$0")', () => {
  assert.deepStrictEqual(statusFieldsText(null), []);
  assert.deepStrictEqual(statusFieldsText(undefined), []);
  assert.deepStrictEqual(statusFieldsText('x'), []);
  assert.deepStrictEqual(statusFieldsText(fields({})), []);
});

test('warpaint parity: cost, lines, duration, ctx>200k in that order', () => {
  assert.deepStrictEqual(
    statusFieldsText(fields({ costUsd: 1.234, durationMs: 3_900_000, linesAdded: 10, linesRemoved: 2, over200k: true })),
    ['$1.23', '+10/-2', '1h05', 'ctx>200k']);
});

test('warpaint parity: tiny cost, under a minute, zero lines', () => {
  assert.deepStrictEqual(
    statusFieldsText(fields({ costUsd: 0.004, durationMs: 59_000, linesAdded: 0, linesRemoved: 0, over200k: false })),
    ['<$0.01']);
});

test('warpaint parity: cost 0 hidden, one side of the lines, minutes', () => {
  assert.deepStrictEqual(statusFieldsText(fields({ costUsd: 0, durationMs: 600_000, linesRemoved: 5 })), ['-5', '10m']);
  assert.deepStrictEqual(statusFieldsText(fields({ linesAdded: 7 })), ['+7']);
});

test('property: no segment is ever a zero ("$0", "$0.00", "0m", "+0", "-0")', () => {
  const v = fc.oneof(fc.constant(null), fc.constant(0), fc.double({ min: 0, max: 1e7, noNaN: true }), fc.nat());
  fc.assert(fc.property(v, v, v, v, fc.oneof(fc.constant(null), fc.boolean()), (c, d, a, r, o) => {
    const out = statusFieldsText({ costUsd: c, durationMs: d, linesAdded: a, linesRemoved: r, over200k: o });
    for (const s of out) assert.ok(!/^\$0(\.00)?$|^0m$|(^|\/)[+-]0$/.test(s), s);
  }));
});

test('property: junk never throws and never yields an empty or non-string segment', () => {
  const junk = fc.anything();
  fc.assert(fc.property(junk, junk, junk, junk, junk, (c, d, a, r, o) => {
    const out = statusFieldsText({ costUsd: c, durationMs: d, linesAdded: a, linesRemoved: r, over200k: o });
    assert.ok(Array.isArray(out));
    for (const s of out) assert.ok(typeof s === 'string' && s.length > 0);
  }));
});
