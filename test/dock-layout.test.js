'use strict';
/**
 * The dock layout model (BACKLOG #22, layout pass L1): which module sits in
 * which zone, which one each zone shows, and how big each zone is. Pure, so
 * every rule is pinned here; the page only draws what this returns.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  ZONES, MIN, RAIL, TERM_MIN, defaultLayout, normalizeLayout, fromLegacy, selectModule, moveModule, setSize, toggleAll,
  fitSizes, shapeOf,
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

// --- fromLegacy: the first launch keeps the window as it was (S2) -----------

test('a window that showed the vault at 240 px opens the same way', () => {
  const l = fromLegacy({ sideTab: 'vault', rosterWidth: '240' }, IDS);
  assert.strictEqual(l.active.right, 'vault');
  assert.strictEqual(l.size.right, 240);
  assert.deepStrictEqual(l.zones.right, IDS);
});

test('a collapsed sidebar stays collapsed', () => {
  assert.strictEqual(fromLegacy({ sideTab: '' }, IDS).active.right, null);
});

test('no record, an unknown tab or a junk width give today\'s defaults', () => {
  for (const legacy of [{}, { sideTab: null, rosterWidth: null }, { sideTab: 'ghost', rosterWidth: 'wide' },
    { rosterWidth: '0' }, { rosterWidth: '' }, null]) {
    const l = fromLegacy(legacy, IDS);
    assert.strictEqual(l.active.right, 'agents', JSON.stringify(legacy));
    assert.strictEqual(l.size.right, 180, JSON.stringify(legacy));
  }
});

// --- selectModule ------------------------------------------------------------

test('clicking a tab shows that module in its zone', () => {
  const l = selectModule(defaultLayout(IDS), 'models');
  assert.strictEqual(l.active.right, 'models');
});

test('clicking the showing tab collapses its zone; clicking it again opens it', () => {
  const collapsed = selectModule(defaultLayout(IDS), 'agents');
  assert.strictEqual(collapsed.active.right, null);
  assert.strictEqual(selectModule(collapsed, 'agents').active.right, 'agents');
});

test('selecting a hidden or unknown module changes nothing', () => {
  const base = moveModule(defaultLayout(IDS), 'style', 'hide');
  assert.deepStrictEqual(selectModule(base, 'style'), base);
  assert.deepStrictEqual(selectModule(base, 'ghost'), base);
});

test('selecting only touches the zone that holds the module', () => {
  const base = moveModule(defaultLayout(IDS), 'vault', 'left');
  const l = selectModule(base, 'fog');
  assert.strictEqual(l.active.left, 'vault');
  assert.strictEqual(l.active.right, 'fog');
});

// --- moveModule -------------------------------------------------------------

test('a module moved to another zone is shown there and gone from where it was', () => {
  for (const target of ZONES.filter(z => z !== 'right')) {
    const l = moveModule(defaultLayout(IDS), 'vault', target);
    assert.deepStrictEqual(l.zones[target], ['vault'], target);
    assert.strictEqual(l.active[target], 'vault', target);
    assert.ok(!l.zones.right.includes('vault'), target);
  }
});

test('it joins the end of a zone that already has modules', () => {
  const base = moveModule(defaultLayout(IDS), 'vault', 'left');
  const l = moveModule(base, 'fog', 'left');
  assert.deepStrictEqual(l.zones.left, ['vault', 'fog']);
  assert.strictEqual(l.active.left, 'fog');
});

test('moving the showing module out leaves its zone on its first remaining one', () => {
  const l = moveModule(defaultLayout(IDS), 'agents', 'bottom');
  assert.strictEqual(l.active.right, 'vault');
});

test('moving a module that was not showing keeps its zone\'s choice', () => {
  const l = moveModule(selectModule(defaultLayout(IDS), 'models'), 'vault', 'top');
  assert.strictEqual(l.active.right, 'models');
});

test('a collapsed zone stays collapsed when a module leaves it', () => {
  const collapsed = selectModule(defaultLayout(IDS), 'agents');
  assert.strictEqual(moveModule(collapsed, 'vault', 'top').active.right, null);
});

test('moving the last module out empties the zone', () => {
  const one = normalizeLayout({ zones: { left: ['vault'], right: IDS.filter(id => id !== 'vault') } }, IDS);
  const l = moveModule(one, 'vault', 'top');
  assert.deepStrictEqual(l.zones.left, []);
  assert.strictEqual(l.active.left, null);
});

test('hide takes a module out of every zone; moving it to a zone brings it back', () => {
  const hidden = moveModule(defaultLayout(IDS), 'style', 'hide');
  assert.deepStrictEqual(hidden.hidden, ['style']);
  assert.ok(!hidden.zones.right.includes('style'));
  const back = moveModule(hidden, 'style', 'top');
  assert.deepStrictEqual(back.hidden, []);
  assert.deepStrictEqual(back.zones.top, ['style']);
});

test('moving to the zone it is in, to nowhere, or an unknown module changes nothing', () => {
  const base = defaultLayout(IDS);
  assert.deepStrictEqual(moveModule(base, 'vault', 'right'), base);
  assert.deepStrictEqual(moveModule(base, 'vault', 'middle'), base);
  assert.deepStrictEqual(moveModule(base, 'ghost', 'left'), base);
  const hidden = moveModule(base, 'style', 'hide');
  assert.deepStrictEqual(moveModule(hidden, 'style', 'hide'), hidden);
});

// --- setSize -----------------------------------------------------------------

test('a dragged size is stored rounded, never below the zone\'s minimum', () => {
  const base = defaultLayout(IDS);
  assert.strictEqual(setSize(base, 'right', 300.6).size.right, 301);
  assert.strictEqual(setSize(base, 'left', 40).size.left, MIN.side);
  assert.strictEqual(setSize(base, 'top', 10).size.top, MIN.wide);
});

test('a junk size or zone changes nothing', () => {
  const base = defaultLayout(IDS);
  for (const px of [NaN, null, '300', Infinity]) assert.deepStrictEqual(setSize(base, 'right', px), base);
  assert.deepStrictEqual(setSize(base, 'middle', 300), base);
});

// --- toggleAll: Ctrl+B ------------------------------------------------------

test('Ctrl+B with a zone open collapses every zone, and again brings each back as it was', () => {
  const base = selectModule(moveModule(defaultLayout(IDS), 'vault', 'left'), 'models');
  const closed = toggleAll(base);
  for (const z of ZONES) assert.strictEqual(closed.active[z], null, z);
  const open = toggleAll(closed);
  assert.deepStrictEqual(open.active, base.active);
  assert.strictEqual(open.restore, null);
});

test('Ctrl+B with every zone collapsed and nothing remembered opens each zone on its first module', () => {
  const l = toggleAll(selectModule(defaultLayout(IDS), 'agents'));
  assert.strictEqual(l.active.right, 'agents');
});

test('a remembered module that has since moved is not restored into the wrong zone', () => {
  // Remembered `models` on the right; `models` now sits in the top zone.
  const stale = normalizeLayout({
    zones: { right: IDS.filter(id => id !== 'models'), top: ['models'] },
    active: { right: null, top: null },
    restore: { right: 'models', top: null },
  }, IDS);
  const open = toggleAll(stale);
  assert.strictEqual(open.active.right, 'agents');   // its first module, not a module it doesn't hold
  assert.strictEqual(open.active.top, null);         // remembered collapsed
});

test('Ctrl+B never leaves every zone collapsed when it means to open', () => {
  const allNull = normalizeLayout({ zones: { right: IDS }, active: { right: null },
    restore: { left: null, right: null, top: null, bottom: null } }, IDS);
  assert.strictEqual(toggleAll(allNull).active.right, 'agents');
});

test('opening a zone by hand forgets the Ctrl+B memory', () => {
  const closed = toggleAll(defaultLayout(IDS));
  assert.strictEqual(selectModule(closed, 'vault').restore, null);
  assert.strictEqual(moveModule(closed, 'vault', 'top').restore, null);
});

// --- fitSizes: what the zones actually get in this window (S7) ---------------

const open = (zones, size) => normalizeLayout({ zones, size }, IDS);

test('a zone gets the size it was dragged to when the window has room', () => {
  const s = fitSizes(open({ right: IDS }, { right: 260 }), { width: 1200, height: 800 });
  assert.deepStrictEqual(s, { left: 0, right: 260, top: 0, bottom: 0 });
});

test('an empty zone takes no space; a collapsed one only its rail', () => {
  const l = selectModule(moveModule(defaultLayout(IDS), 'vault', 'top'), 'vault');   // top collapsed
  const s = fitSizes(l, { width: 1200, height: 800 });
  assert.strictEqual(s.left, 0);
  assert.strictEqual(s.bottom, 0);
  assert.strictEqual(s.top, RAIL.wide);
  const side = fitSizes(selectModule(defaultLayout(IDS), 'agents'), { width: 1200, height: 800 });
  assert.strictEqual(side.right, RAIL.side);
});

test('two wide side zones shrink together so the terminal keeps its minimum width', () => {
  const l = open({ left: ['vault'], right: IDS.filter(id => id !== 'vault') }, { left: 600, right: 600 });
  const s = fitSizes(l, { width: 1000, height: 800 });
  assert.ok(s.left + s.right <= 1000 - TERM_MIN.width, JSON.stringify(s));
  assert.ok(s.left >= MIN.side && s.right >= MIN.side);
  assert.strictEqual(s.left, s.right);          // proportional: equal asked, equal given
});

test('one wide side zone is capped at what leaves the terminal its minimum', () => {
  const s = fitSizes(open({ right: IDS }, { right: 900 }), { width: 1000, height: 800 });
  assert.strictEqual(s.right, 1000 - TERM_MIN.width);
});

test('a collapsed zone\'s rail counts against the room the open one may take', () => {
  const l = selectModule(open({ left: ['vault'], right: IDS.filter(id => id !== 'vault') }, { right: 900 }), 'vault');
  const s = fitSizes(l, { width: 1000, height: 800 });
  assert.strictEqual(s.left, RAIL.side);
  assert.strictEqual(s.right, 1000 - TERM_MIN.width - RAIL.side);
});

test('top and bottom shrink together the same way, against the height', () => {
  const l = open({ top: ['vault'], bottom: ['fog'], right: IDS.filter(id => id !== 'vault' && id !== 'fog') },
    { top: 400, bottom: 400 });
  const s = fitSizes(l, { width: 1200, height: 800 });
  assert.ok(s.top + s.bottom <= 800 - TERM_MIN.height, JSON.stringify(s));
  assert.ok(s.top >= MIN.wide && s.bottom >= MIN.wide);
});

test('a window too small for the minimums still gives every open zone its minimum', () => {
  const l = open({ left: ['vault'], right: IDS.filter(id => id !== 'vault') }, { left: 300, right: 300 });
  const s = fitSizes(l, { width: 400, height: 300 });
  assert.strictEqual(s.left, MIN.side);
  assert.strictEqual(s.right, MIN.side);
});

test('a junk viewport is treated as no room, never as NaN sizes', () => {
  const s = fitSizes(open({ right: IDS }, { right: 260 }), { width: undefined, height: null });
  assert.strictEqual(s.right, MIN.side);
});

test('left and right are tall; top and bottom are wide', () => {
  assert.deepStrictEqual(ZONES.map(shapeOf), ['tall', 'tall', 'wide', 'wide']);
});

test('found by P4: a small zone at its minimum beside a bigger one still leaves the terminal its room', () => {
  // 120 + 180 in a 560 px window used to come out 120 + 144 (264 > 240).
  const l = open({ left: ['agents'], right: IDS.filter(id => id !== 'agents') }, { left: 120, right: 180 });
  const s = fitSizes(l, { width: 560, height: 800 });
  assert.ok(s.left + s.right <= 560 - TERM_MIN.width, JSON.stringify(s));
  assert.strictEqual(s.left, MIN.side);
});

test('found by P1: a vanishingly small stored size becomes the minimum, not 0', () => {
  const l = normalizeLayout({ zones: { right: IDS }, size: { left: 5e-324, top: 1 } }, IDS);
  assert.strictEqual(l.size.left, MIN.side);
  assert.strictEqual(l.size.top, MIN.wide);
  assert.deepStrictEqual(normalizeLayout(l, IDS), l);
});

test('found by P4: an absurd stored size is capped, never NaN in the window', () => {
  const l = normalizeLayout({ zones: { right: IDS }, size: { right: 1e306 } }, IDS);
  assert.strictEqual(l.size.right, 10000);
  const s = fitSizes(l, { width: 742, height: 320 });
  assert.strictEqual(s.right, 742 - TERM_MIN.width);
  assert.strictEqual(setSize(l, 'left', 1e306).size.left, 10000);
});
