'use strict';
/**
 * PROPERTIES of the strip's lane placement (BACKLOG #139, #141, documentation/DESIGN_TAB_STRIP.md).
 *
 * The unit tests (tab-lanes.test.js) pin each rule; these pin what must hold for ANY mix of lanes, widths and orders:
 * a lane that is in neither the strip nor the menu can't be reached, one in both is a tab that opens twice, the selected
 * tab leaving the strip is the page you're looking at disappearing, and develop moving is the one tab the window
 * promises never to lose.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const L = require('../app/tab-lanes');

const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };

// --- arbitraries ---------------------------------------------------------------------------

const phaseArb = fc.constantFrom('live', 'finishing', 'removing', 'remove-failed', 'kept');
const laneArb = (i) => fc.record({
  started: fc.boolean(), starting: fc.boolean(), ended: fc.boolean(), briefing: fc.boolean(),
  phase: phaseArb, badge: fc.constantFrom(null, 'merged', 'warn'),
  setup: fc.constantFrom(null, { running: true }, { running: false, error: 'x' }),
  side: fc.boolean(), shell: fc.boolean(),
}).map(r => ({ key: `lane${i}`, label: `lane${i}`, isDev: false, selected: false, ...r }));

/**
 * A strip model: develop first, 0..12 lanes (each with 0..2 companions), exactly one selected entry (any of them),
 * as app/tab-shell.js entriesWithSides gives it.
 */
const modelArb = fc.tuple(
  fc.integer({ min: 0, max: 12 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => laneArb(i)))),
  fc.nat(),
  fc.boolean(),
).map(([lanes, pick, withDev]) => {
  const entries = [];
  if (withDev) entries.push({ key: 'dev', label: 'develop', isDev: true, selected: false, started: true });
  for (const l of lanes) {
    entries.push({ ...l, side: false, shell: false });
    if (l.side) entries.push({ key: `${l.key}#side`, label: 's', side: true, parentKey: l.key, started: true, selected: false });
    if (l.shell) entries.push({ key: `${l.key}#shell`, label: 'h', shell: true, parentKey: l.key, started: true, selected: false });
  }
  if (entries.length) entries[pick % entries.length].selected = true;
  return entries;
});

const closedArb = fc.array(fc.integer({ min: 0, max: 20 }).map(i => ({ key: `lane${i}`, label: `lane${i}` })), { maxLength: 6 });
const keysOf = (list) => list.map(e => e.key);

// --- placeLanes ----------------------------------------------------------------------------

test('P1: every lane is reachable exactly once, on the strip or as a menu row', () => {
  fc.assert(fc.property(modelArb, closedArb, (entries, closed) => {
    const r = L.placeLanes(entries, closed);
    const lanes = entries.filter(e => !e.side && !e.shell).map(e => e.key);
    const placed = [
      ...keysOf(r.strip).filter(k => lanes.includes(k)),
      ...r.menu.notStarted.map(x => x.key), ...r.menu.merged.map(x => x.key),
    ];
    for (const k of lanes) assert.strictEqual(placed.filter(p => p === k).length, 1, `${k} placed ${placed.filter(p => p === k).length} times`);
    // a closed row is for a lane with no entry, and appears once
    const all = [...r.menu.notStarted, ...r.menu.merged].map(x => x.key);
    assert.strictEqual(new Set(all).size, all.length, 'no menu row repeats');
  }), RUNS);
});

test('P2: the selected entry is always on the strip, and so is develop', () => {
  fc.assert(fc.property(modelArb, (entries) => {
    const r = L.placeLanes(entries, []);
    for (const e of entries) {
      if (e.selected || e.isDev) assert.ok(keysOf(r.strip).includes(e.key), `${e.key} fell off the strip`);
    }
  }), RUNS);
});

test('P3: a companion is on the strip exactly when its lane is, and the strip keeps the model\'s order', () => {
  fc.assert(fc.property(modelArb, (entries) => {
    const r = L.placeLanes(entries, []);
    const onStrip = new Set(keysOf(r.strip));
    for (const e of entries) {
      if (e.side || e.shell) assert.strictEqual(onStrip.has(e.key), onStrip.has(e.parentKey), `${e.key} and ${e.parentKey} disagree`);
    }
    const order = keysOf(entries);
    const idx = keysOf(r.strip).map(k => order.indexOf(k));
    assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b));
  }), RUNS);
});

test('P4: a lane on the strip with nothing running, selected or needing a look can only be there for a companion', () => {
  fc.assert(fc.property(modelArb, (entries) => {
    const r = L.placeLanes(entries, []);
    for (const e of r.strip) {
      if (e.isDev || e.side || e.shell || e.selected || L.isRunning(e)) continue;
      const needs = e.phase === 'removing' || e.badge === 'warn';
      const companion = entries.some(c => (c.side || c.shell) && c.parentKey === e.key);
      assert.ok(needs || companion, `${e.key} sits on the strip for no reason`);
    }
  }), RUNS);
});

