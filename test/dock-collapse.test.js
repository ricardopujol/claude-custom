'use strict';
/**
 * Collapsing one group (BACKLOG #53, dockable panels D4). A window can fold a single group to its rail on
 * purpose, as Ctrl+B folds them all and a narrow window folds them by force. Which groups a window collapsed is
 * that window's SELECTION (localStorage), never the shared layout; the tree only draws the choice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../app/dock-tree');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const g = (id, ...tabs) => ({ type: 'group', id, tabs });
const term = { type: 'term' };
const row = (kids, sizes) => ({ type: 'split', dir: 'row', kids, sizes });
const col = (kids, sizes) => ({ type: 'split', dir: 'col', kids, sizes });
const v2 = (root, extra = {}) => ({ version: 2, root, floats: [], hidden: [], seat: {}, ...extra });
const R = (x, y, width, height) => ({ x, y, width, height });
const VP = { width: 1000, height: 600 };
const NONE = { active: {}, foldAll: false, floatOrder: [], collapsed: {} };
const sel = collapsed => ({ ...NONE, collapsed });
const boxesOf = (l, s, vp = VP) => T.fit(l, s, vp).boxes;
const kinds = bs => bs.map(b => b.kind);

// vault and agents on the right; the terminal flexes.
const ex = () => T.normalize(v2(row([term, g('right', 'agents', 'vault')], [0, 180]), { hidden: IDS.filter(i => !['agents', 'vault'].includes(i)) }), IDS);
// A right column of three groups beside the terminal, and one under the terminal.
const stack = () => T.normalize(v2(col([
  row([term, col([g('top', 'agents'), g('mid', 'vault'), g('low', 'git')], [100, 100, 100])], [0, 200]),
  g('foot', 'fog'),
], [0, 120]), { hidden: IDS.filter(i => !['agents', 'vault', 'git', 'fog'].includes(i)) }), IDS);

// --- the selection --------------------------------------------------------------------------

test('a selection carries the groups this window collapsed: only a list of module ids on a string key survives', () => {
  assert.deepEqual(T.cleanSelection(null).collapsed, {});
  assert.deepEqual(T.cleanSelection({ collapsed: { a: ['git'], b: false, c: 1, d: 'yes', e: null, f: {}, g: true } }).collapsed, { a: ['git'] });
  assert.deepEqual(T.cleanSelection({ collapsed: [['git'], ['git']] }).collapsed, {});
  assert.deepEqual(T.cleanSelection({ collapsed: 'a' }).collapsed, {});
  assert.deepEqual(T.cleanSelection({ collapsed: { '': ['git'] } }).collapsed, {}, 'no empty names');
});

test('a collapse may carry the tabs of the group it was made on: only a non-empty list of strings counts, capped', () => {
  assert.deepEqual(T.cleanSelection({ collapsed: { a: ['vault', 'git'], b: [], c: [1, null], d: [{}], e: ['x', 7] } }).collapsed, { a: ['vault', 'git'], e: ['x'] });
  const big = T.cleanSelection({ collapsed: { a: Array.from({ length: 200 }, (_, i) => `m${i}`) } }).collapsed.a;
  assert.ok(big.length <= 32);
});

test('a damaged file can\'t grow the collapsed list without end', () => {
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`g${i}`, ['git']]));
  assert.ok(Object.keys(T.cleanSelection({ collapsed: many }).collapsed).length <= 64);
});

test('a selection from before D4 (no collapsed key) reads as nothing collapsed', () => {
  assert.deepEqual(T.cleanSelection({ active: { right: 'vault' }, foldAll: true }), { active: { right: 'vault' }, foldAll: true, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.selectionFromV1({ active: { right: 'vault' } }).collapsed, {});
});

test('toggleCollapse collapses a group and expands it again', () => {
  const l = ex();
  const once = T.toggleCollapse(NONE, l, 'right');
  assert.deepEqual(once.collapsed, { right: ['agents', 'vault'] }, 'it remembers WHICH group it was (its tabs), not just a name');
  assert.deepEqual(T.toggleCollapse(once, l, 'right').collapsed, {});
});

test('toggleCollapse leaves everything else in the selection alone', () => {
  const s = { active: { right: 'vault' }, foldAll: true, floatOrder: ['f'], collapsed: { other: ['git'] } };
  const next = T.toggleCollapse(s, ex(), 'right');
  assert.deepEqual(next, { ...s, collapsed: { other: ['git'], right: ['agents', 'vault'] } });
});

test('only a group in the tree collapses: not the terminal, a float, an unknown name or junk', () => {
  const l = T.dock(ex(), 'vault', { float: { x: 40, y: 40 } });
  const floatId = l.floats[0].id;
  for (const id of ['term', floatId, 'nope', '', 7, null, undefined, {}]) {
    assert.deepEqual(T.toggleCollapse(NONE, l, id), NONE, String(id));
  }
});

test('selecting a tab in a collapsed group opens the group (a dropped or ticked panel must be seen)', () => {
  const s = T.selectTab(sel({ right: ['agents', 'vault'], other: ['git'] }), ex(), 'vault');
  assert.deepEqual(s.collapsed, { other: ['git'] });
  assert.equal(s.active.right, 'vault');
});

test('pruneCollapsed forgets groups that no longer exist, so a reused name starts open', () => {
  const l = ex();
  assert.deepEqual(T.pruneCollapsed(sel({ right: ['agents', 'vault'], g9: ['git'] }), l).collapsed, { right: ['agents', 'vault'] });
  const s = sel({ right: ['agents', 'vault'] });
  assert.equal(T.pruneCollapsed(s, l), s, 'the very same selection when nothing was stale');
});

// --- fit -------------------------------------------------------------------------------------

test('nothing collapsed draws what it always did', () => {
  assert.deepEqual(T.fit(ex(), NONE, VP), T.fit(ex(), { active: {}, foldAll: false }, VP));
});

test('a collapsed group beside the terminal is a 28 px rail on its edge; the terminal takes the room', () => {
  const b = boxesOf(ex(), sel({ right: ['agents', 'vault'] }));
  assert.deepEqual(kinds(b), ['term', 'rail']);
  assert.deepEqual(b[0].rect, R(0, 0, 972, 600));
  assert.deepEqual(b[1].rect, R(972, 0, 28, 600));
  assert.equal(b[1].dir, 'v');
  assert.deepEqual(b[1].modules, ['agents', 'vault']);
});

test('a collapsed group under the terminal is a 30 px horizontal rail', () => {
  const l = T.normalize(v2(col([term, g('foot', 'agents', 'vault')], [0, 160]), { hidden: IDS.slice(2) }), IDS);
  const b = boxesOf(l, sel({ foot: ['agents', 'vault'] }));
  assert.deepEqual(b[0].rect, R(0, 0, 1000, 570));
  assert.deepEqual(b[1], { kind: 'rail', dir: 'h', modules: ['agents', 'vault'], groups: [{ id: 'foot', tabs: ['agents', 'vault'] }], rect: R(0, 570, 1000, 30) });
});

test('in a column of groups, a collapsed one is a rail and the others share the rest without a gutter against it', () => {
  const l = stack();
  const b = boxesOf(l, sel({ mid: ['vault'] }));
  const mid = b.find(x => x.kind === 'rail' && x.modules.includes('vault'));
  assert.equal(mid.dir, 'h');
  assert.equal(mid.rect.height, 30);
  assert.equal(mid.rect.width, b.find(x => x.id === 'top').rect.width, 'as wide as its column');
  const top = b.find(x => x.id === 'top');
  const low = b.find(x => x.id === 'low');
  assert.equal(top.rect.y + top.rect.height, mid.rect.y, 'no gutter between an open group and a rail');
  assert.equal(mid.rect.y + mid.rect.height, low.rect.y);
  assert.equal(top.rect.height + 30 + low.rect.height, 600 - 120 - 5, 'the column spends its whole height (less the terminal row\'s foot, and one gutter)');
});

test('an open pair keeps its gutter; collapsing neither is the old picture', () => {
  const b = boxesOf(stack(), NONE);
  assert.equal(b.filter(x => x.kind === 'gutter' && x.path.join('.') === '0.1').length, 2);
});

test('Dexter 2 (option A): a column whose every group is collapsed is drawn as ONE rail, so what is drawn is what was chosen', () => {
  const all = boxesOf(stack(), sel({ top: ['agents'], mid: ['vault'], low: ['git'] }));
  const rails = all.filter(x => x.kind === 'rail');
  assert.equal(rails.length, 1, 'one rail for the whole column');
  assert.deepEqual(rails[0].modules, ['agents', 'vault', 'git']);
  assert.equal(rails[0].dir, 'v');
  assert.equal(rails[0].rect.width, 28);
  assert.equal(all.filter(x => x.kind === 'group' && ['top', 'mid', 'low'].includes(x.id)).length, 0);
  assert.ok(all.find(x => x.kind === 'term').rect.width >= 320);
});

test('Dexter 2 (option A): collapsing the last open group of a column folds the column and opens nothing else', () => {
  const two = boxesOf(stack(), sel({ top: ['agents'], mid: ['vault'] }));
  assert.deepEqual(two.filter(x => x.kind === 'group').map(x => x.id).sort(), ['foot', 'low']);
  const three = boxesOf(stack(), sel({ top: ['agents'], mid: ['vault'], low: ['git'] }));
  assert.deepEqual(three.filter(x => x.kind === 'group').map(x => x.id), ['foot']);
});

test('Dexter 2 (option A): opening one group of a folded column draws it open and keeps the others as rails', () => {
  const b = boxesOf(stack(), sel({ top: ['agents'], mid: ['vault'] }));
  assert.ok(boxOf(b, 'low'), 'low is open');
  assert.equal(b.filter(x => x.kind === 'rail').length, 2);
});

test('Dexter 2 (option A): a selection from a tab click on one group of a folded column leaves the others folded', () => {
  const l = stack();
  const s = sel({ top: ['agents'], mid: ['vault'], low: ['git'] });
  const next = T.selectTab(s, l, 'vault');
  assert.deepEqual(Object.keys(next.collapsed).sort(), ['low', 'top']);
  const b = boxesOf(l, next);
  assert.ok(boxOf(b, 'mid'));
  assert.equal(b.filter(x => x.kind === 'rail').length, 2);
});

test('collapsing the group beside the terminal while another is open leaves one rail and one panel', () => {
  const l = T.normalize(v2(row([g('l', 'git'), term, g('r', 'agents')], [150, 0, 200]), { hidden: IDS.filter(i => !['git', 'agents'].includes(i)) }), IDS);
  const b = boxesOf(l, sel({ l: ['git'] }));
  assert.deepEqual(kinds(b), ['rail', 'term', 'gutter', 'group']);
  assert.deepEqual(b[0].rect, R(0, 0, 28, 600));
  assert.deepEqual(b[1].rect, R(28, 0, 767, 600));
  assert.deepEqual(b[3].rect, R(800, 0, 200, 600));
});

test('the stored layout and the selection are never changed by drawing a collapse', () => {
  const l = JSON.stringify(ex());
  const s = Object.freeze({ ...NONE, collapsed: Object.freeze({ right: ['agents', 'vault'] }) });
  T.fit(ex(), s, VP);
  assert.equal(JSON.stringify(ex()), l);
});

test('a float is never collapsed by this: its id in the list changes nothing', () => {
  const l = T.dock(ex(), 'vault', { float: { x: 40, y: 40 } });
  assert.deepEqual(T.fit(l, sel({ [l.floats[0].id]: ['vault'] }), VP), T.fit(l, NONE, VP));
});

test('a collapsed group still folds the rest by the usual rule when the window is tight', () => {
  const l = T.normalize(v2(row([g('l', 'git'), term, g('r', 'agents')], [200, 0, 200]), { hidden: IDS.filter(i => !['git', 'agents'].includes(i)) }), IDS);
  // 520 wide: the terminal's 320 + 28 for the collapsed rail leaves 172 for the other, under nothing of its own -> it asked 200, gets what fits
  const b = boxesOf(l, sel({ l: ['git'] }), { width: 520, height: 600 });
  const term0 = b.find(x => x.kind === 'term');
  assert.ok(term0.rect.width >= 320);
});

// --- PR #159 Dexter 1: a divider beside a collapsed group never stores the rail's pixels -----------

const V = require('../app/dock-tree-display');
const { TABS } = require('../app/side-tabs');
const fc = require('fast-check');
const dkey = (l, s, vp, path, i, key) => V.dividerKey(l, V.treePlan(l, s, TABS, vp, {}).splits, path, i, key);
const twoRight = () => T.normalize(v2(row([term, g('g1', 'vault'), g('g2', 'git')], [0, 180, 200]), { hidden: IDS.filter(i => !['vault', 'git'].includes(i)) }), IDS);
const column = () => T.normalize(v2(row([term, col([g('c1', 'vault'), g('c2', 'git'), g('c3', 'fog')], [1, 1, 1])], [0, 300]), { hidden: IDS.filter(i => !['vault', 'git', 'fog'].includes(i)) }), IDS);

test('D1: ArrowRight on the divider between a collapsed group and the next stores the open one only; the rail keeps its 180', () => {
  const next = dkey(twoRight(), sel({ g1: ['vault'] }), { width: 1200, height: 800 }, [], 2, 'ArrowRight');
  assert.ok(next, 'it moves');
  assert.equal(next.root.sizes[1], 180, 'the collapsed group\'s stored size is untouched');
  assert.equal(next.root.sizes[2], 184, 'the open one gave 16 px to the terminal');
});

test('D1: ...and the open group can still grow, toward the terminal\'s side', () => {
  const next = dkey(twoRight(), sel({ g1: ['vault'] }), { width: 1200, height: 800 }, [], 2, 'ArrowLeft');
  assert.deepEqual([next.root.sizes[1], next.root.sizes[2]], [180, 216]);
});

test('D1: in a column, a divider beside a collapsed group keeps the rail\'s share of the column', () => {
  const l = column();
  const next = dkey(l, sel({ c1: ['vault'] }), { width: 1200, height: 900 }, [1], 2, 'ArrowDown');
  assert.ok(next);
  const sizes = next.root.kids[1].sizes;
  const share = sizes[0] / (sizes[0] + sizes[1] + sizes[2]);
  assert.ok(Math.abs(share - 1 / 3) < 0.01, `c1's share is ${share}`);
  assert.ok(sizes[1] > sizes[2], 'and the divider moved');
});

test('D1: a drag asks the same thing of the same rules (sizesAfterDrag), so a pointer cannot store a rail either', () => {
  const l = twoRight();
  const p = V.treePlan(l, sel({ g1: ['vault'] }), TABS, { width: 1200, height: 800 }, {});
  const out = V.sizesAfterDrag(l.root, p.splits[0], 2, 16);
  assert.equal(out[1], 180);
});

test('D1 property: whatever is collapsed and whichever divider key is pressed, the collapsed groups keep their stored size', () => {
  const sizeArb = fc.integer({ min: 120, max: 400 });
  fc.assert(fc.property(fc.array(sizeArb, { minLength: 3, maxLength: 3 }), fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }), fc.integer({ min: 1, max: 3 }), fc.constantFrom('ArrowLeft', 'ArrowRight'), fc.integer({ min: 700, max: 2000 }), (sz, shut, i, key, width) => {
    const l = T.normalize(v2(row([g('a', 'vault'), term, g('b', 'git'), g('c', 'fog')], [sz[0], 0, sz[1], sz[2]]), { hidden: IDS.filter(x => !['vault', 'git', 'fog'].includes(x)) }), IDS);
    const collapsed = {};
    ['a', 'b', 'c'].forEach((id, k) => { if (shut[k]) collapsed[id] = [['vault'], ['git'], ['fog']][k]; });
    const next = dkey(l, sel(collapsed), { width, height: 800 }, [], i, key);
    fc.pre(next !== null);
    ['a', 'b', 'c'].forEach((id, k) => {
      if (!collapsed[id]) return;
      const at = next.root.kids.findIndex(x => x.id === id);
      assert.equal(next.root.sizes[at], l.root.sizes[l.root.kids.findIndex(x => x.id === id)], `${id} was stored as ${next.root.sizes[at]}`);
    });
  }), { numRuns: 300 });
});

// --- PR #159 Dexter 3: a collapse is about THE group it was made on, not the name it carried ---------

test('D3: a different group that reuses the name is drawn open (a preset or a reset pushed by another window)', () => {
  const l = ex();                                       // group "right" holds agents and vault
  const s = T.toggleCollapse(NONE, l, 'right');
  const other = T.normalize(v2(row([term, g('right', 'git', 'fog')], [0, 180]), { hidden: IDS.filter(i => !['git', 'fog'].includes(i)) }), IDS);
  const b = boxesOf(other, s);
  assert.deepEqual(kinds(b), ['term', 'gutter', 'group'], 'open: a group, not a rail');
  assert.deepEqual(T.pruneCollapsed(s, other).collapsed, {}, 'and the stale choice is forgotten');
});

test('D3: the same group with a tab added or taken away stays collapsed', () => {
  const s = T.toggleCollapse(NONE, ex(), 'right');
  const more = T.normalize(v2(row([term, g('right', 'agents', 'vault', 'git')], [0, 180]), { hidden: IDS.filter(i => !['agents', 'vault', 'git'].includes(i)) }), IDS);
  const less = T.normalize(v2(row([term, g('right', 'vault')], [0, 180]), { hidden: IDS.filter(i => i !== 'vault') }), IDS);
  assert.deepEqual(kinds(boxesOf(more, s)), ['term', 'rail']);
  assert.deepEqual(kinds(boxesOf(less, s)), ['term', 'rail']);
  assert.equal(T.pruneCollapsed(s, more), s);
});

test('D3: isCollapsed reads a remembered tab list: the group that held one of its tabs', () => {
  const gr = { id: 'right', tabs: ['git'] };
  assert.equal(T.isCollapsed({ collapsed: { right: ['git', 'fog'] } }, gr), true);
  assert.equal(T.isCollapsed({ collapsed: { right: ['vault'] } }, gr), false);
  assert.equal(T.isCollapsed({ collapsed: {} }, gr), false);
  assert.equal(T.isCollapsed(null, gr), false);
});

// --- PR #159 Dexter 3: a rail costs a rail, not a panel's minimum ---------------------------------

// Dropping gB below the terminal, then gL left of it, then gR on the far right.
const nested = () => T.normalize(v2(row([
  col([row([g('gL', 'git'), term], [180, 0]), g('gB', 'fog')], [0, 160]),
  g('gR', 'agents'),
], [0, 180]), { hidden: IDS.filter(i => !['git', 'fog', 'agents'].includes(i)) }), IDS);
const boxOf = (bs, id) => bs.find(x => x.id === id);

test('Dexter 3: collapsing a group beside the terminal never makes another group fold (the rail costs 28, not 120)', () => {
  const vp = { width: 520, height: 600 };
  const open = boxesOf(nested(), NONE, vp);
  const shut = boxesOf(nested(), sel({ gL: ['git'] }), vp);
  assert.ok(boxOf(shut, 'gR'), 'gR is still a panel');
  assert.ok(boxOf(shut, 'gR').rect.width >= 120);
  assert.ok(shut.find(x => x.kind === 'term').rect.width >= 320);
  assert.equal(shut.filter(x => x.kind === 'rail').length, 1, 'only the group that was collapsed is a rail');
  assert.ok(open.filter(x => x.kind === 'rail').length >= shut.filter(x => x.kind === 'rail').length - 1);
});

test('Dexter 3: the divider beside a split that holds a rail is held to the rail\'s minimum, not the panel\'s', () => {
  const f = T.fit(nested(), sel({ gL: ['git'] }), { width: 900, height: 600 });
  const root = f.splits.find(s => s.path.length === 0);
  assert.equal(root.min[0], 28 + 320, 'the column on the left needs a rail and the terminal');
});
