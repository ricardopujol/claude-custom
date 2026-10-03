'use strict';
/**
 * Floating panels (BACKLOG #53, dockable panels D2): the model's rules for a float, a tab group that
 * hangs over the dock area instead of sitting in the tree. Examples here; the properties that must
 * hold after any mix of them are in test/dock-tree-properties.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../app/dock-tree');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const g = (id, ...tabs) => ({ type: 'group', id, tabs });
const term = { type: 'term' };
const row = (kids, sizes) => ({ type: 'split', dir: 'row', kids, sizes });
const v2 = (root, extra = {}) => ({ version: 2, root, floats: [], hidden: [], seat: {}, ...extra });
const fl = (id, tabs, x = 10, y = 20, w = 300, h = 200) => ({ id, tabs, x, y, w, h });
const deepFreeze = (o) => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

// The terminal, group `a` (agents, vault) and group `b` (the rest) on its right, and `git` floating as `f`.
const col = (kids, sizes) => ({ type: 'split', dir: 'col', kids, sizes });
const base = () => T.normalize(v2(row([term, col([g('a', 'agents', 'vault'), g('b', 'bugvault', 'fog', 'models', 'projects', 'style')], [1, 1])], [0, 200]), { floats: [fl('f', ['git'])] }), IDS);

// --- normalize -------------------------------------------------------------------

test('a stored float survives normalize with its modules, position and size', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS.filter(i => i !== 'git'))], [0, 200]), { floats: [fl('f', ['git'], 12, 34, 400, 250)] }), IDS);
  assert.deepEqual(l.floats, [fl('f', ['git'], 12, 34, 400, 250)]);
  assert.ok(!T.groups(l).some(gr => gr.tabs.includes('git')), 'git is in the float only');
});

test('every module once: a module in the tree AND a float stays in the tree (first place wins), and an emptied float goes', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS)], [0, 200]), { floats: [fl('f', ['git', 'vault']), fl('h', ['agents'])] }), IDS);
  assert.deepEqual(l.floats, []);
  assert.deepEqual(T.groups(l)[0].tabs, IDS);
});

test('a float is a place of its own: a module only it lists is not "missing" from the tree', () => {
  const l = T.normalize(v2(term, { floats: [fl('f', ['git'])] }), IDS);
  assert.deepEqual(l.floats.map(f => f.tabs), [['git']]);
  const inTree = T.groups(l).flatMap(gr => gr.tabs);
  assert.deepEqual([...inTree, 'git'].sort(), [...IDS].sort());
});

test('unknown and repeated modules leave a float; a float with none left is dropped', () => {
  const l = T.normalize(v2(row([term, g('a', 'agents')], [0, 200]), { floats: [fl('f', ['ghost', 'git', 'git', 7]), fl('e', ['ghost']), fl('n', [])] }), IDS);
  assert.deepEqual(l.floats.map(f => [f.id, f.tabs]), [['f', ['git']]]);
});

test('float ids share the group namespace: unique, never the terminal\'s name, never a name a seat still holds', () => {
  const raw = v2(row([term, g('a', 'agents')], [0, 200]), {
    floats: [fl('a', ['git']), fl('term', ['fog']), fl('x', ['models']), fl('x', ['style']), { tabs: ['vault'], x: 1, y: 1, w: 300, h: 200 }],
    hidden: ['bugvault'], seat: { bugvault: { group: 'g1', beside: null, side: 'center' } },
  });
  const l = T.normalize(raw, IDS);
  const ids = [...T.groups(l).map(x => x.id), ...l.floats.map(f => f.id)];
  assert.equal(new Set(ids).size, ids.length, `ids ${ids}`);
  assert.ok(!ids.includes('term'));
  assert.ok(!l.floats.some(f => f.id === 'g1'), 'g1 is held by a seat; it can\'t name a new float');
  assert.equal(l.floats.length, 5);
});

test('float sizes are clamped to [160 x 120, 10000] and a bad size is the default 320 x 260', () => {
  const raw = v2(row([term, g('a', 'agents')], [0, 200]), {
    floats: [
      fl('s', ['git'], 5, 5, 10, 10), fl('b', ['fog'], 5, 5, 1e306, 99999),
      { id: 'n', tabs: ['models'], x: 5, y: 5, w: null, h: 'x' }, { id: 'z', tabs: ['style'], x: 5, y: 5, w: 0, h: -4 },
    ],
  });
  const by = Object.fromEntries(T.normalize(raw, IDS).floats.map(f => [f.id, [f.w, f.h]]));
  assert.deepEqual(by, { s: [160, 120], b: [10000, 10000], n: [320, 260], z: [320, 260] });
});

test('a float position is a whole number from 0 up; junk takes the cascade spot, never 0 from Number(null)', () => {
  const raw = v2(row([term, g('a', 'agents')], [0, 200]), {
    floats: [fl('p', ['git'], 12.6, 3.2), fl('b', ['fog'], -40, -1), { id: 'c', tabs: ['models'], x: null, y: undefined, w: 300, h: 200 }, fl('d', ['style'], 1e306, NaN)],
  });
  const by = Object.fromEntries(T.normalize(raw, IDS).floats.map(f => [f.id, [f.x, f.y]]));
  assert.deepEqual(by.p, [13, 3]);
  assert.deepEqual(by.b, [0, 0]);
  assert.deepEqual(by.c, [T.CASCADE, T.CASCADE]);
  assert.deepEqual(by.d, [10000, T.CASCADE]);
});

test('floats that are not an array, or hold junk, are no floats', () => {
  for (const floats of [null, 7, 'x', {}, [null, 7, [], 'x', { tabs: 'git' }]]) {
    const l = T.normalize(v2(row([term, g('a', ...IDS)], [0, 200]), { floats }), IDS);
    assert.deepEqual(l.floats, []);
  }
});

test('normalize with floats never changes its input and is idempotent', () => {
  const raw = deepFreeze(v2(row([term, g('a', 'agents', 'nope')], [0, 300]), { floats: [fl('f', ['git', 'git']), { tabs: ['fog'], x: 'q' }] }));
  const once = T.normalize(raw, IDS);
  assert.deepEqual(T.normalize(once, IDS), once);
});

test('a seat naming a float keeps it while the float lives, and a seat\'s float rectangle is validated', () => {
  const rect = { x: 30, y: 40, w: 300, h: 200 };
  const raw = v2(row([term, g('a', 'agents', 'models', 'style', 'projects', 'bugvault')], [0, 200]), {
    floats: [fl('f', ['git'])], hidden: ['vault', 'fog'],
    seat: {
      vault: { group: 'f', beside: 'git', side: 'center' },
      fog: { group: null, beside: null, side: 'center', float: rect },
    },
  });
  const l = T.normalize(raw, IDS);
  assert.deepEqual(l.seat.vault, { group: 'f', beside: 'git', side: 'center' });
  assert.deepEqual(l.seat.fog, { group: null, beside: null, side: 'center', float: rect });
  const bad = T.normalize({ ...raw, seat: { fog: { group: null, beside: null, side: 'center', float: { x: 'a', y: 1, w: 300, h: 200 } } } }, IDS);
  assert.deepEqual(bad.seat.fog, { group: null, beside: null, side: 'center' });
});

test('the default layout has no floats', () => {
  assert.deepEqual(T.defaultLayout(IDS).floats, []);
});

test('base() builds the example the next tests share', () => {
  const l = base();
  assert.deepEqual(l.floats, [fl('f', ['git'])]);
});

// --- dock to and from floats -----------------------------------------------------

const tabsOf = (l, id) => (T.allGroups(l).find(x => x.id === id) || { tabs: null }).tabs;

test('floating a tree panel: it leaves its group and becomes a float at the spot, default size', () => {
  const l = T.dock(base(), 'vault', { float: { x: 100, y: 60 } });
  assert.deepEqual(tabsOf(l, 'a'), ['agents']);
  assert.equal(l.floats.length, 2);
  const f = l.floats[1];
  assert.deepEqual([f.tabs, f.x, f.y, f.w, f.h], [['vault'], 100, 60, T.FLOAT_DEFAULT.width, T.FLOAT_DEFAULT.height]);
  assert.ok(!['a', 'f', 'term'].includes(f.id));
});

test('floating the only panel of a group removes the group from the tree', () => {
  const one = T.normalize(v2(row([term, g('a', 'agents')], [0, 200]), { floats: [fl('f', ['git'])], hidden: IDS.filter(i => !['agents', 'git'].includes(i)) }), IDS);
  const l = T.dock(one, 'agents', { float: true });
  assert.equal(T.groups(l).length, 0, 'no group is left');
  assert.equal(T.count(l, 'term'), 1);
  assert.equal(l.floats.length, 2);
});

test('{ float: true } floats at a cascade spot; each new float is offset so they never stack exactly', () => {
  let l = base();
  const spots = [];
  for (const id of ['agents', 'vault', 'fog']) {
    l = T.dock(l, id, { float: true });
    const f = T.floatOf(l, id);
    spots.push(`${f.x},${f.y}`);
  }
  assert.equal(new Set(spots).size, 3, spots.join(' '));
});

test('a hidden module can float too, and leaves hidden and its seat', () => {
  const l = T.dock(T.hide(base(), 'vault'), 'vault', { float: { x: 5, y: 5 } });
  assert.ok(T.floatOf(l, 'vault'));
  assert.deepEqual(l.hidden, []);
  assert.deepEqual(l.seat, {});
});

test('a float target is read strictly: junk positions take the cascade spot, junk sizes the default', () => {
  const l = T.dock(base(), 'vault', { float: { x: null, y: 'q', w: -3, h: NaN } });
  const f = T.floatOf(l, 'vault');
  assert.ok(f.x >= 0 && f.y >= 0);
  assert.deepEqual([f.w, f.h], [T.FLOAT_DEFAULT.width, T.FLOAT_DEFAULT.height]);
});

test('a float that is not a spot at all changes nothing', () => {
  const l = base();
  for (const junk of [{ float: 7 }, { float: 'x' }, { float: null }, { float: false }, { float: [] }]) {
    assert.equal(T.dock(l, 'vault', junk), l);
  }
});

test('floating a panel that is alone in its float moves that float (or changes nothing without a spot)', () => {
  const l = base();
  assert.equal(T.dock(l, 'git', { float: true }), l);
  const m = T.dock(l, 'git', { float: { x: 200, y: 90 } });
  assert.deepEqual(m.floats, [fl('f', ['git'], 200, 90)]);
});

test('floating a tab of a multi-tab float splits it out', () => {
  const j = T.dock(base(), 'vault', { cell: 'f', side: 'center' });
  assert.deepEqual(tabsOf(j, 'f'), ['git', 'vault']);
  const l = T.dock(j, 'git', { float: { x: 300, y: 300 } });
  assert.deepEqual(tabsOf(l, 'f'), ['vault']);
  assert.deepEqual(T.floatOf(l, 'git').tabs, ['git']);
});

test('a float as a cell: only "join as a tab" (center); a side or the same float change nothing', () => {
  const l = base();
  const j = T.dock(l, 'vault', { cell: 'f', side: 'center' });
  assert.deepEqual(tabsOf(j, 'f'), ['git', 'vault']);
  assert.deepEqual(tabsOf(j, 'a'), ['agents']);
  for (const side of ['left', 'right', 'top', 'bottom']) assert.equal(T.dock(l, 'vault', { cell: 'f', side }), l, side);
  assert.equal(T.dock(j, 'git', { cell: 'f', side: 'center' }), j, 'a panel dropped on its own float');
});

test('a float joined into another float: the emptied float is dropped', () => {
  const l = T.dock(base(), 'agents', { float: { x: 400, y: 100 } });
  const [first, second] = l.floats;
  assert.equal(l.floats.length, 2);
  const j = T.dock(l, 'agents', { cell: first.id, side: 'center' });
  assert.equal(j.floats.length, 1);
  assert.deepEqual(j.floats[0].tabs, ['git', 'agents']);
  assert.ok(second && !j.floats.some(f => f.id === second.id));
});

test('a float panel docked to the tree: a side of a group, the terminal, a rim; an emptied float is dropped', () => {
  const l = base();
  const edge = T.dock(l, 'git', { edge: 'bottom' });
  assert.deepEqual(edge.floats, []);
  assert.equal(T.groupOf(edge, 'git').tabs.length, 1);
  const side = T.dock(l, 'git', { cell: 'a', side: 'top' });
  assert.deepEqual(side.floats, []);
  assert.equal(T.groupOf(side, 'git').tabs.length, 1);
  const join = T.dock(l, 'git', { cell: 'a', side: 'center' });
  assert.deepEqual(tabsOf(join, 'a'), ['agents', 'vault', 'git']);
  const nextToTerm = T.dock(l, 'git', { cell: 'term', side: 'left' });
  assert.deepEqual(nextToTerm.floats, []);
});

test('docking a lone float panel where its tree shape would not change is still a change: the float is gone', () => {
  // The "same picture" shortcut compares the TREE only; a float panel entering it always differs.
  const l = T.normalize(v2(row([term, g('a', 'agents')], [0, 200]), { floats: [fl('f', ['git'])] }), IDS);
  const next = T.dock(l, 'git', { cell: 'a', side: 'center' });
  assert.notEqual(next, l);
  assert.deepEqual(next.floats, []);
});

test('a lone float panel joining another float is a change even though the tree is the same', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS.filter(i => !['git', 'fog'].includes(i)))], [0, 200]), { floats: [fl('f', ['git']), fl('h', ['fog'])] }), IDS);
  const next = T.dock(l, 'fog', { cell: 'f', side: 'center' });
  assert.notEqual(next, l);
  assert.deepEqual(next.floats.map(f => f.tabs), [['git', 'fog']]);
});

test('floating never changes its input', () => {
  const l = deepFreeze(base());
  T.dock(l, 'vault', { float: { x: 1, y: 2 } });
  T.dock(l, 'git', { cell: 'a', side: 'center' });
});

test('floatOf and allGroups', () => {
  const l = base();
  assert.equal(T.floatOf(l, 'git').id, 'f');
  assert.equal(T.floatOf(l, 'vault'), null);
  assert.deepEqual(T.allGroups(l).map(x => x.id), ['a', 'b', 'f']);
});

// --- hide and show with floats ----------------------------------------------------

test('hiding a tab of a multi-tab float remembers the float; showing it joins that float again', () => {
  const two = T.dock(base(), 'vault', { cell: 'f', side: 'center' });          // f: git, vault
  const h = T.hide(two, 'vault');
  assert.deepEqual(h.hidden, ['vault']);
  assert.deepEqual(h.seat.vault, { group: 'f', beside: 'git', side: 'center' });
  assert.deepEqual(tabsOf(h, 'f'), ['git']);
  const back = T.show(h, 'vault');
  assert.deepEqual(tabsOf(back, 'f'), ['git', 'vault']);
  assert.deepEqual(back.hidden, []);
});

test('hiding a lone floating panel remembers its rectangle; showing it floats it there again', () => {
  const h = T.hide(T.moveFloat(base(), 'f', { x: 77, y: 88 }), 'git');
  assert.deepEqual(h.floats, []);
  assert.deepEqual(h.seat.git, { group: null, beside: null, side: 'center', float: { x: 77, y: 88, w: 300, h: 200 } });
  const back = T.show(h, 'git');
  assert.deepEqual(back.floats.map(f => [f.tabs, f.x, f.y, f.w, f.h]), [[['git'], 77, 88, 300, 200]]);
  assert.deepEqual(back.hidden, []);
  assert.deepEqual(back.seat, {});
});

test('showing a lone floating panel whose rectangle is gone from the seat falls back to the right edge', () => {
  const h = T.hide(base(), 'git');
  delete h.seat.git.float;
  const back = T.show(h, 'git');
  assert.deepEqual(back.floats, []);
  assert.ok(T.groupOf(back, 'git'));
});

test('a seat naming a float that has since gone is dropped to no group, and the panel still comes back', () => {
  const two = T.dock(base(), 'vault', { cell: 'f', side: 'center' });
  const h = T.hide(T.hide(two, 'vault'), 'git');                               // f empties and goes; vault's seat named it
  assert.deepEqual(h.floats, []);
  assert.equal(h.seat.vault.group, null);
  const back = T.show(h, 'vault');
  assert.ok(T.groupOf(back, 'vault'), 'it falls back into the tree');
});

test('hide and show never change their input with floats around', () => {
  const l = deepFreeze(T.dock(base(), 'vault', { cell: 'f', side: 'center' }));
  T.show(T.hide(l, 'git'), 'git');
});

// --- moveFloat, resizeFloat ------------------------------------------------------

test('moveFloat sets the position, rounded and never negative, and keeps the size', () => {
  const l = base();
  assert.deepEqual(T.moveFloat(l, 'f', { x: 50.6, y: 7 }).floats[0], fl('f', ['git'], 51, 7));
  assert.deepEqual(T.moveFloat(l, 'f', { x: -30, y: -1 }).floats[0], fl('f', ['git'], 0, 0));
});

test('moveFloat with a viewport keeps the float whole inside it', () => {
  const l = base();                                                   // 300 x 200
  assert.deepEqual(T.moveFloat(l, 'f', { x: 900, y: 900 }, { width: 800, height: 600 }).floats[0], fl('f', ['git'], 500, 400));
  assert.deepEqual(T.moveFloat(l, 'f', { x: 900, y: 900 }, { width: 200, height: 100 }).floats[0], fl('f', ['git'], 0, 0), 'a float bigger than the window sits at the corner');
});

test('moveFloat: a move that changes nothing, an unknown float and junk all return the very same layout', () => {
  const l = base();
  assert.equal(T.moveFloat(l, 'f', { x: 10, y: 20 }), l);
  assert.equal(T.moveFloat(l, 'nope', { x: 1, y: 1 }), l);
  assert.equal(T.moveFloat(l, 'a', { x: 1, y: 1 }), l, 'a tree group is not a float');
  for (const junk of [null, 7, {}, { x: 1 }, { x: null, y: 2 }, { x: NaN, y: 1 }, { x: Infinity, y: 1 }, 'x', []]) assert.equal(T.moveFloat(l, 'f', junk), l);
});

test('resizeFloat sets the size, rounded, within [160 x 120, 10000], and keeps the position', () => {
  const l = base();
  assert.deepEqual(T.resizeFloat(l, 'f', { w: 410.4, h: 333 }).floats[0], fl('f', ['git'], 10, 20, 410, 333));
  assert.deepEqual(T.resizeFloat(l, 'f', { w: 5, h: 5 }).floats[0], fl('f', ['git'], 10, 20, 160, 120));
  assert.deepEqual(T.resizeFloat(l, 'f', { w: 1e9, h: 1e9 }).floats[0], fl('f', ['git'], 10, 20, 10000, 10000));
});

test('resizeFloat with a viewport stops at the window edge, but never under the minimum', () => {
  const l = base();                                                   // at 10, 20
  assert.deepEqual(T.resizeFloat(l, 'f', { w: 900, h: 900 }, { width: 800, height: 600 }).floats[0], fl('f', ['git'], 10, 20, 790, 580));
  assert.deepEqual(T.resizeFloat(l, 'f', { w: 900, h: 900 }, { width: 100, height: 100 }).floats[0], fl('f', ['git'], 10, 20, 160, 120));
});

test('resizeFloat: no change, unknown float and junk return the same layout', () => {
  const l = base();
  assert.equal(T.resizeFloat(l, 'f', { w: 300, h: 200 }), l);
  assert.equal(T.resizeFloat(l, 'nope', { w: 400, h: 400 }), l);
  for (const junk of [null, 7, {}, { w: 1 }, { w: null, h: 2 }, { w: 0, h: 5 }, { w: -4, h: 9 }, { w: NaN, h: 9 }, 'x']) assert.equal(T.resizeFloat(l, 'f', junk), l);
});

test('moveFloat and resizeFloat never change their input', () => {
  const l = deepFreeze(base());
  T.moveFloat(l, 'f', { x: 1, y: 2 }, { width: 500, height: 500 });
  T.resizeFloat(l, 'f', { w: 500, h: 400 }, { width: 600, height: 600 });
});
