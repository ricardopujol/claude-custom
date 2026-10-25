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
// Claude's panel (#71) starts hidden, so a default layout shows every module but it.
const SHOWN = IDS.filter(id => !T.HIDDEN_UNTIL_USED.includes(id));
const NO_SEL = { active: {}, foldAll: false };
const plan = (layout, vp, sel = NO_SEL) => V.treePlan(layout, sel, TABS, vp, { faceSize });
const groupBox = p => p.boxes.find(b => b.kind === 'group');

test('the default in 1000 x 600: one group, every tab, Agents on, tall, its portrait follows its width', () => {
  const p = plan(T.defaultLayout(IDS), { width: 1000, height: 600 });
  const g = groupBox(p);
  assert.strictEqual(g.shape, 'tall');
  assert.strictEqual(g.panel, 'agents');
  assert.deepStrictEqual(g.tabs.map(t => t.id), SHOWN);
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

test('a float is planned like a group: its tabs, shown panel and shape; its panel is on screen (D2)', () => {
  const l = T.dock(T.dock(T.defaultLayout(IDS), 'vault', { float: { x: 100, y: 80 } }), 'git', { cell: T.floatOf(T.dock(T.defaultLayout(IDS), 'vault', { float: { x: 100, y: 80 } }), 'vault').id, side: 'center' });
  const p = plan(l, { width: 1000, height: 600 }, { active: {}, foldAll: false, floatOrder: [] });
  const f = p.boxes.find(b => b.kind === 'float');
  assert.deepStrictEqual(f.tabs.map(t => [t.id, t.on]), [['vault', true], ['git', false]]);
  assert.strictEqual(f.panel, 'vault');
  assert.strictEqual(f.shape, 'tall');
  assert.deepStrictEqual(f.rect, { x: 100, y: 80, width: 320, height: 260 });
  assert.deepStrictEqual(p.shown.sort(), ['agents', 'vault']);
});

test('a float showing Agents sets the portrait size when no group does', () => {
  const l = T.dock(T.hide(T.defaultLayout(IDS), 'agents'), 'agents', { float: { x: 0, y: 0, w: 300, h: 400 } });
  assert.strictEqual(plan(l, { width: 1000, height: 600 }).face, faceSize(300));
});

test('Ctrl+B plans no float, so a float\'s panel is not on screen', () => {
  const l = T.dock(T.defaultLayout(IDS), 'vault', { float: true });
  const p = plan(l, { width: 1000, height: 600 }, { active: {}, foldAll: true, floatOrder: [] });
  assert.ok(!p.boxes.some(b => b.kind === 'float'));
  assert.ok(!p.shown.includes('vault'));
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
  assert.deepStrictEqual(rail.modules, SHOWN);
  assert.deepStrictEqual(rail.tabs.map(t => t.label), TABS.filter(t => SHOWN.includes(t.id)).map(t => t.label), 'a rail names its modules for its buttons');
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
  assert.deepStrictEqual(rows.filter(r => !r.shown).map(r => r.id), ['vault', 'style', 'canvas']);
  assert.deepStrictEqual(rows[0], { id: 'agents', label: 'Agents', shown: true, railed: false });
});

test('menuRows still lists everything when every module is hidden: it is the way back', () => {
  let l = T.defaultLayout(IDS);
  for (const id of IDS) l = T.hide(l, id);
  const rows = V.menuRows(l, TABS);
  assert.strictEqual(rows.length, IDS.length);
  assert.ok(rows.every(r => r.shown === false));
});

// PR #102 Dexter 1 and 4: a floating panel is listed, shown, like any other; the menu is the way back to every module.
test('menuRows lists a floating module, shown (PR #102 Dexter 1)', () => {
  const l = T.dock(T.defaultLayout(IDS), 'vault', { float: true });
  const rows = V.menuRows(l, TABS);
  assert.deepStrictEqual(rows.map(r => r.id), IDS);
  assert.deepStrictEqual(rows.find(r => r.id === 'vault'), { id: 'vault', label: 'Vault', shown: true, railed: false });
});

test('menuRows with every module floating still lists every module, so Ctrl+B with only floats leaves a way back (PR #102 Dexter 1 and 4)', () => {
  let l = T.defaultLayout(IDS);
  for (const id of IDS) l = T.dock(l, id, { float: true });
  const rows = V.menuRows(l, TABS);
  assert.deepStrictEqual(rows.map(r => r.id), IDS);
  assert.ok(rows.every(r => r.shown));
});

test('a floating module unticked is hidden (its seat keeps the float\'s rectangle), and ticked it floats again (PR #102 Dexter 1)', () => {
  let l = T.dock(T.defaultLayout(IDS), 'vault', { float: { x: 90, y: 70 } });
  l = T.hide(l, 'vault');
  assert.strictEqual(V.menuRows(l, TABS).find(r => r.id === 'vault').shown, false);
  const back = T.show(l, 'vault');
  assert.deepStrictEqual([back.floats[0].x, back.floats[0].y], [90, 70]);
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

// --- PR #100 Miguel S5: no L1 bridge is "nothing to migrate from", not a read failure --------------

test('S5: no tree yet and no L1 bridge at all is the legacy path, not "couldn\'t read"', () => {
  assert.strictEqual(V.afterTreeGet(MISSING, null, { v1Bridge: false }), 'migrate-legacy');
  assert.strictEqual(V.afterTreeGet(MISSING, undefined, { v1Bridge: false }), 'migrate-legacy');
});

test('S5: with the L1 bridge present, a missing answer from it still keeps (it was asked and failed)', () => {
  assert.strictEqual(V.afterTreeGet(MISSING, null, { v1Bridge: true }), 'keep');
  assert.strictEqual(V.afterTreeGet(MISSING, null), 'keep', 'the bridge is assumed present unless said otherwise');
});

test('S5: a missing L1 bridge changes nothing when the tree is readable or damaged', () => {
  assert.strictEqual(V.afterTreeGet(OK, null, { v1Bridge: false }), 'use');
  for (const status of ['unreadable', 'corrupt']) assert.strictEqual(V.afterTreeGet({ status, layout: null }, null, { v1Bridge: false }), 'keep', status);
  assert.strictEqual(V.afterTreeGet(null, null, { v1Bridge: false }), 'keep');
});

// --- PR #100 Miguel S3: a refused save is said, not swallowed ----------------------------------

test('S3: layoutSaved is true only for the layout main echoes back; null (refused, oversized, write failed) is not saved', () => {
  assert.strictEqual(V.layoutSaved({ version: 2, root: { type: 'term' } }), true);
  for (const bad of [null, undefined, 0, 'x', [], true]) assert.strictEqual(V.layoutSaved(bad), false, JSON.stringify(bad));
});

// --- PR #102 Dexter 2 and 6: what a float's release stores -----------------------------------------

const fdLayout = (floats) => T.normalize({ ...v2({ type: 'split', dir: 'row', kids: [{ type: 'term' }, grp('a', 'agents')], sizes: [0, 200] }), floats }, ['agents', 'git', 'fog']);
const fdFloat = (over = {}) => ({ id: 'f', tabs: ['git'], x: 48, y: 48, w: 320, h: 260, ...over });
const fdDrag = (over) => ({ kind: 'move', id: 'f', tabs: ['git'], last: { x: 0, y: 0 }, viewport: { width: 1000, height: 700 }, ...over });

test('Dexter 2: a resize release that asks for exactly the drawn size stores nothing, even when the float is drawn shrunk', () => {
  const l = fdLayout([fdFloat()]);                                               // 320 x 260, drawn 200 x 150 in this window
  const vp = { width: 200, height: 150 };
  assert.strictEqual(V.floatDragResult(l, fdDrag({ kind: 'resize', last: { w: 200, h: 150 }, viewport: vp })), l);
});

test('Dexter 2: a move release that lands where the float is already drawn stores nothing: clamped at the edge, or pushed against it', () => {
  const l = fdLayout([fdFloat({ x: 1500 })]);                                    // stored at 1500, drawn at 680 in 1000 px
  assert.strictEqual(V.floatDragResult(l, fdDrag({ last: { x: 680, y: 48 } })), l);
  assert.strictEqual(V.floatDragResult(l, fdDrag({ last: { x: 720, y: 48 } })), l, 'pushed further against the edge: still where it is drawn');
});

test('Dexter 2: a real move of a clamped float stores the new position and KEEPS the stored size', () => {
  const l = fdLayout([fdFloat({ x: 1500 })]);
  const next = V.floatDragResult(l, fdDrag({ last: { x: 600, y: 80 } }));
  assert.deepStrictEqual([next.floats[0].x, next.floats[0].y, next.floats[0].w, next.floats[0].h], [600, 80, 320, 260]);
});

test('Dexter 2: a real resize of a clamped float stores the DRAWN position and the new size (P11)', () => {
  const l = fdLayout([fdFloat({ x: 900, y: 50 })]);                              // drawn at x 680
  const next = V.floatDragResult(l, fdDrag({ kind: 'resize', last: { w: 300, h: 260 } }));
  assert.deepStrictEqual([next.floats[0].x, next.floats[0].y, next.floats[0].w, next.floats[0].h], [680, 50, 300, 260]);
});

test('Dexter 6: a release applies only to a float that still holds what it held at the press', () => {
  const l = fdLayout([fdFloat({ id: 'g2', tabs: ['fog'] })]);
  const drag = fdDrag({ id: 'g2', tabs: ['git'], last: { x: 300, y: 300 } });
  assert.strictEqual(V.floatDragResult(l, drag), null, 'the id was reused by another float: the drag is dropped');
  assert.strictEqual(V.floatDragResult(l, fdDrag({ id: 'gone', tabs: ['git'], last: { x: 300, y: 300 } })), null, 'the float is gone');
  assert.strictEqual(V.floatDragResult(fdLayout([fdFloat({ tabs: ['git', 'fog'] })]), fdDrag({ last: { x: 300, y: 300 } })), null, 'it gained a tab meanwhile');
  const same = V.floatDragResult(fdLayout([fdFloat()]), fdDrag({ last: { x: 300, y: 300 } }));
  assert.deepStrictEqual([same.floats[0].x, same.floats[0].y], [300, 300]);
});

test('floatDragResult: junk is a dropped drag, never a throw', () => {
  const l = fdLayout([fdFloat()]);
  for (const junk of [null, undefined, 7, {}, { kind: 'zoom', id: 'f', tabs: ['git'], last: { x: 1, y: 1 }, viewport: { width: 9, height: 9 } }]) {
    assert.strictEqual(V.floatDragResult(l, junk), null, JSON.stringify(junk));
  }
  assert.strictEqual(V.floatDragResult(null, fdDrag({})), null);
});

// --- PR #102 Miguel Y4, S3: a floating Vault leaves view like any other, and moving a float never disturbs it ---

const { renderEffects } = require('../app/dock-effects');
const VAULT_FLOAT_VP = { width: 1000, height: 700 };
const vaultFloating = () => T.dock(T.defaultLayout(IDS), 'vault', { float: { x: 100, y: 80 } });
const shownIn = (l, sel = NO_SEL) => new Set(plan(l, VAULT_FLOAT_VP, sel).shown);
const floatIdOf = l => T.floatOf(l, 'vault').id;

test('Y4: a floating Vault is on screen, and every way of taking it out of view is a "vault left" (so revealed secrets go back out of sight)', () => {
  const l = vaultFloating();
  const before = shownIn(l);
  assert.ok(before.has('vault'));
  const left = (after) => renderEffects(before, after, { userAction: true }).vaultLeft;
  assert.strictEqual(left(shownIn(l, { ...NO_SEL, foldAll: true })), true, 'Ctrl+B draws no float');
  assert.strictEqual(left(shownIn(T.hide(l, 'vault'))), true, 'hidden from the Window menu');
  assert.strictEqual(left(shownIn(T.dock(l, 'vault', { cell: 'right', side: 'center' }), { active: { right: 'agents' }, foldAll: false })), true, 'docked into a group where another tab is showing');
  const withGit = T.dock(l, 'git', { cell: floatIdOf(l), side: 'center' });
  assert.ok(shownIn(withGit, { active: { [floatIdOf(withGit)]: 'vault' }, foldAll: false }).has('vault'));
  assert.strictEqual(renderEffects(shownIn(withGit, { active: { [floatIdOf(withGit)]: 'vault' }, foldAll: false }), shownIn(withGit, { active: { [floatIdOf(withGit)]: 'git' }, foldAll: false })).vaultLeft, true, 'another tab of its float comes to the front');
});

test('Y4: raising, moving or resizing a float keeps the Vault on screen and moves no keyboard focus', () => {
  const l = vaultFloating();
  const id = floatIdOf(l);
  const before = shownIn(l);
  const moved = V.floatDragResult(l, { kind: 'move', id, tabs: ['vault'], last: { x: 300, y: 200 }, viewport: VAULT_FLOAT_VP });
  const resized = V.floatDragResult(l, { kind: 'resize', id, tabs: ['vault'], last: { w: 400, h: 300 }, viewport: VAULT_FLOAT_VP });
  for (const after of [shownIn(moved), shownIn(resized), shownIn(l, T.raiseFloat(NO_SEL, id))]) {
    assert.deepStrictEqual([...after], [...before]);
    const fx = renderEffects(before, after, { userAction: false });
    assert.deepStrictEqual([fx.vaultLeft, fx.focus, fx.newlyShown], [false, null, []]);
  }
});

// --- D4: divider keys, the settle motion ----------------------------------------------------------

test('a divider moves 16 px with the arrow that points along it, and only that arrow', () => {
  assert.strictEqual(V.dividerStep('ArrowLeft', 'row'), -16);
  assert.strictEqual(V.dividerStep('ArrowRight', 'row'), 16);
  assert.strictEqual(V.dividerStep('ArrowUp', 'col'), -16);
  assert.strictEqual(V.dividerStep('ArrowDown', 'col'), 16);
  for (const [key, dir] of [['ArrowUp', 'row'], ['ArrowDown', 'row'], ['ArrowLeft', 'col'], ['ArrowRight', 'col'], ['Enter', 'row'], ['a', 'col'], ['ArrowLeft', 'diag'], [null, 'row'], ['ArrowLeft', null]]) {
    assert.strictEqual(V.dividerStep(key, dir), null, `${key} ${dir}`);
  }
});

const SPLIT_VP = { width: 1000, height: 600 };
const keyed = (layout, path, i, key, vp = SPLIT_VP) => V.dividerKey(layout, plan(layout, vp).splits, path, i, key);

test('ArrowLeft on the divider beside the terminal gives the group on the right 16 px; ArrowRight takes them back', () => {
  const l = T.defaultLayout(IDS);
  const wider = keyed(l, [], 1, 'ArrowLeft');
  assert.strictEqual(wider.root.sizes[1], 196);
  assert.deepStrictEqual(wider.root.sizes[0], 0, 'the terminal\'s side still flexes');
  assert.strictEqual(keyed(wider, [], 1, 'ArrowRight').root.sizes[1], 180);
});

test('a divider at its limit, a key that does not move it and a path that is no split change nothing (null)', () => {
  const l = T.defaultLayout(IDS);
  const edge = keyed(T.setSplitSizes(l, [], [1, 120]), [], 1, 'ArrowRight');
  assert.strictEqual(edge, null, 'the group is at its 120 px minimum: nothing to take from it');
  assert.strictEqual(keyed(l, [], 1, 'Enter'), null);
  assert.strictEqual(keyed(l, [], 1, 'ArrowUp'), null, 'a row split is moved by left and right');
  assert.strictEqual(keyed(l, [5], 1, 'ArrowLeft'), null);
  assert.strictEqual(keyed(l, [], 0, 'ArrowLeft'), null, 'there is no divider before the first kid');
  assert.strictEqual(keyed(l, 'x', 1, 'ArrowLeft'), null);
});

test('a divider between two panels trades pixels but stays above both minimums', () => {
  const l = T.normalize({
    version: 2,
    root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'split', dir: 'col', kids: [{ type: 'group', id: 'a', tabs: ['agents'] }, { type: 'group', id: 'b', tabs: ['vault'] }], sizes: [300, 300] }], sizes: [0, 200] },
    floats: [], hidden: IDS.filter(i => !['agents', 'vault'].includes(i)), seat: {},
  }, IDS);
  const down = keyed(l, [1], 1, 'ArrowDown');
  const [a, b] = down.root.kids[1].sizes;
  assert.ok(a > b, `${a} ${b}`);
  assert.ok(down.root.kids[1].sizes.every(s => s >= 80));
});

test('settleMs: about 120 ms, none when the person asked for reduced motion or the preference is unknown', () => {
  assert.strictEqual(V.SETTLE_MS, 120);
  assert.strictEqual(V.settleMs(false), 120);
  assert.strictEqual(V.settleMs(true), 0);
  for (const junk of [undefined, null, 'no', 0]) assert.strictEqual(V.settleMs(junk), 0, String(junk));
});

// --- PR #159 Dexter r2 N1: a key burst is saved on the placement as it is NOW, like a pointer release ---

test('N1: ArrowLeft on a divider, then the canvas docks itself within the burst: the flush keeps the canvas AND the divider move', () => {
  const l0 = T.normalize(T.defaultLayout(IDS), IDS);
  const withCanvas = T.hide(T.dock(l0, 'canvas', { cell: 'right', side: 'center' }), 'canvas');   // hidden from the group it sat in: showing it rejoins that group
  const vp = { width: 1000, height: 600 };
  const splits = plan(withCanvas, vp).splits;
  const burst = V.dividerKeySizes(withCanvas, splits, [], 1, 'ArrowLeft');
  assert.ok(burst, 'the key moves it');
  // Meanwhile the committed layout changed under the burst (Claude's panel docked itself; or another window's push).
  const nowSaved = T.show(withCanvas, 'canvas');
  assert.ok(T.groupOf(nowSaved, 'canvas'), 'the canvas is on screen now');
  const rebased = V.rebaseDrag(nowSaved, { path: [], i: 1, node: burst.node, sizes: burst.sizes });
  assert.ok(rebased, 'the divider is still the one that was pressed');
  const saved = T.setSplitSizes(nowSaved, [], rebased);
  assert.ok(T.groupOf(saved, 'canvas'), 'the canvas is still docked and visible');
  assert.equal(saved.root.sizes[1], withCanvas.root.sizes[1] + 16, 'and the divider move is kept');
  // What the old flush saved was the whole stale drawn layout: it would hide the canvas again.
  const stale = T.setSplitSizes(withCanvas, [], burst.sizes);
  assert.equal(T.groupOf(stale, 'canvas'), null, 'the stale layout is the one that loses it (the bug this pins)');
});

test('N1: another window hid a panel during the burst: the flush saves on top of that, and a split that is gone drops the burst', () => {
  const base = T.defaultLayout(IDS);
  const burst = V.dividerKeySizes(base, plan(base, { width: 1000, height: 600 }).splits, [], 1, 'ArrowLeft');
  const hidden = T.hide(base, 'style');
  const out = T.setSplitSizes(hidden, [], V.rebaseDrag(hidden, { path: [], i: 1, node: burst.node, sizes: burst.sizes }));
  assert.deepEqual(out.hidden.includes('style'), true, 'the hide survives');
  const gone = T.defaultLayout([]);
  assert.equal(V.rebaseDrag(gone, { path: [], i: 1, node: burst.node, sizes: burst.sizes }), null);
});

test('N1: dividerKey is dividerKeySizes applied; both are null together', () => {
  const l = T.defaultLayout(IDS);
  const splits = plan(l, { width: 1000, height: 600 }).splits;
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter']) {
    const s = V.dividerKeySizes(l, splits, [], 1, key);
    const k = V.dividerKey(l, splits, [], 1, key);
    assert.equal(s === null, k === null, key);
    if (s) assert.deepEqual(k, T.setSplitSizes(l, [], s.sizes));
  }
});

