'use strict';
/**
 * PROPERTIES of the dock layout model (layout pass L1, Task 1).
 *
 * The unit tests pin each rule; these pin what must hold after ANY mix of them,
 * starting from ANY stored value -- including one a newer build or another
 * branch wrote. Each property names an invariant the page relies on without
 * checking: a module shown twice or nowhere is a panel that vanishes, and a
 * terminal squeezed under its minimum is the one thing this window is for.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  ZONES, MIN, TERM_MIN, normalizeLayout, selectModule, moveModule, setSize, toggleAll, fitSizes, selectionOf, mergeSelection,
} = require('../app/dock-layout');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'models', 'projects', 'style'];
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };

const junk = fc.constantFrom('ghost', 'fog2', 7, null, undefined, '', {});
const idOrJunk = fc.oneof(fc.constantFrom(...IDS), junk);
const list = fc.array(idOrJunk, { maxLength: 9 });
const perZone = arb => fc.record({ left: arb, right: arb, top: arb, bottom: arb }, { requiredKeys: [] });
const sizeArb = fc.oneof(fc.integer({ min: -50, max: 3000 }), fc.double(), fc.constant(null), fc.string());

// A stored value: sometimes a well-formed layout, often a damaged one, sometimes not an object at all.
const rawArb = fc.oneof(
  fc.record({
    zones: perZone(list),
    active: perZone(fc.oneof(idOrJunk, fc.constant(null))),
    hidden: list,
    size: perZone(sizeArb),
    restore: fc.oneof(fc.constant(null), perZone(fc.oneof(idOrJunk, fc.constant(null)))),
  }, { requiredKeys: [] }),
  fc.anything(),
);

const opArb = fc.oneof(
  fc.record({ op: fc.constant('select'), id: idOrJunk }),
  fc.record({ op: fc.constant('move'), id: idOrJunk, target: fc.constantFrom(...ZONES, 'hide', 'middle') }),
  fc.record({ op: fc.constant('toggle') }),
  fc.record({ op: fc.constant('size'), zone: fc.constantFrom(...ZONES, 'middle'), px: sizeArb }),
);
const opsArb = fc.array(opArb, { maxLength: 30, size: 'medium' });

function run(layout, ops) {
  let l = layout;
  for (const o of ops) {
    if (o.op === 'select') l = selectModule(l, o.id);
    else if (o.op === 'move') l = moveModule(l, o.id, o.target);
    else if (o.op === 'toggle') l = toggleAll(l);
    else l = setSize(l, o.zone, o.px);
  }
  return l;
}

function assertWellFormed(l) {
  // P2: every module exactly once across the zones and the hidden list.
  const all = [...ZONES.flatMap(z => l.zones[z]), ...l.hidden];
  assert.deepStrictEqual([...all].sort(), [...IDS].sort());
  // P3: a zone shows nothing or one of its own modules; an empty zone shows nothing.
  for (const z of ZONES) {
    const a = l.active[z];
    assert.ok(a === null || l.zones[z].includes(a), `${z} shows ${a}`);
    if (!l.zones[z].length) assert.strictEqual(a, null, z);
  }
}

test('P1: normalizing a normalized layout changes nothing', () => {
  fc.assert(fc.property(rawArb, raw => {
    const once = normalizeLayout(raw, IDS);
    assert.deepStrictEqual(normalizeLayout(once, IDS), once);
  }), RUNS);
});

test('P2 + P3: any stored value, then any mix of operations, stays well formed', () => {
  fc.assert(fc.property(rawArb, opsArb, (raw, ops) => {
    const l = run(normalizeLayout(raw, IDS), ops);
    assertWellFormed(l);
    assert.deepStrictEqual(normalizeLayout(l, IDS), l, 'an operation returned a layout normalize would change');
  }), RUNS);
});

test('P4: in any window at least the minimum size, the terminal keeps its room and every open zone its minimum', () => {
  const viewport = fc.record({
    width: fc.integer({ min: TERM_MIN.width + 2 * MIN.side, max: 4000 }),
    height: fc.integer({ min: TERM_MIN.height + 2 * MIN.wide, max: 2500 }),
  });
  fc.assert(fc.property(rawArb, opsArb, viewport, (raw, ops, vp) => {
    const l = run(normalizeLayout(raw, IDS), ops);
    const s = fitSizes(l, vp);
    assert.ok(s.left + s.right + TERM_MIN.width <= vp.width, `width ${JSON.stringify(s)} in ${vp.width}`);
    assert.ok(s.top + s.bottom + TERM_MIN.height <= vp.height, `height ${JSON.stringify(s)} in ${vp.height}`);
    for (const z of ZONES) {
      if (l.active[z] !== null) assert.ok(s[z] >= (z === 'left' || z === 'right' ? MIN.side : MIN.wide), z);
    }
  }), RUNS);
});

test('P5: Ctrl+B twice gives back what was showing', () => {
  fc.assert(fc.property(rawArb, opsArb, (raw, ops) => {
    const l = run(normalizeLayout(raw, IDS), ops);
    fc.pre(ZONES.some(z => l.active[z] !== null));
    assert.deepStrictEqual(toggleAll(toggleAll(l)).active, l.active);
  }), RUNS);
});

test('P6: another window\'s placement drawn with this window\'s selection (stored, or junk) stays well formed', () => {
  const selArb = fc.oneof(
    fc.record({
      active: perZone(fc.oneof(idOrJunk, fc.constant(null))),
      collapsed: perZone(fc.oneof(fc.boolean(), junk)),
      restore: fc.oneof(fc.constant(null), perZone(fc.oneof(idOrJunk, fc.constant(null)))),
    }, { requiredKeys: [] }),
    fc.anything(),
  );
  fc.assert(fc.property(rawArb, opsArb, rawArb, opsArb, selArb, (rawA, opsA, rawB, opsB, junkSel) => {
    const theirs = run(normalizeLayout(rawA, IDS), opsA);
    const mineLayout = run(normalizeLayout(rawB, IDS), opsB);
    for (const sel of [selectionOf(mineLayout), junkSel]) {
      const l = mergeSelection(theirs, sel, IDS);
      assertWellFormed(l);
      assert.deepStrictEqual(l.zones, theirs.zones, 'the selection never moves a module');
      assert.deepStrictEqual(l.hidden, theirs.hidden);
    }
  }), RUNS);
});

test('P7 (Dexter F7, terminal wins): in ANY window with room for the rails, the terminal keeps its minimum', () => {
  const viewport = fc.record({
    width: fc.integer({ min: TERM_MIN.width + 2 * 28, max: 4000 }),
    height: fc.integer({ min: TERM_MIN.height + 2 * 30, max: 2500 }),
  });
  fc.assert(fc.property(rawArb, opsArb, viewport, (raw, ops, vp) => {
    const s = fitSizes(run(normalizeLayout(raw, IDS), ops), vp);
    assert.ok(s.left + s.right + TERM_MIN.width <= vp.width, `width ${JSON.stringify(s)} in ${vp.width}`);
    assert.ok(s.top + s.bottom + TERM_MIN.height <= vp.height, `height ${JSON.stringify(s)} in ${vp.height}`);
  }), RUNS);
});