// --- splitOverflow -------------------------------------------------------------------------

const capArb = fc.oneof(fc.integer({ min: 0, max: 16 }), fc.constant(Infinity));

test('P5: shown and hidden together are the strip, nothing twice, nothing lost (a hidden lane is whole)', () => {
  fc.assert(fc.property(modelArb, capArb, (entries, cap) => {
    const strip = L.placeLanes(entries, []).strip;
    const { shown, hidden } = L.splitOverflow(strip, cap);
    const hiddenKeys = new Set();
    for (const h of hidden) {
      hiddenKeys.add(h.key);
      for (const c of strip) if ((c.side || c.shell) && c.parentKey === h.key) hiddenKeys.add(c.key);
    }
    const shownKeys = new Set(keysOf(shown));
    assert.strictEqual(shown.length, shownKeys.size, 'a tab shown twice');
    for (const e of strip) assert.strictEqual(shownKeys.has(e.key) !== hiddenKeys.has(e.key), true, `${e.key} is in ${shownKeys.has(e.key) ? 'both' : 'neither'}`);
  }), RUNS);
});

test('P6: the selected tab and develop are never hidden, however small the capacity', () => {
  fc.assert(fc.property(modelArb, capArb, (entries, cap) => {
    const { shown, hidden } = L.splitOverflow(L.placeLanes(entries, []).strip, cap);
    const shownKeys = keysOf(shown);
    for (const e of entries) {
      if (e.selected && shownKeys.length + hidden.length > 0) {
        const lane = e.parentKey || e.key;
        assert.ok(!keysOf(hidden).includes(lane), `${lane} (holding the selected tab) was hidden`);
      }
      if (e.isDev) assert.ok(!keysOf(hidden).includes(e.key), 'develop was hidden');
    }
  }), RUNS);
});

test('P7: shown stays in strip order, and more room never hides more', () => {
  fc.assert(fc.property(modelArb, fc.integer({ min: 0, max: 14 }), (entries, cap) => {
    const strip = L.placeLanes(entries, []).strip;
    const order = keysOf(strip);
    const small = L.splitOverflow(strip, cap);
    const idx = keysOf(small.shown).map(k => order.indexOf(k));
    assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b));
    const big = L.splitOverflow(strip, cap + 1);
    assert.ok(big.hidden.length <= small.hidden.length);
  }), RUNS);
});

test('P8: with room for everything nothing is hidden', () => {
  fc.assert(fc.property(modelArb, (entries) => {
    const strip = L.placeLanes(entries, []).strip;
    assert.deepStrictEqual(L.splitOverflow(strip, strip.length).hidden, []);
  }), RUNS);
});

// --- order ---------------------------------------------------------------------------------

const keyArb = fc.integer({ min: 0, max: 9 }).map(i => `k${i}`);
const orderArb = fc.array(keyArb, { maxLength: 12 });

test('P9: applyOrder is a permutation, idempotent, and an order built from its own output changes nothing', () => {
  fc.assert(fc.property(fc.uniqueArray(keyArb, { maxLength: 10 }), orderArb, (ks, order) => {
    const items = ks.map(key => ({ key }));
    const once = L.applyOrder(items, order);
    assert.deepStrictEqual([...keysOf(once)].sort(), [...ks].sort());
    assert.deepStrictEqual(keysOf(L.applyOrder(once, order)), keysOf(once));
    assert.deepStrictEqual(keysOf(L.applyOrder(items, keysOf(once))), keysOf(once));
  }), RUNS);
});

test('P10: moveKey keeps every key once, puts the key just before its target, and moves nothing else relative to each other', () => {
  fc.assert(fc.property(orderArb, keyArb, fc.option(keyArb, { nil: null }), (order, key, before) => {
    const out = L.moveKey(order, key, before);
    assert.strictEqual(new Set(out).size, out.length, 'a key twice');
    assert.ok(out.includes(key));
    const base = [...new Set(order)];
    for (const k of base) assert.ok(out.includes(k), `${k} lost`);
    // the others keep their relative order
    assert.deepStrictEqual(out.filter(k => k !== key), base.filter(k => k !== key));
    if (before !== null && before !== key && base.includes(before)) assert.strictEqual(out.indexOf(key) + 1, out.indexOf(before));
    if (before === null || !base.includes(before)) assert.strictEqual(out[out.length - 1], key === before ? out[out.length - 1] : key);
  }), RUNS);
});

test('P12: a lane that needs input is never in the Hidden group, at any capacity', () => {
  fc.assert(fc.property(modelArb, fc.array(fc.boolean(), { maxLength: 30 }), capArb, (entries, needs, cap) => {
    const marked = entries.map((e, i) => (needs[i] ? { ...e, needsInput: true } : e));
    const { hidden } = L.splitOverflow(L.placeLanes(marked, []).strip, cap);
    for (const h of hidden) assert.ok(!L.needsYou(h), `${h.key} needs you and was hidden`);
  }), RUNS);
});