// --- kill tests for the release-176 survivors (BACKLOG #94, M13) -------------------------------------------------------

const kg = (id, ...tabs) => ({ type: 'group', id, tabs });
const kterm = { type: 'term' };
const krow = (kids, sizes) => ({ type: 'split', dir: 'row', kids, sizes });
const kcol = (kids, sizes) => ({ type: 'split', dir: 'col', kids, sizes });
const K_IDS = ['a', 'b', 'c', 'd'];
const kv2 = (root, extra = {}) => T.normalize({ version: 2, root, floats: [], hidden: [], seat: {}, rail: [], ...extra }, K_IDS);
const KVP = { width: 1200, height: 600 };

test('M13: railAfter: a junk or empty-named state reads as idle, whatever the event', () => {
  const ev = { type: 'enter', module: 'a' };
  const idle = V.railAfter(null, ev);
  assert.deepStrictEqual(idle, { module: null, held: false, pending: 'a', leaving: false });
  for (const junk of [{ module: '' }, { module: 5 }, { module: null }, [], 'x', undefined, { module: '', held: true, leaving: true }]) {
    assert.deepStrictEqual(V.railAfter(junk, ev), idle, JSON.stringify(junk));
  }
  assert.deepStrictEqual(V.railAfter({ module: null, pending: 'b' }, { type: 'enter-panel' }), { module: null, held: false, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter({ module: null, pending: '' }, { type: 'leave' }), { module: null, held: false, pending: null, leaving: false }, 'a blank wait is no wait');
  assert.deepStrictEqual(V.railAfter({ module: null, pending: 7 }, { type: 'open-timer', module: 'x' }), { module: null, held: false, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter({ module: null, pending: 'x' }, { type: 'open-timer', module: 'x' }), { module: 'x', held: false, pending: null, leaving: false });
});

test('M13: railAfter: a held panel is never marked leaving, and only an exact true holds', () => {
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: true, leaving: true }, { type: 'leave' }), { module: 'a', held: true, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: 'yes', leaving: true }, { type: 'leave' }), { module: 'a', held: false, pending: null, leaving: true });
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: false, leaving: 'yes' }, { type: 'leave' }), { module: 'a', held: false, pending: null, leaving: true });
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: false, leaving: 1 }, { type: 'hold' }), { module: 'a', held: true, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: false, leaving: true }, { type: 'close-timer' }), V.RAIL_IDLE);
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: true, leaving: true }, { type: 'close-timer' }), { module: 'a', held: true, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter({ module: 'a', held: false, leaving: false }, { type: 'close-timer' }), { module: 'a', held: false, pending: null, leaving: false });
});

