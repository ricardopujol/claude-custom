'use strict';
/**
 * Reading what L1 saved (BACKLOG #22 layout pass L1 -> #53 dockable panels D4). L1's four zones are gone from the
 * page; a layout saved by it (the `layout-global` key, a tab's own override from an older host, the pre-L1
 * `sideTab` / `rosterWidth`) still has to open as the same picture. Only the tree reads these shapes, through
 * app/dock-migrate.js, and these tests pin that the answer is exactly what L1's own normalizer gave, with real
 * saved files as fixtures.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const M = require('../app/dock-migrate');
const ZONES = ['left', 'right', 'top', 'bottom'];
const T = require('../app/dock-tree');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'models', 'projects', 'style'];
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 200 };

// --- normalizeV1 -------------------------------------------------------------------

test('the default L1 layout is today\'s window: everything on the right, 180 wide', () => {
  const l = M.defaultV1(IDS);
  assert.deepStrictEqual(l.zones, { left: [], right: IDS, top: [], bottom: [] });
  assert.deepStrictEqual(l.hidden, []);
  assert.deepStrictEqual(l.size, { left: 180, right: 180, top: 160, bottom: 160 });
});

test('anything that is not a layout object reads as the default', () => {
  for (const raw of [null, undefined, [], 'x', 7, true]) {
    assert.deepStrictEqual(M.normalizeV1(raw, IDS), M.defaultV1(IDS), String(raw));
  }
});

test('a module id this build does not know is dropped, and never blanks its zone', () => {
  // The `fog` tab saved by another branch once emptied the whole sidebar.
  const l = M.normalizeV1({ zones: { left: [], right: ['ghost', 'vault', 'agents'], top: [], bottom: [] } }, IDS);
  assert.ok(!l.zones.right.includes('ghost'));
  assert.deepStrictEqual(l.zones.right.slice(0, 2), ['vault', 'agents']);
});

test('a module listed twice is kept once, in the first zone that lists it', () => {
  const l = M.normalizeV1({ zones: { left: ['vault'], right: ['agents', 'vault'], top: [], bottom: [] }, hidden: ['vault'] }, IDS);
  assert.deepStrictEqual(l.zones.left, ['vault']);
  assert.ok(!l.zones.right.includes('vault'));
  assert.ok(!l.hidden.includes('vault'));
});

test('a module missing everywhere comes back on the right', () => {
  const l = M.normalizeV1({ zones: { left: ['agents'], right: [], top: [], bottom: [] } }, IDS);
  assert.deepStrictEqual(l.zones.left, ['agents']);
  assert.deepStrictEqual(l.zones.right, IDS.filter(id => id !== 'agents'));
});

test('a hidden module stays hidden', () => {
  const l = M.normalizeV1({ zones: { right: ['agents'] }, hidden: ['style'] }, IDS);
  assert.deepStrictEqual(l.hidden, ['style']);
  assert.ok(!l.zones.right.includes('style'));
});

test('a missing or junk size is the default, never 0 (the Number(null) trap)', () => {
  const l = M.normalizeV1({ zones: { right: IDS }, size: { right: null, left: 0, top: '200', bottom: -5 } }, IDS);
  assert.deepStrictEqual(l.size, M.defaultV1(IDS).size);
});

test('a real size is kept, rounded and held to the zone\'s minimum and the 10000 cap', () => {
  const l = M.normalizeV1({ zones: { right: IDS }, size: { right: 240.4, top: 199.6, left: 5e-324, bottom: 1e306 } }, IDS);
  assert.strictEqual(l.size.right, 240);
  assert.strictEqual(l.size.top, 200);
  assert.strictEqual(l.size.left, 120, 'a vanishing size is the side minimum, not 0 (found by L1 P1)');
  assert.strictEqual(l.size.bottom, 10000, 'an absurd size is capped, never NaN (found by L1 P4)');
});

test('reading never changes its input', () => {
  const raw = { zones: { right: ['ghost', 'agents'] }, active: { right: 'ghost' } };
  const copy = JSON.parse(JSON.stringify(raw));
  M.normalizeV1(raw, IDS);
  assert.deepStrictEqual(raw, copy);
});

// --- fromLegacy: the first launch keeps the window as it was (L1 S2) -------------------

test('a window that had a 240 px sidebar opens the same way', () => {
  const l = M.fromLegacy({ sideTab: 'vault', rosterWidth: '240' }, IDS);
  assert.strictEqual(l.size.right, 240);
  assert.deepStrictEqual(l.zones.right, IDS);
});

test('no record, an unknown tab or a junk width give today\'s defaults', () => {
  for (const legacy of [{}, { sideTab: null, rosterWidth: null }, { sideTab: 'ghost', rosterWidth: 'wide' },
    { rosterWidth: '0' }, { rosterWidth: '' }, null]) {
    assert.strictEqual(M.fromLegacy(legacy, IDS).size.right, 180, JSON.stringify(legacy));
  }
});

// --- real saved files, through the tree ------------------------------------------------

// A layout.json L1 wrote for a window that had moved things around (captured from the L1 build's own output
// shape: version 1, four zones, what each shows, hidden, sizes, the Ctrl+B memory).
const SAVED_L1 = {
  version: 1,
  zones: { left: ['vault'], right: ['agents', 'fog'], top: [], bottom: ['bugvault', 'models'] },
  active: { left: 'vault', right: 'fog', top: null, bottom: null },
  hidden: ['style'],
  size: { left: 220, right: 260, top: 160, bottom: 200 },
  restore: null,
};

test('a saved L1 layout opens as col[row[left, terminal, right], bottom] with its sizes and hidden panel', () => {
  const tree = T.readAny(SAVED_L1, IDS);
  assert.deepStrictEqual(tree.root, {
    type: 'split', dir: 'col', sizes: [0, 200], kids: [
      { type: 'split', dir: 'row', sizes: [220, 0, 260], kids: [
        { type: 'group', id: 'left', tabs: ['vault'] },
        { type: 'term' },
        { type: 'group', id: 'right', tabs: ['agents', 'fog', 'projects'] },
      ] },
      { type: 'group', id: 'bottom', tabs: ['bugvault', 'models'] },
    ],
  });
  assert.deepStrictEqual(tree.hidden, ['style']);
  assert.deepStrictEqual(T.normalize(tree, IDS), tree);
});

test('an L1 override from a host started by an older window migrates the same way', () => {
  assert.deepStrictEqual(T.readAny(SAVED_L1, IDS), T.fromV1(SAVED_L1, IDS));
});

test('the pre-L1 settings become the tree an L1 first launch gave', () => {
  const tree = T.fromV1(M.fromLegacy({ sideTab: 'vault', rosterWidth: '300' }, IDS), IDS);
  assert.deepStrictEqual(tree.root.sizes, [0, 300]);
  assert.deepStrictEqual(T.groups(tree).map(g => g.id), ['right']);
});

test('a stored layout that is neither generation is the default tree', () => {
  for (const raw of [null, 'x', 7, [], { version: 3 }, { zones: 'x' }]) {
    assert.deepStrictEqual(T.readAny(raw, IDS), T.defaultLayout(IDS), JSON.stringify(raw));
  }
});

// --- properties --------------------------------------------------------------------------

const junk = fc.constantFrom('ghost', 7, null, undefined, '', {}, [], true);
const idOrJunk = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...IDS) }, { weight: 1, arbitrary: junk });
const tabsArb = fc.array(idOrJunk, { maxLength: 9 });
const sizeArb = fc.oneof(fc.integer({ min: -50, max: 3000 }), fc.double(), fc.constant(null), fc.string(), fc.constant(1e306), fc.constant(5e-324));
const v1Arb = fc.oneof(
  { weight: 8, arbitrary: fc.record({
    zones: fc.oneof(fc.record({ left: tabsArb, right: tabsArb, top: tabsArb, bottom: tabsArb }, { requiredKeys: [] }), junk),
    hidden: fc.oneof(tabsArb, junk),
    size: fc.oneof(fc.record({ left: sizeArb, right: sizeArb, top: sizeArb, bottom: sizeArb }, { requiredKeys: [] }), junk),
  }, { requiredKeys: [] }) },
  { weight: 1, arbitrary: fc.anything() },
);

test('P1: whatever L1 saved, normalizeV1 places every module exactly once, and reading it again changes nothing', () => {
  fc.assert(fc.property(v1Arb, (raw) => {
    const l = M.normalizeV1(raw, IDS);
    const all = [...ZONES.flatMap(z => l.zones[z]), ...l.hidden];
    assert.deepStrictEqual([...all].sort(), [...IDS].sort());
    for (const z of ZONES) assert.ok(Number.isInteger(l.size[z]) && l.size[z] >= (z === 'left' || z === 'right' ? 120 : 80) && l.size[z] <= 10000, `${z} ${l.size[z]}`);
    assert.deepStrictEqual(M.normalizeV1(l, IDS), l);
  }), RUNS);
});

test('P2: whatever L1 saved, readAny gives a whole tree whose zones carry the stored sizes', () => {
  fc.assert(fc.property(v1Arb, (raw) => {
    const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    fc.pre(plain(raw) && plain(raw.zones));
    const l = M.normalizeV1(raw, IDS);
    const tree = T.readAny(raw, IDS);
    assert.deepStrictEqual(T.normalize(tree, IDS), tree);
    assert.strictEqual(T.count(tree, 'term'), 1);
    for (const g of T.groups(tree)) {
      assert.deepStrictEqual(g.tabs, l.zones[g.id], `zone ${g.id}`);
    }
    assert.deepStrictEqual(tree.hidden, l.hidden);
  }), RUNS);
});
