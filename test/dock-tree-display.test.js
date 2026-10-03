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

// --- afterTreeGet: the stores' answers -> what the page does -------------------------

const OK = { status: 'ok', layout: { version: 2 } };
const MISSING = { status: 'missing', layout: null };

test('afterTreeGet: a readable tree is used, whatever the L1 store says', () => {
  assert.strictEqual(V.afterTreeGet(OK, MISSING), 'use');
  assert.strictEqual(V.afterTreeGet(OK, { status: 'corrupt', layout: null }), 'use');
  assert.strictEqual(V.afterTreeGet(OK, undefined), 'use');
});

test('afterTreeGet: no tree yet migrates from L1 when there is one, else from the pre-L1 settings', () => {
  assert.strictEqual(V.afterTreeGet(MISSING, { status: 'ok', layout: { zones: {} } }), 'migrate-v1');
  assert.strictEqual(V.afterTreeGet(MISSING, MISSING), 'migrate-legacy');
});

test('afterTreeGet: an unreadable or corrupt store, on either side, is never migrated over', () => {
  for (const status of ['unreadable', 'corrupt']) {
    const bad = { status, layout: null };
    assert.strictEqual(V.afterTreeGet(bad, MISSING), 'keep', `tree ${status}`);
    assert.strictEqual(V.afterTreeGet(bad, OK), 'keep', `tree ${status}, L1 fine`);
    assert.strictEqual(V.afterTreeGet(MISSING, bad), 'keep', `L1 ${status}`);
  }
});

