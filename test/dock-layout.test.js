'use strict';
/**
 * The dock layout model (BACKLOG #22, layout pass L1): which module sits in
 * which zone, which one each zone shows, and how big each zone is. Pure, so
 * every rule is pinned here; the page only draws what this returns.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  defaultLayout, normalizeLayout,
} = require('../app/dock-layout');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'models', 'projects', 'style'];

// --- defaultLayout / normalizeLayout ----------------------------------------

test('the default layout is today\'s window: everything on the right, agents showing, 180 wide', () => {
  const l = defaultLayout(IDS);
  assert.deepStrictEqual(l.zones, { left: [], right: IDS, top: [], bottom: [] });
  assert.deepStrictEqual(l.active, { left: null, right: 'agents', top: null, bottom: null });
  assert.deepStrictEqual(l.hidden, []);
  assert.strictEqual(l.size.right, 180);
  assert.strictEqual(l.restore, null);
  assert.strictEqual(l.version, 1);
});

test('anything that is not a layout object normalizes to the default', () => {
  for (const raw of [null, undefined, [], 'x', 7, true]) {
    assert.deepStrictEqual(normalizeLayout(raw, IDS), defaultLayout(IDS), String(raw));
  }
});

test('a module id this build does not know is dropped, and never blanks its zone', () => {
  // The `fog` tab saved by another branch once emptied the whole sidebar.
  const l = normalizeLayout({
    zones: { left: [], right: ['ghost', 'vault', 'agents'], top: [], bottom: [] },
    active: { right: 'ghost' },
  }, IDS);
  assert.ok(!l.zones.right.includes('ghost'));
  assert.strictEqual(l.active.right, 'vault');
});

test('a module listed twice is kept once, in the first zone that lists it', () => {
  const l = normalizeLayout({
    zones: { left: ['vault'], right: ['agents', 'vault'], top: [], bottom: [] },
    hidden: ['vault'],
  }, IDS);
  assert.deepStrictEqual(l.zones.left, ['vault']);
  assert.ok(!l.zones.right.includes('vault'));
  assert.ok(!l.hidden.includes('vault'));
});

test('a module missing everywhere comes back in the right zone', () => {
  const l = normalizeLayout({ zones: { left: ['agents'], right: [], top: [], bottom: [] } }, IDS);
  assert.deepStrictEqual(l.zones.left, ['agents']);
  assert.deepStrictEqual(l.zones.right, IDS.filter(id => id !== 'agents'));
});

test('a hidden module stays hidden', () => {
  const l = normalizeLayout({ zones: { right: ['agents'] }, hidden: ['style'] }, IDS);
  assert.deepStrictEqual(l.hidden, ['style']);
  assert.ok(!l.zones.right.includes('style'));
});

test('a collapsed zone stays collapsed; an invalid showing module falls back to the first', () => {
  const l = normalizeLayout({
    zones: { left: ['vault', 'fog'], right: ['agents'] },
    active: { left: 'agents', right: null },
  }, IDS);
  assert.strictEqual(l.active.left, 'vault');   // agents is not in the left zone
  assert.strictEqual(l.active.right, null);     // collapsed on purpose
});

test('an empty zone shows nothing', () => {
  const l = normalizeLayout({ zones: { right: IDS }, active: { top: 'agents' } }, IDS);
  assert.strictEqual(l.active.top, null);
});

test('a missing or junk size is the default, never 0 (the Number(null) trap)', () => {
  const l = normalizeLayout({ zones: { right: IDS }, size: { right: null, left: 0, top: '200', bottom: -5 } }, IDS);
  assert.deepStrictEqual(l.size, defaultLayout(IDS).size);
});

test('a real size is kept, rounded', () => {
  const l = normalizeLayout({ zones: { right: IDS }, size: { right: 240.4, top: 199.6 } }, IDS);
  assert.strictEqual(l.size.right, 240);
  assert.strictEqual(l.size.top, 200);
});

test('restore keeps only zone -> module-or-null entries', () => {
  const l = normalizeLayout({ zones: { right: IDS }, restore: { right: 'vault', left: 3, nowhere: 'x' } }, IDS);
  assert.deepStrictEqual(l.restore, { left: null, right: 'vault', top: null, bottom: null });
  assert.strictEqual(normalizeLayout({ zones: { right: IDS }, restore: 'x' }, IDS).restore, null);
});

test('normalizing never changes its input', () => {
  const raw = { zones: { right: ['ghost', 'agents'] }, active: { right: 'ghost' } };
  const copy = JSON.parse(JSON.stringify(raw));
  normalizeLayout(raw, IDS);
  assert.deepStrictEqual(raw, copy);
});