test('M13: railAfter: the events in turn', () => {
  const open = { module: 'a', held: false, pending: null, leaving: false };
  const held = { ...open, held: true };
  assert.deepStrictEqual(V.railAfter(open, { type: 'enter', module: 'b' }), { module: 'b', held: false, pending: null, leaving: false }, 'a swap by hover');
  assert.deepStrictEqual(V.railAfter(held, { type: 'enter', module: 'b' }), { module: 'b', held: false, pending: null, leaving: false }, 'the hold stays with the click that made it');
  assert.deepStrictEqual(V.railAfter(held, { type: 'enter', module: 'a' }), held, 'the same tab changes nothing but the grace');
  assert.deepStrictEqual(V.railAfter({ ...open, leaving: true }, { type: 'enter', module: 'a' }), open);
  assert.deepStrictEqual(V.railAfter(open, { type: 'enter' }), open);
  assert.deepStrictEqual(V.railAfter(open, { type: 'enter', module: '' }), open);
  assert.deepStrictEqual(V.railAfter(V.RAIL_IDLE, { type: 'leave' }), V.RAIL_IDLE);
  assert.deepStrictEqual(V.railAfter(V.RAIL_IDLE, { type: 'hold' }), V.RAIL_IDLE);
  assert.deepStrictEqual(V.railAfter(V.RAIL_IDLE, { type: 'tab', module: 'a' }), V.RAIL_IDLE);
  assert.deepStrictEqual(V.railAfter(open, { type: 'tab', module: 'b' }), { module: 'b', held: false, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter(open, { type: 'tab' }), open);
  assert.deepStrictEqual(V.railAfter(V.RAIL_IDLE, { type: 'click', module: 'a' }), { module: 'a', held: true, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter(open, { type: 'click', module: 'a' }), { module: 'a', held: true, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter(held, { type: 'click', module: 'a' }), V.RAIL_IDLE, 'a click on the held one closes it');
  assert.deepStrictEqual(V.railAfter(held, { type: 'click', module: 'b' }), { module: 'b', held: true, pending: null, leaving: false });
  assert.deepStrictEqual(V.railAfter(open, { type: 'click' }), open);
  for (const type of ['escape', 'outside', 'drop', 'gone']) assert.deepStrictEqual(V.railAfter(held, { type }), V.RAIL_IDLE, type);
  assert.deepStrictEqual(V.railAfter(open, { type: 'nonsense' }), open);
  assert.deepStrictEqual(V.railAfter(open, null), open);
  assert.deepStrictEqual(V.railAfter({ module: null, pending: 'a' }, { type: 'open-timer', module: 'b' }), { module: null, held: false, pending: 'a', leaving: false }, 'another tab is not the one waiting');
  assert.deepStrictEqual(V.railAfter(open, { type: 'open-timer', module: 'a' }), open);
});

test('M13: dragSizes: neighbours trade pixels inside their minimums; a squeezed neighbour, junk, or no move gives null; a kid exactly at its minimum can still grow', () => {
  assert.deepStrictEqual(V.dragSizes([100, 200], [100, 100], 1, 50), [150, 150], 'the kid at its minimum may still take');
  assert.deepStrictEqual(V.dragSizes([100, 200], [100, 100], 1, -50), [100, 200], 'but it cannot give');
  assert.deepStrictEqual(V.dragSizes([200, 100], [100, 100], 1, 80), [200, 100]);
  assert.deepStrictEqual(V.dragSizes([300, 200, 100], [100, 100, 100], 1, -150), [150, 350, 100]);
  assert.deepStrictEqual(V.dragSizes([300, 200, 100], [100, 100, 100], 1, 10.6), [311, 189, 100], 'whole pixels');
  assert.deepStrictEqual(V.dragSizes([300, 200], [100, 100], 1, 1000), [400, 100], 'never under the minimum');
  for (const bad of [
    [[99, 200], [100, 100], 1, 5], [[200, 99], [100, 100], 1, 5], [[200], [100], 1, 5], [[200, 200], [100], 1, 5], [[200, 200], [100, 100], 0, 5],
    [[200, 200], [100, 100], 2, 5], [[200, 200], [100, 100], 1.5, 5], [[200, 200], [100, 100], 1, NaN], [[200, 200], [100, 100], 1, '5'],
    [[200, 'x'], [100, 100], 1, 5], [[200, 200], [100, 'x'], 1, 5], [[200, 200], [100, NaN], 1, 5], ['no', [100, 100], 1, 5], [[200, 200], 'no', 1, 5],
  ]) assert.strictEqual(V.dragSizes(...bad), null, JSON.stringify(bad));
});

test('M13: sizesAfterDrag: a plain split stores the whole drawn row, a rail neighbour trades with the terminal\'s room, anything odd stores nothing', () => {
  const plain = krow([kg('x', 'a'), kg('y', 'b'), kg('z', 'c')], [1, 1, 1]);
  const open3 = { px: [300, 300, 300], min: [100, 100, 100], state: ['open', 'open', 'open'] };
  assert.deepStrictEqual(V.sizesAfterDrag(plain, open3, 1, 20), [320, 280, 300]);
  assert.deepStrictEqual(V.sizesAfterDrag(plain, { px: [300, 300, 300], min: [100, 100, 100] }, 1, 20), [320, 280, 300], 'no state at all: all open');
  assert.deepStrictEqual(V.sizesAfterDrag(plain, { px: [300, 300, 300], min: [100, 100, 100], state: ['open'] }, 1, 20), [320, 280, 300], 'a state list of the wrong length is ignored');
  assert.strictEqual(V.sizesAfterDrag(plain, open3, 1, 0), null, 'no delta moves nothing');
  assert.strictEqual(V.sizesAfterDrag(plain, { px: [100, 300, 300], min: [100, 100, 100], state: ['open', 'open', 'open'] }, 1, -20), null, 'a neighbour at its minimum');
  for (const i of [0, 3, 1.5, -1, '1', undefined]) assert.strictEqual(V.sizesAfterDrag(plain, open3, i, 20), null, String(i));
  for (const node of [null, 'x', [], { type: 'group' }, { type: 'term' }]) assert.strictEqual(V.sizesAfterDrag(node, open3, 1, 20), null);
  for (const split of [null, 'x', undefined]) assert.strictEqual(V.sizesAfterDrag(plain, split, 1, 20), null);
  assert.deepStrictEqual(V.sizesAfterDrag(plain, { px: [300, 28, 272], min: [100, 28, 100], state: ['open', 'rail', 'open'] }, 2, 20), null, 'a plain split has no room to trade with across a rail');
});

test('M13: sizesAfterDrag: with a rail in a plain row the rail keeps its stored share, written in the drawn pixels\' units', () => {
  const four = krow([kg('x', 'a'), kg('y', 'b'), kg('z', 'c'), kg('w', 'd')], [2, 1, 2, 2]);
  const s4 = { px: [400, 28, 400, 400], min: [100, 28, 100, 100], state: ['open', 'rail', 'open', 'open'] };
  const got = V.sizesAfterDrag(four, s4, 3, 20);
  const tOpen = 2 + 2 + 2; const sOpen = 400 + 400 + 400;
  assert.deepStrictEqual(got, [400, 1 * sOpen / tOpen, 420, 380]);
});

test('M13: sizesAfterDrag: beside the terminal only the divider\'s two neighbours change; the other fixed kids keep what is stored', () => {
  const node = krow([kg('x', 'a'), kterm, kg('y', 'b'), kg('z', 'c')], [150, 0, 160, 170]);
  const split = { px: [150, 700, 150, 100], min: [120, 320, 120, 100], state: ['open', 'open', 'open', 'open'] };
  assert.deepStrictEqual(V.sizesAfterDrag(node, split, 2, -16), [150, 684, 166, 170]);
  assert.strictEqual(V.sizesAfterDrag(node, split, 3, 16), null, 'the last kid is at its minimum: it cannot give');
});

test('M13: sizesAfterDrag: across a rail the open kid trades with the terminal\'s room, against its own minimum', () => {
  const node = krow([kterm, kg('x', 'a'), kg('y', 'b')], [0, 180, 180]);
  const base ={ px: [600, 28, 200], min: [320, 28, 120], state: ['open', 'rail', 'open'] };
  assert.deepStrictEqual(V.sizesAfterDrag(node, base, 2, 16), [600, 180, 184], 'the divider moves right: the kid after it shrinks');
  assert.deepStrictEqual(V.sizesAfterDrag(node, base, 2, -16), [600, 180, 216]);
  assert.strictEqual(V.sizesAfterDrag(node, { ...base, px: [320, 28, 200] }, 2, -16), null, 'the terminal has no room to give');
  assert.strictEqual(V.sizesAfterDrag(node, { ...base, px: [600, 28, 100] }, 2, 16), null, 'the open kid is already under its minimum');
  assert.strictEqual(V.sizesAfterDrag(node, { ...base, state: ['open', 'rail', 'rail'] }, 2, 16), null, 'both neighbours are rails');
  assert.strictEqual(V.sizesAfterDrag(node, base, 2, NaN), null);
  assert.strictEqual(V.sizesAfterDrag(node, base, 2, '16'), null);
  assert.strictEqual(V.sizesAfterDrag(node, { ...base, px: [600, 28, 200] }, 2, 0), null, 'no delta moves nothing');
  const before = krow([kterm, kg('x', 'a'), kg('y', 'b')], [0, 180, 180]);
  const rail2 = { px: [600, 200, 28], min: [320, 120, 28], state: ['open', 'open', 'rail'] };
  assert.deepStrictEqual(V.sizesAfterDrag(before, rail2, 2, 16), [600, 216, 180], 'the open kid BEFORE the divider grows when it moves right');
});

test('M13: dividerStep: the arrow along the split moves it one step, anything else is null', () => {
  assert.strictEqual(V.dividerStep('ArrowLeft', 'row'), -16);
  assert.strictEqual(V.dividerStep('ArrowRight', 'row'), 16);
  assert.strictEqual(V.dividerStep('ArrowUp', 'row'), null);
  assert.strictEqual(V.dividerStep('ArrowDown', 'row'), null);
  assert.strictEqual(V.dividerStep('ArrowUp', 'col'), -16);
  assert.strictEqual(V.dividerStep('ArrowDown', 'col'), 16);
  assert.strictEqual(V.dividerStep('ArrowLeft', 'col'), null);
  assert.strictEqual(V.dividerStep('ArrowRight', 'col'), null);
  assert.strictEqual(V.dividerStep('Enter', 'row'), null);
  assert.strictEqual(V.dividerStep('ArrowLeft', 'diagonal'), null);
});

test('M13: dividerKey / dividerKeySizes: a press moves the divider before kid i; every junk request changes nothing', () => {
  const l = kv2(krow([kg('l', 'a'), kterm, kg('r', 'b')], [150, 0, 150]));
  const { splits } = T.fit(l, { active: {}, foldAll: false }, KVP);
  const moved = V.dividerKeySizes(l, splits, [], 2, 'ArrowLeft');
  assert.deepStrictEqual(moved.sizes, [150, 874, 166]);
  assert.strictEqual(moved.node, l.root);
  assert.deepStrictEqual(V.dividerKey(l, splits, [], 2, 'ArrowLeft').root.sizes, [150, 0, 166]);
  assert.deepStrictEqual(V.dividerKey(l, splits, [], 1, 'ArrowRight').root.sizes, [166, 0, 150]);
  const nope = (...a) => assert.strictEqual(V.dividerKeySizes(...a), null, JSON.stringify(a.slice(2)));
  nope(l, splits, [], 2, 'ArrowUp');
  nope(l, splits, [], 0, 'ArrowLeft');
  nope(l, splits, [], 3, 'ArrowLeft');
  nope(l, splits, [0], 1, 'ArrowLeft');
  nope(l, splits, [-1], 1, 'ArrowLeft');
  nope(l, splits, [3], 1, 'ArrowLeft');
  nope(l, splits, [1.5], 1, 'ArrowLeft');
  nope(l, splits, 'x', 1, 'ArrowLeft');
  nope(l, 'x', [], 1, 'ArrowLeft');
  nope(l, [], [], 2, 'ArrowLeft');
  nope(null, splits, [], 2, 'ArrowLeft');
  nope({ root: null }, splits, [], 2, 'ArrowLeft');
  nope(l, [null, { path: 'x' }, { path: [0] }, { path: [] , px: [1], min: [1] }], [], 2, 'ArrowLeft');
  assert.strictEqual(V.dividerKey(l, splits, [], 2, 'ArrowUp'), null);
});

test('M13: dividerKeySizes walks the path through nested splits, and stops at a leaf', () => {
  const l = kv2(krow([kterm, kcol([kg('x', 'a'), kg('y', 'b'), kg('z', 'c')], [1, 1, 1])], [0, 200]));
  const { splits } = T.fit(l, { active: {}, foldAll: false }, { width: 1200, height: 900 });
  assert.deepStrictEqual(V.dividerKeySizes(l, splits, [1], 1, 'ArrowDown').sizes, [313, 281, 296]);
  assert.strictEqual(V.dividerKeySizes(l, splits, [1, 0], 1, 'ArrowDown'), null, 'a group is not a split');
  assert.strictEqual(V.dividerKeySizes(l, splits, [1], 1, 'ArrowRight'), null, 'a column does not take left/right');
});

test('M13: rebaseDrag: only the divider\'s two neighbours are the drag\'s; every other fixed kid keeps what is stored now', () => {
  const l = kv2(krow([kg('l', 'a'), kterm, kg('r', 'b')], [150, 0, 150]));
  assert.deepStrictEqual(V.rebaseDrag(l, { path: [], i: 2, node: l.root, sizes: [150, 200, 160] }), [150, 200, 160]);
  assert.deepStrictEqual(V.rebaseDrag(l, { path: [], i: 2, node: l.root, sizes: [140, 200, 160] }), [150, 200, 160], 'kid 0 is not a neighbour: stored wins');
  assert.deepStrictEqual(V.rebaseDrag(l, { path: [], i: 1, node: l.root, sizes: [140, 200, 160] }), [140, 200, 150], 'now kid 0 is a neighbour');
  const plain = kv2(krow([kterm, kcol([kg('x', 'a'), kg('y', 'b')], [1, 1])], [0, 200]));
  const colNode = plain.root.kids[1];
  const copy = V.rebaseDrag(plain, { path: [1], i: 1, node: colNode, sizes: [3, 5] });
  assert.deepStrictEqual(copy, [3, 5]);
  const drag = { path: [1], i: 1, node: colNode, sizes: [3, 5] };
  assert.notStrictEqual(V.rebaseDrag(plain, drag), drag.sizes, 'a copy');
  const base = { path: [], i: 2, node: l.root, sizes: [150, 200, 160] };
  const bad = [
    null, 'x', [], { ...base, path: 'x' }, { ...base, node: null }, { ...base, node: 'x' }, { ...base, sizes: 'x' }, { ...base, sizes: [150, 0, 160] },
    { ...base, sizes: [150, NaN, 160] }, { ...base, sizes: [150, '200', 160] }, { ...base, i: 1.5 }, { ...base, i: '2' }, { ...base, path: [-1] },
    { ...base, path: [3] }, { ...base, path: [0] }, { ...base, node: { ...l.root, dir: 'col' } }, { ...base, node: { ...l.root, kids: l.root.kids.slice(1) } },
    { ...base, sizes: [150, 200] }, { ...base, node: krow([kg('p', 'a'), kg('q', 'b'), kg('r', 'c')], [1, 1, 1]) },
  ];
  for (const d of bad) assert.strictEqual(V.rebaseDrag(l, d), null, JSON.stringify(d));
  for (const layout of [null, 'x', {}, { root: null }, { root: 'x' }]) assert.strictEqual(V.rebaseDrag(layout, base), null);
  const noTerm = { root: krow([kg('l', 'a'), kg('m', 'b'), kg('r', 'c')], [150, 150, 150]) };
  assert.strictEqual(V.rebaseDrag(noTerm, { path: [], i: 2, node: l.root, sizes: [150, 200, 160] }), null, 'the terminal is gone from this split');
});

test('M13: floatDragResult: a drag is applied to the float as it is NOW; a changed float, junk, or a move nobody can see stores nothing', () => {
  const base = kv2(krow([kterm, kg('r', 'a', 'b', 'c', 'd')], [0, 200]));
  const fl = T.dock(base, 'a', { float: { x: 100, y: 100, w: 300, h: 200 } });
  const id = fl.floats[0].id;
  const vp = { width: 1000, height: 600 };
  const drag = { kind: 'move', id, tabs: ['a'], last: { x: 200, y: 150 }, viewport: vp };
  const moved = V.floatDragResult(fl, drag);
  assert.notStrictEqual(moved, fl);
  assert.deepStrictEqual([moved.floats[0].x, moved.floats[0].y], [200, 150]);
  assert.strictEqual(V.floatDragResult(fl, { ...drag, last: { x: 100, y: 100 } }), fl, 'a press that moves nothing stores nothing');
  const resized = V.floatDragResult(fl, { kind: 'resize', id, tabs: ['a'], last: { w: 400, h: 300 }, viewport: vp });
  assert.deepStrictEqual([resized.floats[0].w, resized.floats[0].h], [400, 300]);
  for (const bad of [null, 'x', { ...drag, kind: 'other' }, { ...drag, kind: undefined }, { ...drag, id: 'nope' }, { ...drag, tabs: ['b'] }, { ...drag, tabs: ['a', 'b'] },
    { ...drag, tabs: [] }, { ...drag, tabs: 'a' }, { ...drag, tabs: undefined }]) assert.strictEqual(V.floatDragResult(fl, bad), null, JSON.stringify(bad));
  for (const layout of [null, 'x', {}, { floats: 'x' }]) assert.strictEqual(V.floatDragResult(layout, drag), null);
  const two = { ...fl, floats: [{ ...fl.floats[0], tabs: ['a', 'b'] }] };
  assert.strictEqual(V.floatDragResult(two, { ...drag, tabs: ['a', 'c'] }), null, 'same count, different tabs: another float now holds the name');
  assert.strictEqual(V.floatDragResult(two, { ...drag, tabs: ['b', 'a'] }), null, 'the order matters too');
  const edge = { ...fl, floats: [{ ...fl.floats[0], x: 700, y: 100 }] };
  assert.strictEqual(V.floatDragResult(edge, { ...drag, last: { x: 900, y: 100 } }), edge, 'drawn clamped to the same place: nothing was chosen');
});

test('M13: the small helpers: settleMs, peekFocus and layoutSaved', () => {
  assert.strictEqual(V.settleMs(false), V.SETTLE_MS);
  for (const v of [true, undefined, null, 0, 'false']) assert.strictEqual(V.settleMs(v), 0, String(v));
  assert.strictEqual(V.peekFocus(true, true), 'popover');
  assert.strictEqual(V.peekFocus(true, false), 'popover');
  assert.strictEqual(V.peekFocus(false, true), 'rail');
  assert.strictEqual(V.peekFocus(false, false), 'terminal');
  assert.strictEqual(V.peekFocus('yes', 'yes'), 'terminal');
  assert.strictEqual(V.layoutSaved({}), true);
  assert.strictEqual(V.layoutSaved({ root: 1 }), true);
  for (const v of [null, undefined, [], 'x', 0, true]) assert.strictEqual(V.layoutSaved(v), false, String(v));
});

test('M13: railAfter: a blank pending wait is dropped by any event that keeps the state', () => {
  const idleNoWait = { module: null, held: false, pending: null, leaving: false };
  for (const type of ['hold', 'tab', 'enter', 'nonsense', 'close-timer']) assert.deepStrictEqual(V.railAfter({ module: null, pending: '' }, { type }), idleNoWait, type);
  assert.deepStrictEqual(V.railAfter({ module: null, pending: 'b' }, { type: 'hold' }), { module: null, held: false, pending: 'b', leaving: false }, 'a real wait is kept');
});

test('M13: dividerStep: a split of no known direction takes no key at all', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) assert.strictEqual(V.dividerStep(key, 'diagonal'), null, key);
  assert.strictEqual(V.dividerStep('ArrowUp', undefined), null);
});

test('M13: dividerKeySizes finds the split by its whole path, not by how long it is', () => {
  const l = kv2(krow([kcol([kg('a1', 'a'), kg('a2', 'b')], [1, 1]), kterm, kcol([kg('b1', 'c'), kg('b2', 'd')], [1, 3])], [150, 0, 150]));
  const { splits } = T.fit(l, { active: {}, foldAll: false }, { width: 1200, height: 800 });
  const left = V.dividerKeySizes(l, splits, [0], 1, 'ArrowDown');
  const right = V.dividerKeySizes(l, splits, [2], 1, 'ArrowDown');
  assert.deepStrictEqual(splits.map(s => s.path), [[], [0], [2]]);
  assert.deepStrictEqual(left.sizes, [splits[1].px[0] + 16, splits[1].px[1] - 16]);
  assert.deepStrictEqual(right.sizes, [splits[2].px[0] + 16, splits[2].px[1] - 16]);
  assert.notDeepStrictEqual(left.sizes, right.sizes);
  assert.strictEqual(right.node, l.root.kids[2]);
  assert.strictEqual(V.dividerKeySizes(l, splits, [0, 0, 0], 1, 'ArrowDown'), null, 'a path that runs on through a group');
  assert.strictEqual(V.dividerKeySizes(l, splits, [0, 5], 1, 'ArrowDown'), null);
});

test('M13: sizesAfterDrag: across a rail with the open kid first, last or the terminal itself', () => {
  const node = krow([kg('x', 'a'), kg('y', 'b'), kterm], [180, 180, 0]);
  assert.deepStrictEqual(V.sizesAfterDrag(node, { px: [200, 28, 600], min: [120, 28, 320], state: ['open', 'rail', 'open'] }, 1, 16), [216, 180, 600], 'the first kid is the open one');
  assert.strictEqual(V.sizesAfterDrag(node, { px: [200, 28, 600], min: [120, 28, 320], state: ['open', 'rail', 'open'] }, 2, 16), null, 'the open neighbour IS the terminal: nothing to trade with');
  const t = krow([kterm, kg('x', 'a'), kg('y', 'b')], [0, 180, 180]);
  const atMin = { px: [600, 28, 120], min: [320, 28, 120], state: ['open', 'rail', 'open'] };
  assert.deepStrictEqual(V.sizesAfterDrag(t, atMin, 2, -16), [600, 180, 136], 'a kid exactly at its minimum may still grow');
  assert.strictEqual(V.sizesAfterDrag(t, atMin, 2, 16), null, 'and cannot shrink');
});

test('M13: rebaseDrag: a split below the root is found by its path, and a plain split gives the whole drawn row back', () => {
  const l = kv2(krow([kcol([kg('a1', 'a'), kg('a2', 'b')], [1, 1]), kterm, kg('r', 'c')], [150, 0, 150]));
  const colNode = l.root.kids[0];
  assert.deepStrictEqual(V.rebaseDrag(l, { path: [0], i: 1, node: colNode, sizes: [3, 5] }), [3, 5]);
  const plain = kv2(krow([kterm, kcol([kg('x', 'a'), kg('y', 'b'), kg('z', 'c')], [1, 1, 1])], [0, 200]));
  const three = plain.root.kids[1];
  assert.deepStrictEqual(V.rebaseDrag(plain, { path: [1], i: 1, node: three, sizes: [4, 6, 8] }), [4, 6, 8], 'every drawn size, not the stored proportions');
});

// --- rail tabs: icon + name (BACKLOG #85 follow-up) ----------------------------------------------------------

test('every panel has a Lucide icon, in TABS order, the ones Ricardo picked', () => {
  const R = require('../app/rail-icons');
  const picked = ['users', 'lock', 'bug', 'folder', 'git-branch', 'brain', 'layout-grid', 'palette', 'wand-2', 'bar-chart-3', 'calendar-clock', 'app-window', 'monitor-play', 'message-circle', 'gamepad-2'];
  assert.deepStrictEqual(TABS.map(t => R.ICONS[t.id] && R.ICONS[t.id][0]), picked);
  assert.deepStrictEqual(Object.keys(R.ICONS).sort(), IDS.slice().sort(), 'no icon for a panel that does not exist');
});

test('an icon is one-colour line art: inline, currentColor, no fill, round, weight 1, hidden from a screen reader, nothing fetched', () => {
  const R = require('../app/rail-icons');
  for (const id of IDS) {
    const svg = R.svgFor(id);
    assert.match(svg, /^<svg class="rail-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">/, id);
    assert.ok(svg.endsWith('</svg>'), id);
    assert.ok(/<(path|rect|circle|line)\b/.test(svg), `${id}: has shapes`);
    assert.ok(!/https?:|href|<image|<script|\son\w+=|style=/i.test(svg), `${id}: nothing that loads or runs`);
    assert.strictEqual((svg.match(/<svg/g) || []).length, 1, `${id}: one svg`);
  }
  assert.strictEqual(R.svgFor('nope'), '');
  assert.strictEqual(R.svgFor('__proto__'), '');
});

test('the icon file keeps both licence notices', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'rail-icons.js'), 'utf8');
  assert.match(src, /ISC License/);
  assert.match(src, /Permission to use, copy, modify, and\/or distribute/);
  assert.match(src, /The MIT License \(MIT\)/);
  assert.match(src, /Cole Bemis/);
});

