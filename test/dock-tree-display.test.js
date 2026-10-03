'use strict';
/**
 * What the page draws for a dock tree (dockable panels D1, Task 9): the pure
 * half of app/dock-tree-display.js. The DOM half (applyBoxes) only copies this
 * onto elements; verify/probe-dock-tree.js measures the result in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');

const V = require('../app/dock-tree-display');
const T = require('../app/dock-tree');
const { TABS } = require('../app/side-tabs');
const { faceSize } = require('../app/roster-width');

const IDS = TABS.map(t => t.id);
const NO_SEL = { active: {}, foldAll: false };
const plan = (layout, vp, sel = NO_SEL) => V.treePlan(layout, sel, TABS, vp, { faceSize });
const groupBox = p => p.boxes.find(b => b.kind === 'group');

test('the default in 1000 x 600: one group, every tab, Agents on, tall, its portrait follows its width', () => {
  const p = plan(T.defaultLayout(IDS), { width: 1000, height: 600 });
  const g = groupBox(p);
  assert.strictEqual(g.shape, 'tall');
  assert.strictEqual(g.panel, 'agents');
  assert.deepStrictEqual(g.tabs.map(t => t.id), IDS);
  assert.deepStrictEqual(g.tabs.filter(t => t.on).map(t => t.id), ['agents']);
  assert.deepStrictEqual(g.tabs[1], { id: 'vault', label: 'Vault', title: 'Local encrypted secrets', on: false });
  assert.deepStrictEqual(g.rect, { x: 820, y: 0, width: 180, height: 600 });
  assert.deepStrictEqual(p.shown, ['agents']);
  assert.strictEqual(p.face, faceSize(180));
});

test('the plan carries fit\'s other boxes and its splits untouched', () => {
  const p = plan(T.defaultLayout(IDS), { width: 1000, height: 600 });
  assert.deepStrictEqual(p.boxes.map(b => b.kind), ['term', 'gutter', 'group']);
  assert.strictEqual(p.splits.length, 1);
});

test('the selection is this window\'s: its choice shows, and only that tab is on', () => {
  const p = plan(T.defaultLayout(IDS), { width: 1000, height: 600 }, { active: { right: 'vault' }, foldAll: false });
  assert.strictEqual(groupBox(p).panel, 'vault');
  assert.deepStrictEqual(p.shown, ['vault']);
  assert.strictEqual(p.face, null, 'Agents not showing: the portrait size is left alone');
});

test('an id the registry does not have gets no tab', () => {
  const l = T.defaultLayout(IDS);
  const p = V.treePlan(l, NO_SEL, TABS.filter(t => t.id !== 'style'), { width: 1000, height: 600 }, { faceSize });
  assert.ok(!groupBox(p).tabs.some(t => t.id === 'style'));
});

test('a box at least twice as wide as tall is wide, and its portrait follows its HEIGHT', () => {
  // Agents alone in a bottom group, 150 high, the whole width of a 1000 x 600 window.
  const l = T.dock(T.defaultLayout(IDS), 'agents', { edge: 'bottom' });
  const p = plan(l, { width: 1000, height: 600 });
  const g = p.boxes.find(b => b.kind === 'group' && b.panel === 'agents');
  assert.strictEqual(g.shape, 'wide');
  assert.strictEqual(p.face, Math.max(28, Math.min(150, g.rect.height - V.WIDE_FACE_CHROME)));
  assert.strictEqual(V.shapeOf({ width: 200, height: 100 }), 'wide');
  assert.strictEqual(V.shapeOf({ width: 199, height: 100 }), 'tall');
});

test('a short wide group keeps the portrait at least 28 and at most 150', () => {
  assert.strictEqual(V.faceForWide(40), 28);
  assert.strictEqual(V.faceForWide(100), 40);
  assert.strictEqual(V.faceForWide(900), 150);
});

test('a rail lists its modules and carries no panel', () => {
  const p = plan(T.defaultLayout(IDS), { width: 440, height: 600 });
  const rail = p.boxes.find(b => b.kind === 'rail');
  assert.deepStrictEqual(rail.modules, IDS);
  assert.deepStrictEqual(rail.tabs.map(t => t.label), TABS.map(t => t.label), 'a rail names its modules for its buttons');
  assert.deepStrictEqual(p.shown, []);
});

// --- dragSizes ----------------------------------------------------------------

test('dragSizes moves the divider before kid i: one neighbour grows, the other pays', () => {
  assert.deepStrictEqual(V.dragSizes([300, 200, 100], [120, 120, 80], 1, 40), [340, 160, 100]);
  assert.deepStrictEqual(V.dragSizes([300, 200, 100], [120, 120, 80], 1, -40), [260, 240, 100]);
});

test('dragSizes stops at each neighbour\'s minimum', () => {
  assert.deepStrictEqual(V.dragSizes([300, 200], [120, 120], 1, 500), [380, 120]);
  assert.deepStrictEqual(V.dragSizes([300, 200], [120, 120], 1, -500), [120, 380]);
});

test('dragSizes with a divider that cannot move (a neighbour already at its minimum) changes nothing', () => {
  assert.deepStrictEqual(V.dragSizes([120, 200], [120, 120], 1, -40), [120, 200]);
});

test('dragSizes treats junk as no drag', () => {
  const bad = [
    [null, [1], 1, 1], [[1, 2], null, 1, 1], [[1, 2], [1, 2], 0, 1], [[1, 2], [1, 2], 2, 1],
    [[1, 2], [1, 2], 1.5, 1], [[1, 2], [1, 2], 1, NaN], [[1, 2], [1, 2], 1, null], [[1, 2], [1], 1, 1],
    [[1, '2'], [1, 2], 1, 1], [[1, 2], [1, 2], 1, Infinity],
  ];
  for (const a of bad) assert.strictEqual(V.dragSizes(...a), null, JSON.stringify(a));
});

// --- sizesAfterDrag: what is stored when a divider is released ---------------------

test('in a spine split a divider drag changes its two neighbours and leaves every other kid\'s stored size', () => {
  // [left 200 | term | right 300]: the divider before the right kid moves 40 left, so right grows by 40.
  const node = { type: 'split', dir: 'row', kids: [{ type: 'group', id: 'l', tabs: ['a'] }, { type: 'term' }, { type: 'group', id: 'r', tabs: ['b'] }], sizes: [200, 0, 300] };
  const split = { px: [150, 500, 300], min: [120, 320, 120] };      // the left kid is squeezed: stored 200, drawn 150
  assert.deepStrictEqual(V.sizesAfterDrag(node, split, 2, -40), [200, 460, 340]);
});

test('in a plain split the sizes are proportions, so the whole drawn row is stored', () => {
  const node = { type: 'split', dir: 'col', kids: [{ type: 'group', id: 'a', tabs: ['a'] }, { type: 'group', id: 'b', tabs: ['b'] }], sizes: [1, 1] };
  assert.deepStrictEqual(V.sizesAfterDrag(node, { px: [200, 195], min: [80, 80] }, 1, 20), [220, 175]);
});

test('sizesAfterDrag is null for a drag that is not one', () => {
  const node = { type: 'split', dir: 'col', kids: [{ type: 'term' }, { type: 'group', id: 'b', tabs: ['b'] }], sizes: [0, 100] };
  assert.strictEqual(V.sizesAfterDrag(node, { px: [200, 100], min: [160, 80] }, 1, NaN), null);
  assert.strictEqual(V.sizesAfterDrag(null, { px: [200, 100], min: [160, 80] }, 1, 5), null);
});

// --- menuRows -------------------------------------------------------------------

test('menuRows lists every module in registry order, hidden ones included, with whether it is shown', () => {
  let l = T.defaultLayout(IDS);
  l = T.hide(T.hide(l, 'vault'), 'style');
  const rows = V.menuRows(l, TABS);
  assert.deepStrictEqual(rows.map(r => r.id), IDS);
  assert.deepStrictEqual(rows.filter(r => !r.shown).map(r => r.id), ['vault', 'style']);
  assert.deepStrictEqual(rows[0], { id: 'agents', label: 'Agents', shown: true });
});

test('menuRows still lists everything when every module is hidden: it is the way back', () => {
  let l = T.defaultLayout(IDS);
  for (const id of IDS) l = T.hide(l, id);
  const rows = V.menuRows(l, TABS);
  assert.strictEqual(rows.length, IDS.length);
  assert.ok(rows.every(r => r.shown === false));
});

test('a registry module the layout knows nothing of is not listed', () => {
  const l = T.defaultLayout(IDS.filter(id => id !== 'style'));
  assert.ok(!V.menuRows(l, TABS).some(r => r.id === 'style'));
});