test('afterTreeGet: junk answers keep', () => {
  for (const junk of [null, undefined, 7, 'x', [], { status: 'ok', layout: null }, { status: 'ok', layout: [] }, {}]) {
    assert.strictEqual(V.afterTreeGet(junk, MISSING), 'keep', JSON.stringify(junk));
  }
  assert.strictEqual(V.afterTreeGet(MISSING, null), 'keep', 'the L1 answer never arrived');
  assert.strictEqual(V.afterTreeGet(MISSING, { status: 'ok', layout: null }), 'keep');
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

// --- PR #100 review (Dexter F3, F3b): a press that moves nothing stores nothing --------------

const v2 = root => ({ version: 2, root, floats: [], hidden: [], seat: {} });
const grp = (id, ...tabs) => ({ type: 'group', id, tabs });

test('F3a: a spine divider pushed against a neighbour at its minimum, or not moved, is no change at all', () => {
  // [term | A stored at 600] in 800: the fit squeezes A to 475 and the terminal sits at its 320 minimum.
  const l = T.normalize(v2({ type: 'split', dir: 'row', kids: [{ type: 'term' }, grp('A', 'git')], sizes: [0, 600] }), ['git']);
  const p = plan(l, { width: 800, height: 600 });
  const split = p.splits[0];
  assert.deepStrictEqual(split.px, [320, 475]);
  assert.strictEqual(V.sizesAfterDrag(l.root, split, 1, -20), null, 'widening A is impossible: the terminal has no room to give');
  assert.strictEqual(V.sizesAfterDrag(l.root, split, 1, 0), null, 'a press that never moved');
  // The stored 600 therefore survives: nothing is committed, and a wider window brings it back.
  assert.deepStrictEqual(T.fit(l, NO_SEL, { width: 1200, height: 600 }).boxes.find(b => b.kind === 'group').rect.width, 600);
  assert.ok(V.sizesAfterDrag(l.root, split, 1, 20), 'a real move still answers');
});

test('F3b: in a split too small for its minimums the divider cannot be dragged: no jump', () => {
  // col[A, B] in 150 high with proportions 3:1: drawn [109, 36], B already under its 80 minimum.
  const l = T.normalize(v2({ type: 'split', dir: 'col', kids: [grp('A', 'git'), grp('B', 'vault')], sizes: [3, 1] }), ['git', 'vault']);
  const p = V.treePlan(T.normalize(v2({ type: 'split', dir: 'row', kids: [{ type: 'term' }, l.root], sizes: [0, 200] }), ['git', 'vault']), NO_SEL, TABS, { width: 800, height: 150 }, { faceSize });
  const split = p.splits.find(s => s.dir === 'col');
  assert.ok(split.px.some((x, i) => x < split.min[i]), 'precondition: a kid is under its minimum');
  const node = l.root;
  for (const delta of [-10, 0, 10, 40]) assert.strictEqual(V.sizesAfterDrag(node, split, 1, delta), null, `delta ${delta}`);
});

test('F3b: dragSizes refuses when either neighbour is already under its minimum', () => {
  assert.strictEqual(V.dragSizes([109, 36], [80, 80], 1, -10), null);
  assert.strictEqual(V.dragSizes([36, 109], [80, 80], 1, 10), null);
  assert.deepStrictEqual(V.dragSizes([120, 200], [120, 120], 1, 40), [160, 160], 'at the minimum is not under it');
});

// --- PR #100 review (Dexter F6): a divider release lands on the placement AS IT IS NOW ----------

test('F6: rebaseDrag applies the two neighbours\' new sizes to the placement at release, keeping what another window changed', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const at = (sizes, hidden = []) => T.normalize({ ...v2({ type: 'split', dir: 'row', kids: [grp('l', 'a'), { type: 'term' }, grp('r', 'b'), grp('x', 'c')], sizes }), hidden }, ids);
  const base = at([200, 0, 300, 150], ['d']);
  const split = { px: [200, 400, 300, 150], min: [120, 320, 120, 120] };
  const sizes = V.sizesAfterDrag(base.root, split, 2, -40);                 // the divider before r moves left
  assert.deepStrictEqual(sizes, [200, 360, 340, 150]);
  const drag = { path: [], i: 2, node: base.root, sizes };
  // Meanwhile another window made the left group 260 wide and un-hid d.
  const now = T.normalize({ ...v2(at([260, 0, 300, 150]).root), hidden: [] }, ids);
  const rebased = V.rebaseDrag(now, drag);
  assert.deepStrictEqual(rebased, [260, 360, 340, 150], 'their 260 survives, only the divider\'s two neighbours change');
  const out = T.setSplitSizes(now, [], rebased);
  assert.deepStrictEqual(out.hidden, [], 'and what they un-hid stays shown');
});

test('F6: if the split changed shape under the drag, the drag is dropped', () => {
  const ids = ['a', 'b'];
  const base = T.normalize(v2({ type: 'split', dir: 'row', kids: [{ type: 'term' }, grp('r', 'a'), grp('s', 'b')], sizes: [0, 200, 200] }), ids);
  const drag = { path: [], i: 2, node: base.root, sizes: [320, 180, 220] };
  // Another window hid b: the split has two kids now.
  const fewer = T.hide(base, 'b');
  assert.strictEqual(V.rebaseDrag(fewer, drag), null, 'a kid went');
  // Another window turned the root into a column.
  const flipped = T.normalize(v2({ type: 'split', dir: 'col', kids: [{ type: 'term' }, grp('r', 'a'), grp('s', 'b')], sizes: [0, 200, 200] }), ids);
  assert.strictEqual(V.rebaseDrag(flipped, drag), null, 'the direction changed');
  // The split at that path is gone altogether.
  assert.strictEqual(V.rebaseDrag(T.defaultLayout(['a']), { ...drag, path: [1, 0] }), null);
  assert.strictEqual(V.rebaseDrag(base, null), null);
  assert.strictEqual(V.rebaseDrag(base, { ...drag, sizes: 'x' }), null);
});

test('F6: in a plain split the whole drawn row is the drag\'s answer', () => {
  const ids = ['a', 'b'];
  const base = T.normalize(v2({ type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'split', dir: 'col', kids: [grp('r', 'a'), grp('s', 'b')], sizes: [1, 1] }], sizes: [0, 200] }), ids);
  const drag = { path: [1], i: 1, node: base.root.kids[1], sizes: [220, 175] };
  assert.deepStrictEqual(V.rebaseDrag(base, drag), [220, 175]);
});