test('the rails are 52 wide beside the terminal and 34 tall above or below it', () => {
  assert.deepStrictEqual(T.RAIL, { side: 52, wide: 34 });
});

test('nameRoom: what a name has inside a rail of this width: the borders, the tab padding and 1 px of slack come off', () => {
  assert.strictEqual(V.nameRoom(52), 52 - 2 - V.NAME_PAD - 1);
  assert.strictEqual(V.nameRoom(0), 0, 'no width: no room, so no fitting');
  assert.strictEqual(V.nameRoom(NaN), 0);
  assert.strictEqual(V.nameRoom(5), 0, 'never negative');
});

test('fitNameSize: 11 px when the name fits, smaller in proportion when it does not, never above 11, no floor', () => {
  assert.strictEqual(V.NAME_MAX, 11);
  assert.strictEqual(V.fitNameSize(30, 46), 11, 'fits');
  assert.strictEqual(V.fitNameSize(46, 46), 11, 'fits exactly');
  assert.strictEqual(V.fitNameSize(92, 46), 5.5, 'twice too wide: half the size');
  assert.strictEqual(V.fitNameSize(920, 46), 0.55, 'no floor');
  assert.strictEqual(V.fitNameSize(0, 46), 11, 'nothing measured: the largest');
  assert.strictEqual(V.fitNameSize(60, 0), 11, 'no room measured (hidden): the largest');
  assert.strictEqual(V.fitNameSize(NaN, 46), 11);
  assert.strictEqual(V.fitNameSize(undefined, 46), 11);
  assert.strictEqual(V.fitNameSize(Infinity, 46), 11);
});

