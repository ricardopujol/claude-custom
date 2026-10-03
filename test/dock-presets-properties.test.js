'use strict';
/**
 * PROPERTIES of the preset list (BACKLOG #53, D3). The examples in dock-presets.test.js pin each rule; these
 * pin what must hold after ANY mix of operations starting from ANY stored value: names stay unique ignoring
 * case, the list never passes 32, and nothing a damaged file holds can make a function throw.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const P = require('../app/dock-presets');

const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };

const nameArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('Review', 'review', 'REVIEW', 'Writing', 'writing', 'A', 'a', ' Pad ', 'Pad') },
  { weight: 2, arbitrary: fc.string({ maxLength: 50 }) },
  { weight: 1, arbitrary: fc.constantFrom(null, undefined, 7, {}, [], '') },
);
const layoutArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ version: fc.constant(2), hidden: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }) }) },
  { weight: 1, arbitrary: fc.constantFrom(null, 'x', 7, [], undefined) },
);
const entryArb = fc.oneof(
  { weight: 4, arbitrary: fc.record({ name: nameArb, layout: layoutArb }, { requiredKeys: [] }) },
  { weight: 1, arbitrary: fc.anything() },
);
const rawArb = fc.oneof(fc.array(entryArb, { maxLength: 45 }), fc.anything());

const keyOf = n => n.toLowerCase();
function uniqueAndBounded(list) {
  assert.ok(Array.isArray(list));
  assert.ok(list.length <= P.MAX_PRESETS, `length ${list.length}`);
  const keys = list.map(p => keyOf(p.name));
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate names in ${JSON.stringify(keys)}`);
  for (const p of list) assert.strictEqual(P.checkName(p.name), p.name, 'every stored name is already clean');
}

test('P1: cleanPresets never throws, and its result is unique, bounded and clean', () => {
  fc.assert(fc.property(rawArb, (raw) => { uniqueAndBounded(P.cleanPresets(raw)); }), RUNS);
});

test('P2: cleanPresets is idempotent', () => {
  fc.assert(fc.property(rawArb, (raw) => {
    const once = P.cleanPresets(raw);
    assert.deepStrictEqual(P.cleanPresets(once), once);
  }), RUNS);
});
