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

const keyOf = P.nameKey;
function uniqueAndBounded(list, bound = P.MAX_PRESETS) {
  assert.ok(Array.isArray(list));
  assert.ok(list.length <= bound, `length ${list.length}`);
  const keys = list.map(p => keyOf(p.name));
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate names in ${JSON.stringify(keys)}`);
  for (const p of list) assert.strictEqual(P.checkName(p.name), p.name, 'every stored name is already clean');
}

test('P1: cleanPresets never throws, and its result is unique, bounded and clean', () => {
  fc.assert(fc.property(rawArb, (raw) => { uniqueAndBounded(P.cleanPresets(raw), Array.isArray(raw) ? raw.length : 0); }), RUNS);
});

test('P2: cleanPresets is idempotent', () => {
  fc.assert(fc.property(rawArb, (raw) => {
    const once = P.cleanPresets(raw);
    assert.deepStrictEqual(P.cleanPresets(once), once);
  }), RUNS);
});

const opArb = fc.oneof(
  fc.record({ op: fc.constant('save'), name: nameArb, layout: layoutArb, replace: fc.boolean() }),
  fc.record({ op: fc.constant('rename'), from: nameArb, to: nameArb }),
  fc.record({ op: fc.constant('delete'), name: nameArb }),
);
function run(list, o) {
  if (o.op === 'save') return P.savePreset(list, o.name, o.layout, { replace: o.replace });
  if (o.op === 'rename') return P.renamePreset(list, o.from, o.to);
  return P.deletePreset(list, o.name);
}

test('P3: after ANY sequence of operations from ANY start, names are unique, the list is within 32, nothing throws', () => {
  fc.assert(fc.property(rawArb, fc.array(opArb, { maxLength: 80 }), (raw, ops) => {
    let list = P.cleanPresets(raw).slice(0, P.MAX_PRESETS);
    for (const o of ops) {
      const before = JSON.stringify(list);
      const r = run(list, o);
      assert.strictEqual(JSON.stringify(list), before, 'an operation never changes the list it was given');
      if (r.ok) { uniqueAndBounded(r.list); list = r.list; }
      else assert.ok(['name', 'taken', 'full', 'missing', 'layout'].includes(r.reason), String(r.reason));
    }
  }), RUNS);
});

test('P6: over the STORED array, an operation changes at most the one entry it names: every other entry comes back as it was', () => {
  fc.assert(fc.property(fc.array(entryArb, { maxLength: 20 }), opArb, (stored, o) => {
    const before = JSON.stringify(stored);
    const r = run(stored, o);
    assert.strictEqual(JSON.stringify(stored), before, 'the input is untouched');
    if (!r.ok) return;
    const rest = r.list.filter(e => !stored.includes(e));          // entries that are new or rewritten
    assert.ok(rest.length <= 1, `${rest.length} entries changed`);
    const gone = stored.filter(e => !r.list.includes(e));
    assert.ok(gone.length <= 1, `${gone.length} entries lost`);
    assert.ok(Math.abs(r.list.length - stored.length) <= 1);
  }), RUNS);
});

test('P5: a name saved in one normalization form is `taken` in the other, and one name is judged the same in both', () => {
  fc.assert(fc.property(fc.string({ maxLength: 50 }), fc.constantFrom('NFC', 'NFD'), (name, form) => {
    const first = P.savePreset([], name.normalize('NFC'), { version: 2 });
    const other = name.normalize(form === 'NFC' ? 'NFD' : 'NFC');
    assert.strictEqual(P.checkName(name.normalize('NFC')) === null, P.checkName(other) === null, 'accepted or refused alike');
    if (!first.ok) return;
    assert.deepStrictEqual(P.savePreset(first.list, other, { version: 2 }), { ok: false, reason: 'taken' });
  }), RUNS);
});

test('P4: whatever a save accepts can be found again by the name it was saved under, with the layout it was saved with', () => {
  fc.assert(fc.property(rawArb, nameArb, layoutArb, (raw, name, layout) => {
    const r = P.savePreset(P.cleanPresets(raw), name, layout, { replace: true });
    if (!r.ok) return;
    const got = P.find(r.list, name);
    assert.ok(got, 'a saved preset can be found by the name it was saved under');
    assert.deepStrictEqual(got.layout, JSON.parse(JSON.stringify(layout)));
  }), RUNS);
});