test('fitRowNameSize: names in a row share one size; 11 px when the row fits, else just small enough that it does', () => {
  assert.strictEqual(V.fitRowNameSize([40, 40], 82, 200), 11, 'fits');
  assert.strictEqual(V.fitRowNameSize([40, 40], 82, 162), 11, 'fits exactly');
  assert.strictEqual(V.fitRowNameSize([100, 100], 100, 200), 5.5, 'half the room left for names: half the size');
  assert.strictEqual(V.fitRowNameSize([100, 100], 100, 100), 0.01, 'no room for names at all: the smallest positive size');
  assert.strictEqual(V.fitRowNameSize([100], 100, 50), 0.01, 'less than the chrome: still positive');
  assert.strictEqual(V.fitRowNameSize([], 0, 100), 11);
  assert.strictEqual(V.fitRowNameSize([50, NaN], 10, 20), 11, 'something unmeasured: left alone');
  assert.strictEqual(V.fitRowNameSize([50], 10, 0), 11, 'no length known');
});

test('fitRow: names stay while they are at least 8 px; under that the row goes icons only (the threshold is pinned)', () => {
  assert.strictEqual(V.ICONS_ONLY_BELOW, 8);
  assert.deepStrictEqual(V.fitRow([40, 40], 82, 200), { size: 11, iconsOnly: false }, 'fits');
  // names get 100 px of a 200 px row: 11 * (200 - 100) / 200 = 5.5 -> icons only
  assert.deepStrictEqual(V.fitRow([100, 100], 100, 200), { size: 5.5, iconsOnly: true });
  // 11 * (room - 100) / 200 = 8 at room 245.45..: 246 gives 8.03 (names stay), 245 gives 7.97 (icons only)
  assert.strictEqual(V.fitRow([100, 100], 100, 246).iconsOnly, false);
  assert.strictEqual(V.fitRow([100, 100], 100, 245).iconsOnly, true);
  assert.strictEqual(V.fitRow([35, 35, 35, 35, 35], 205, 180).iconsOnly, true, 'the chrome alone is longer than the rail');
  assert.strictEqual(V.fitRow([], 0, 100).iconsOnly, false);
  assert.strictEqual(V.fitRow([50, NaN], 10, 20).iconsOnly, false, 'unmeasured: left alone');
});

test('fitRowNameSize: the fitted row is never longer than its room', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 8 }), fc.integer({ min: 0, max: 300 }), fc.integer({ min: 50, max: 1500 }), (names, chrome, room) => {
    const s = V.fitRowNameSize(names, chrome, room);
    assert.ok(s > 0 && s <= 11);
    const sum = names.reduce((a, b) => a + b, 0);
    if (room > chrome) assert.ok(sum * (s / 11) + chrome <= room + 1e-9, `${names} + ${chrome} at ${s}px in ${room}`);
  }));
});

test('fitNameSize: the fitted name is never wider than the room', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 10, max: 400 }), (natural, room) => {
    const s = V.fitNameSize(natural, room);
    assert.ok(s > 0 && s <= 11);
    assert.ok(natural * (s / 11) <= room + 1e-9, `${natural} at ${s}px must fit in ${room}`);
  }));
});
