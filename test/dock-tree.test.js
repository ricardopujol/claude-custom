'use strict';
/**
 * The dock tree (BACKLOG #53, D1): the free split tree around the fixed terminal
 * cell. Pure, so every rule is pinned here; the page only draws what `fit` returns.
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

// A throw in a frozen object is how "never mutates its input" fails loudly.
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

// --- defaultLayout / normalize ----------------------------------------------

test('the default is the terminal with every module in one group on the right', () => {
  const l = T.defaultLayout(IDS);
  assert.deepEqual(l.root, row([term, g('right', ...IDS)], [0, 180]));
  assert.deepEqual(l.hidden, []);
});

test('with no modules at all the default is the terminal alone', () => {
  assert.deepEqual(T.defaultLayout([]).root, term);
});

test('anything that is not a version-2 layout normalizes to the default', () => {
  for (const junk of [null, [], 'x', 7, {}, { version: 1, zones: {} }]) {
    assert.deepEqual(T.normalize(junk, IDS), T.defaultLayout(IDS));
  }
});

test('an unknown module id is dropped and a duplicate is kept once, first place wins', () => {
  const l = T.normalize(v2(row([term, g('a', 'agents', 'nope', 'vault'), g('b', 'vault', 'git')], [0, 200, 200]),
    { hidden: ['bugvault', 'fog', 'models', 'projects', 'style'] }), IDS);
  assert.deepEqual(T.groups(l).map(x => x.tabs), [['agents', 'vault'], ['git']]);
});

test('a known module found nowhere joins the first docked group', () => {
  const l = T.normalize(v2(row([term, g('a', 'agents')], [0, 200])), IDS);
  assert.deepEqual(T.groups(l)[0].tabs, IDS);
});

test('with no group at all, a missing module docks on the right', () => {
  const l = T.normalize(v2(term, { hidden: IDS.slice(1) }), IDS);
  assert.deepEqual(l.root, row([term, g('g1', 'agents')], [0, 180]));
});

test('there is exactly one terminal: a second is dropped, a missing one is added', () => {
  const two = T.normalize(v2(row([term, g('a', ...IDS), term], [0, 200, 0])), IDS);
  assert.equal(T.count(two, 'term'), 1);
  const none = T.normalize(v2(g('a', ...IDS)), IDS);
  assert.equal(T.count(none, 'term'), 1);
  assert.deepEqual(none.root, row([term, g('a', ...IDS)], [0, 180]));
});

test('a terminal added to a stored row joins the row, keeping its sizes', () => {
  const l = T.normalize(v2(row([g('a', 'agents'), g('b', ...IDS.slice(1))], [150, 200])), IDS);
  assert.deepEqual(l.root, row([term, g('a', 'agents'), g('b', ...IDS.slice(1))], [0, 150, 200]));
});

test('empty groups go, one-child splits collapse, same-direction nests flatten', () => {
  const l = T.normalize(v2(row([term, row([g('a', 'agents'), g('e')], [1, 1]), col([g('b', ...IDS.slice(1))], [1])], [0, 300, 200])), IDS);
  assert.deepEqual(l.root, row([term, g('a', 'agents'), g('b', ...IDS.slice(1))], [0, 300, 200]));
});

test('a nested split that holds the terminal keeps its own pixel sizes when it flattens', () => {
  const l = T.normalize(v2(row([row([g('a', 'agents'), term], [140, 0]), g('b', ...IDS.slice(1))], [0, 200])), IDS);
  assert.deepEqual(l.root, row([g('a', 'agents'), term, g('b', ...IDS.slice(1))], [140, 0, 200]));
});

test('a nested split without the terminal shares its slot in proportion', () => {
  const l = T.normalize(v2(row([term, row([g('a', 'agents'), g('b', 'vault')], [1, 3])], [0, 400]),
    { hidden: IDS.slice(2) }), IDS);
  assert.deepEqual(l.root, row([term, g('a', 'agents'), g('b', 'vault')], [0, 100, 300]));
});

test('the kid that holds the terminal always stores 0, whatever the file says', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS)], [999, 200])), IDS);
  assert.deepEqual(l.root.sizes, [0, 200]);
  const deep = T.normalize(v2(row([col([term, g('b', 'agents')], [50, 160]), g('a', ...IDS.slice(1))], [77, 200])), IDS);
  assert.deepEqual(deep.root.sizes, [0, 200]);
  assert.deepEqual(deep.root.kids[0].sizes, [0, 160]);
});

test('a stored size that is null, a string, zero or huge is replaced or clamped, never 0', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS)], [0, null])), IDS);
  assert.equal(l.root.sizes[1], 180);
  for (const bad of ['200', 0, -5, NaN, Infinity, undefined]) {
    assert.equal(T.normalize(v2(row([term, g('a', ...IDS)], [0, bad])), IDS).root.sizes[1], 180, String(bad));
  }
  const big = T.normalize(v2(row([term, g('a', ...IDS)], [0, 1e306])), IDS);
  assert.equal(big.root.sizes[1], 10000);
});

// Found by P2 (test/dock-tree-properties.test.js): 5e-324 is "positive", but half of it is 0, and a 0 stored for
// a kid that doesn't hold the terminal is a panel that can never be drawn (the next normalize swaps it for the default).
test('a tiny stored size is raised to 1 and never underflows to 0 when its slot is shared', () => {
  const l = T.normalize(v2(row([term, row([g('a', 'agents'), g('b', ...IDS.slice(1))], [1, 1])], [0, 5e-324])), IDS);
  assert.deepEqual(l.root, row([term, g('a', 'agents'), g('b', ...IDS.slice(1))], [0, 1, 1]));
  assert.deepEqual(T.normalize(l, IDS), l);
  const small = T.normalize(v2(row([term, g('a', ...IDS)], [0, 0.25])), IDS);
  assert.deepEqual(small.root.sizes, [0, 1]);
});

test('a column with a missing size gets the column default', () => {
  const l = T.normalize(v2(col([term, g('a', ...IDS)], [0])), IDS);
  assert.equal(l.root.sizes[1], T.DEFAULT_SIZE.col);
});

test('group ids are unique: a repeated id is renamed', () => {
  const l = T.normalize(v2(row([term, g('a', 'agents'), g('a', ...IDS.slice(1))], [0, 200, 200])), IDS);
  const ids = T.groups(l).map(x => x.id);
  assert.equal(new Set(ids).size, 2);
});

test('a group with no usable id is named after the pass, never reusing a kept id', () => {
  const l = T.normalize(v2(row([term, { type: 'group', tabs: ['agents'] }, g('g1', ...IDS.slice(1))], [0, 200, 200])), IDS);
  assert.deepEqual(T.groups(l).map(x => x.id), ['g2', 'g1']);
});

test('a split nested deeper than the limit is cut, not recursed into without end', () => {
  let n = g('a', ...IDS);
  for (let i = 0; i < 50; i += 1) n = (i % 2 ? row : col)([n, g('x' + i, 'nope')], [1, 1]);
  const l = T.normalize(v2(n), IDS);
  assert.equal(T.count(l, 'term'), 1);
  assert.deepEqual([...T.groups(l).flatMap(x => x.tabs)].sort(), [...IDS].sort());
});

test('hidden keeps each known module once and drops unknown and non-string entries', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS.slice(1))], [0, 200]), { hidden: ['agents', 'agents', 'nope', 3] }), IDS);
  assert.deepEqual(l.hidden, ['agents']);
  assert.deepEqual(T.groups(l).flatMap(x => x.tabs).sort(), IDS.slice(1).sort());
});

test('a module in the tree and in hidden is shown once, in the tree', () => {
  const l = T.normalize(v2(row([term, g('a', ...IDS)], [0, 200]), { hidden: ['vault'] }), IDS);
  assert.deepEqual(l.hidden, []);
});

test('a seat is kept only for a hidden module, and only when well formed', () => {
  const good = { group: 'a', beside: 'git', side: 'bottom' };
  const l = T.normalize(v2(row([term, g('a', ...IDS.slice(2))], [0, 200]), {
    hidden: ['agents', 'vault'],
    seat: {
      agents: good,
      vault: { group: 3, beside: null, side: 'center' },   // wrong type: dropped
      git: good,                                            // not hidden: dropped
      nope: good,
    },
  }), IDS);
  assert.deepEqual(l.seat, { agents: good });
  const bad = T.normalize(v2(row([term, g('a', ...IDS.slice(1))], [0, 200]), {
    hidden: ['agents'], seat: { agents: { group: null, beside: null, side: 'diagonal' } },
  }), IDS);
  assert.deepEqual(bad.seat, {});
});

test('normalize never changes its input and is idempotent', () => {
  const raw = deepFreeze(v2(row([term, row([g('a', 'agents', 'nope'), g('e')], [1, 1]), g('b', 'agents', 'git')], [0, 300, 'x']),
    { hidden: ['vault', 'ghost'], seat: { vault: { group: null, beside: 'git', side: 'left' } } }));
  const once = T.normalize(raw, IDS);
  assert.deepEqual(T.normalize(once, IDS), once);
});

test('groups, count and hasTerm read the tree', () => {
  const l = T.defaultLayout(IDS);
  assert.equal(T.count(l, 'group'), 1);
  assert.equal(T.hasTerm(l.root), true);
  assert.equal(T.hasTerm(g('x', 'agents')), false);
});

// --- docking, hiding, showing -------------------------------------------------

// Ricardo's example: Agents and Vault side by side under the terminal; Git over Map over Bug vault
// in a right column; the rest hidden.
const example = () => T.normalize(v2(row([
  col([term, row([g('a', 'agents'), g('b', 'vault')], [1, 1])], [0, 150]),
  col([g('c', 'git'), g('d', 'fog'), g('e', 'bugvault')], [1, 1, 1]),
], [0, 240]), { hidden: ['models', 'projects', 'style'] }), IDS);

// Every module once and nothing else changed shape: the cheap check run after each operation below.
const modulesOf = l => [...T.groups(l).flatMap(x => x.tabs), ...l.hidden].sort();

test('the example holds every module once and keeps its pixel sizes', () => {
  const l = example();
  assert.deepEqual(modulesOf(l), [...IDS].sort());
  assert.deepEqual(l.root.sizes, [0, 240]);
  assert.deepEqual(l.root.kids[0].sizes, [0, 150]);
});

test('groupOf finds the group holding a module, or null', () => {
  const l = example();
  assert.equal(T.groupOf(l, 'git').id, 'c');
  assert.equal(T.groupOf(l, 'models'), null);
  assert.equal(T.groupOf(l, 'nope'), null);
});

test('docking on a side of a group splits that cell: the old group of a lone tab is gone', () => {
  const l = T.dock(example(), 'vault', { cell: 'c', side: 'right' });
  assert.deepEqual(l.root, row([
    col([term, g('a', 'agents')], [0, 150]),
    col([row([g('c', 'git'), g('g1', 'vault')], [1, 1]), g('d', 'fog'), g('e', 'bugvault')], [1, 1, 1]),
  ], [0, 240]));
});

test('docking on the left or top puts the newcomer first', () => {
  const l = T.dock(example(), 'vault', { cell: 'c', side: 'top' });
  const right = l.root.kids[1];
  assert.deepEqual(right.kids.map(k => k.tabs[0]), ['vault', 'git', 'fog', 'bugvault']);
  const left = T.dock(example(), 'vault', { cell: 'c', side: 'left' });
  assert.deepEqual(left.root.kids[1].kids[0], row([g('g1', 'vault'), g('c', 'git')], [1, 1]));
});

test('center joins the group as its last tab and makes no new cell', () => {
  const l = T.dock(example(), 'vault', { cell: 'c', side: 'center' });
  assert.deepEqual(T.groupOf(l, 'git').tabs, ['git', 'vault']);
  assert.equal(T.groups(l).length, 4);
});

test('center on the terminal changes nothing: the very same layout comes back', () => {
  const l = example();
  assert.equal(T.dock(l, 'vault', { cell: 'term', side: 'center' }), l);
});

test('splitting the terminal: the newcomer takes the default size, the terminal keeps 0', () => {
  const l = T.dock(T.defaultLayout(IDS), 'vault', { cell: 'term', side: 'bottom' });
  assert.deepEqual(l.root, row([col([term, g('g1', 'vault')], [0, 160]), g('right', ...IDS.filter(i => i !== 'vault'))], [0, 180]));
  const left = T.dock(T.defaultLayout(IDS), 'vault', { cell: 'term', side: 'left' });
  assert.deepEqual(left.root, row([g('g1', 'vault'), term, g('right', ...IDS.filter(i => i !== 'vault'))], [180, 0, 180]));
});

test('splitting the terminal inside a column joins that column, whose sizes are pixels', () => {
  const l = T.dock(example(), 'models', { cell: 'term', side: 'bottom' });
  assert.deepEqual(l.root.kids[0], col([term, g('g1', 'models'), row([g('a', 'agents'), g('b', 'vault')], [1, 1])], [0, 160, 150]));
});

test('an edge docks along the whole window edge, flattening into a root of the same direction', () => {
  const d = T.defaultLayout(IDS);
  assert.deepEqual(T.dock(d, 'vault', { edge: 'left' }).root.sizes, [180, 0, 180]);
  assert.deepEqual(T.dock(d, 'vault', { edge: 'left' }).root.kids[0], g('g1', 'vault'));
  assert.deepEqual(T.dock(d, 'vault', { edge: 'right' }).root.kids.map(k => k.type), ['term', 'group', 'group']);
  const top = T.dock(d, 'vault', { edge: 'top' }).root;
  assert.equal(top.dir, 'col');
  assert.deepEqual(top.sizes, [160, 0]);
  assert.deepEqual(top.kids[0], g('g1', 'vault'));
  assert.deepEqual(top.kids[1].kids.map(k => k.type), ['term', 'group']);
  const bottom = T.dock(example(), 'models', { edge: 'bottom' }).root;
  assert.equal(bottom.dir, 'col');
  assert.equal(bottom.kids[1].tabs[0], 'models');
});

test('a panel dropped on its own group: center or a lone tab changes nothing', () => {
  const l = example();
  assert.equal(T.dock(l, 'git', { cell: 'c', side: 'center' }), l);
  assert.equal(T.dock(l, 'git', { cell: 'c', side: 'left' }), l);
  assert.equal(T.dock(l, 'git', { cell: 'c', side: 'bottom' }), l);
});

test('a side of its own group that holds other tabs splits the panel out of it', () => {
  const l = T.dock(T.defaultLayout(IDS), 'agents', { cell: 'right', side: 'bottom' });
  assert.deepEqual(l.root, row([term, col([g('right', ...IDS.slice(1)), g('g1', 'agents')], [1, 1])], [0, 180]));
  // Same direction as the root row: the two share the group's 180 px between them.
  const first = T.dock(T.defaultLayout(IDS), 'git', { cell: 'right', side: 'left' });
  assert.deepEqual(first.root, row([term, g('g1', 'git'), g('right', ...IDS.filter(i => i !== 'git'))], [0, 90, 90]));
});

test('a hidden module can be docked: it leaves hidden and its seat is deleted', () => {
  const l0 = T.hide(example(), 'git');
  assert.ok(l0.seat.git);
  const l = T.dock(l0, 'git', { cell: 'a', side: 'center' });
  assert.deepEqual(l.hidden, ['models', 'projects', 'style']);
  assert.equal(l.seat.git, undefined);
  assert.deepEqual(T.groupOf(l, 'git').tabs, ['agents', 'git']);
});

test('an unknown module, an unknown cell, an unknown side or an unknown target changes nothing', () => {
  const l = example();
  assert.equal(T.dock(l, 'nope', { cell: 'c', side: 'right' }), l);
  assert.equal(T.dock(l, 'vault', { cell: 'nope', side: 'right' }), l);
  assert.equal(T.dock(l, 'vault', { cell: 'c', side: 'diagonal' }), l);
  assert.equal(T.dock(l, 'vault', { edge: 'middle' }), l);
  for (const t of [null, undefined, 7, {}, { float: 7 }]) assert.equal(T.dock(l, 'vault', t), l);   // { float: spot } is a target since D2
});

test('dock, hide and show never change their input and always return a whole layout', () => {
  const l = deepFreeze(example());
  for (const out of [
    T.dock(l, 'vault', { cell: 'c', side: 'right' }), T.dock(l, 'models', { edge: 'top' }),
    T.dock(l, 'agents', { cell: 'term', side: 'right' }), T.hide(l, 'git'), T.show(l, 'models'),
  ]) {
    assert.deepEqual(modulesOf(out), [...IDS].sort());
    assert.deepEqual(T.normalize(out, IDS), out);
  }
});

test('hide in a group that survives records that group, the tab before it, and "center"', () => {
  const l = T.hide(T.defaultLayout(IDS), 'vault');
  assert.deepEqual(l.hidden, ['vault']);
  assert.deepEqual(l.seat.vault, { group: 'right', beside: 'agents', side: 'center' });
  assert.equal(T.groupOf(l, 'vault'), null);
});

test('hide of the first tab of a surviving group is beside the next one', () => {
  const l = T.hide(T.defaultLayout(IDS), 'agents');
  assert.deepEqual(l.seat.agents, { group: 'right', beside: 'vault', side: 'center' });
});

test('hide of a lone tab records the neighbour it sat next to and which side', () => {
  assert.deepEqual(T.hide(example(), 'vault').seat.vault, { group: null, beside: 'agents', side: 'right' });
  assert.deepEqual(T.hide(example(), 'fog').seat.fog, { group: null, beside: 'git', side: 'bottom' });
  assert.deepEqual(T.hide(example(), 'git').seat.git, { group: null, beside: 'vault', side: 'right' });
});

test('hide of the first module in tree order falls back to the next one', () => {
  const l = T.hide(example(), 'agents');
  assert.deepEqual(l.seat.agents, { group: null, beside: 'vault', side: 'left' });
});

test('hide of an unknown or already hidden module changes nothing', () => {
  const l = example();
  assert.equal(T.hide(l, 'nope'), l);
  assert.equal(T.hide(l, 'models'), l);
});

test('hiding the last panel leaves the terminal alone and a seat with no neighbour', () => {
  const one = T.normalize(v2(row([term, g('a', 'agents')], [0, 200])), ['agents']);
  const h = T.hide(one, 'agents');
  assert.deepEqual(h.root, term);
  assert.deepEqual(h.seat.agents, { group: null, beside: null, side: 'center' });
  assert.deepEqual(T.show(h, 'agents').root, row([term, g('g1', 'agents')], [0, 180]));
});

test('hide then show of a panel in a multi-tab group puts it back in that group', () => {
  const l = T.show(T.hide(T.defaultLayout(IDS), 'vault'), 'vault');
  assert.deepEqual(l.hidden, []);
  assert.equal(T.groupOf(l, 'vault').id, 'right');
  assert.deepEqual(l.seat, {});
});

test('hide then show of a lone panel puts it back beside the same neighbour on the same side', () => {
  const back = T.show(T.hide(example(), 'vault'), 'vault');
  assert.deepEqual(back.root.kids[0], col([term, row([g('a', 'agents'), g('g1', 'vault')], [1, 1])], [0, 150]));
  const git = T.show(T.hide(example(), 'fog'), 'fog');
  assert.deepEqual(git.root.kids[1].kids.map(k => k.tabs[0]), ['git', 'fog', 'bugvault']);
});

test('show when the seat group is gone docks beside the neighbour; when that is gone too, on the right', () => {
  const hidden = T.hide(example(), 'vault');
  // The neighbour's group is renamed away from the seat, and the seat has no group: beside it.
  const noGroup = { ...hidden, seat: { vault: { group: 'nope', beside: 'git', side: 'top' } } };
  assert.deepEqual(T.groupOf(T.show(noGroup, 'vault'), 'vault').tabs, ['vault']);
  assert.deepEqual(T.show(noGroup, 'vault').root.kids[1].kids.map(k => k.tabs[0]), ['vault', 'git', 'fog', 'bugvault']);
  const lost = { ...hidden, seat: { vault: { group: null, beside: 'models', side: 'top' } } };   // models is hidden too
  assert.equal(T.show(lost, 'vault').root.kids.at(-1).tabs[0], 'vault');
  const none = { ...hidden, seat: {} };
  assert.equal(T.show(none, 'vault').root.kids.at(-1).tabs[0], 'vault');
});

test('show of a module that is not hidden, or unknown, changes nothing', () => {
  const l = example();
  assert.equal(T.show(l, 'git'), l);
  assert.equal(T.show(l, 'nope'), l);
});

// --- sizes ---------------------------------------------------------------------

test('minSize: the terminal and a panel have their own, a row adds widths and a column adds heights', () => {
  assert.deepEqual(T.minSize(term), { width: 320, height: 160 });
  assert.deepEqual(T.minSize(g('x', 'agents')), { width: 120, height: 80 });
  assert.deepEqual(T.minSize(row([g('x', 'agents'), g('y', 'vault')], [1, 1])), { width: 120 + 5 + 120, height: 80 });
  assert.deepEqual(T.minSize(col([g('x', 'agents'), g('y', 'vault')], [1, 1])), { width: 120, height: 80 + 5 + 80 });
});

test('minSize of the example: the right column is 120 wide and 3 x 80 + 2 gutters tall, the taller side', () => {
  const l = example();
  assert.deepEqual(T.minSize(l.root.kids[1]), { width: 120, height: 250 });
  assert.deepEqual(T.minSize(l.root.kids[0]), { width: 320, height: 160 + 5 + 80 });
  assert.deepEqual(T.minSize(l.root), { width: 320 + 5 + 120, height: 250 });
});

test('setSplitSizes stores rounded pixels, the terminal\'s side keeps 0', () => {
  const l = T.setSplitSizes(example(), [], [999, 300.4]);
  assert.deepEqual(l.root.sizes, [0, 300]);
  const col3 = T.setSplitSizes(example(), [1], [100.6, 200, 300]);
  assert.deepEqual(col3.root.kids[1].sizes, [101, 200, 300]);
  assert.deepEqual(T.setSplitSizes(example(), [0], [1, 120]).root.kids[0].sizes, [0, 120]);
});

test('setSplitSizes raises a size under its minimum and caps a huge one', () => {
  const l = T.setSplitSizes(example(), [1], [10, 200, 300]);
  assert.deepEqual(l.root.kids[1].sizes, [80, 200, 300]);
  assert.deepEqual(T.setSplitSizes(example(), [], [1, 20]).root.sizes, [0, 120]);
  assert.deepEqual(T.setSplitSizes(example(), [], [1, 1e9]).root.sizes, [0, 10000]);
});

test('setSplitSizes with a bad path, a wrong length or a size that is not a positive number changes nothing', () => {
  const l = example();
  for (const [path, sizes] of [
    [[5], [1, 1]], [[0, 0, 0], [1, 1]], [[-1], [1, 1]], [[0.5], [1, 1]], ['x', [1, 1]], [null, [1, 1]],
    [[1, 0], [1, 1]],                       // a path that ends on a group
    [[], [1]], [[], [1, 2, 3]], [[], 'ab'], [[], null],
    [[], [null, 200]], [[], ['200', 200]], [[], [0, 200]], [[], [-1, 200]], [[], [NaN, 200]], [[], [200, Infinity]],
  ]) assert.equal(T.setSplitSizes(l, path, sizes), l, JSON.stringify([path, sizes]));
});

test('setSplitSizes never changes its input', () => {
  const l = deepFreeze(example());
  assert.doesNotThrow(() => T.setSplitSizes(l, [1], [100, 200, 300]));
  assert.deepEqual(l.root.kids[1].sizes, [1, 1, 1]);
});

// --- selection (belongs to the window, not to the layout) -----------------------

test('cleanSelection reads anything: only string-to-string entries and a real true survive', () => {
  assert.deepEqual(T.cleanSelection(null), { active: {}, foldAll: false, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.cleanSelection('x'), { active: {}, foldAll: false, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.cleanSelection({ active: { a: 'agents', b: 7, c: null, d: {} }, foldAll: 'yes' }), { active: { a: 'agents' }, foldAll: false, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.cleanSelection({ active: [1, 2], foldAll: true }), { active: {}, foldAll: true, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.cleanSelection({ active: { a: 'agents' }, foldAll: 1 }).foldAll, false);
});

test('selectTab shows that module in its group and unfolds everything', () => {
  const sel = T.selectTab({ active: { c: 'git' }, foldAll: true }, example(), 'vault');
  assert.deepEqual(sel, { active: { c: 'git', b: 'vault' }, foldAll: false, floatOrder: [], collapsed: {} });
});

test('selectTab for a hidden or unknown module changes nothing but still returns a clean selection', () => {
  const l = example();
  assert.deepEqual(T.selectTab({ active: { a: 'agents' }, foldAll: true }, l, 'models'), { active: { a: 'agents' }, foldAll: true, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.selectTab({ active: { a: 'agents' }, foldAll: true }, l, 'nope'), { active: { a: 'agents' }, foldAll: true, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.selectTab(7, l, 'nope'), { active: {}, foldAll: false, floatOrder: [], collapsed: {} });
});

test('toggleFoldAll flips Ctrl+B and keeps what each group shows', () => {
  const sel = { active: { a: 'agents' }, foldAll: false, floatOrder: [], collapsed: {} };
  assert.deepEqual(T.toggleFoldAll(sel), { active: { a: 'agents' }, foldAll: true, floatOrder: [], collapsed: {} });
  assert.deepEqual(T.toggleFoldAll(T.toggleFoldAll(sel)), sel);
  assert.deepEqual(T.toggleFoldAll(null), { active: {}, foldAll: true, floatOrder: [], collapsed: {} });
});

test('activeOf: the window\'s choice if the group still holds it, else the group\'s first tab', () => {
  const l = T.defaultLayout(IDS);
  const grp = l.root.kids[1];
  assert.equal(T.activeOf(l, { active: { right: 'git' } }, grp), 'git');
  assert.equal(T.activeOf(l, { active: { right: 'nope' } }, grp), 'agents');
  assert.equal(T.activeOf(l, { active: { other: 'git' } }, grp), 'agents');
  assert.equal(T.activeOf(l, null, grp), 'agents');
  assert.equal(T.activeOf(l, { active: { right: 'git' } }, 'right'), 'git', 'a group id works too');
  assert.equal(T.activeOf(l, {}, 'nope'), null);
});

test('a selection naming a module that moved to another group is ignored by the group it left', () => {
  const l = T.dock(T.defaultLayout(IDS), 'git', { cell: 'term', side: 'bottom' });
  assert.equal(T.activeOf(l, { active: { right: 'git' } }, 'right'), 'agents');
});

// --- fit -----------------------------------------------------------------------

const NO_SEL = { active: {}, foldAll: false };
const kindOf = (f, kind) => f.boxes.filter(b => b.kind === kind);
const rectOf = (f, id) => (id === 'term' ? kindOf(f, 'term')[0] : f.boxes.find(b => b.kind === 'group' && b.id === id)).rect;
const R = (x, y, width, height) => ({ x, y, width, height });
const area = r => r.width * r.height;
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  && area(a) > 0 && area(b) > 0;

// Boxes that must tile the viewport exactly: no overlap and every pixel covered.
function assertTiles(f, w, h) {
  const rects = f.boxes.map(b => b.rect);
  rects.forEach((r, i) => rects.slice(i + 1).forEach(s => assert.ok(!overlap(r, s), `${JSON.stringify(r)} overlaps ${JSON.stringify(s)}`)));
  assert.equal(rects.reduce((s, r) => s + area(r), 0), w * h, 'the boxes cover the viewport');
}

test('fit: the default in 1000 x 600 is the terminal, a gutter and the group at its 180', () => {
  const f = T.fit(T.defaultLayout(IDS), NO_SEL, { width: 1000, height: 600 });
  assert.deepEqual(rectOf(f, 'term'), R(0, 0, 815, 600));
  assert.deepEqual(kindOf(f, 'gutter'), [{ kind: 'gutter', path: [], i: 1, dir: 'row', rect: R(815, 0, 5, 600) }]);
  assert.deepEqual(kindOf(f, 'group'), [{ kind: 'group', id: 'right', tabs: IDS, active: 'agents', rect: R(820, 0, 180, 600) }]);
  assert.deepEqual(f.splits, [{ path: [], dir: 'row', px: [815, 180], state: ['open', 'open'], min: [320, 120] }]);
});

test('fit: a group shows this window\'s choice', () => {
  const f = T.fit(T.defaultLayout(IDS), { active: { right: 'git' } }, { width: 1000, height: 600 });
  assert.equal(kindOf(f, 'group')[0].active, 'git');
});

test('fit: the example in 1200 x 700 tiles the window with gutters, panels at their pixels', () => {
  const f = T.fit(example(), NO_SEL, { width: 1200, height: 700 });
  assert.deepEqual(rectOf(f, 'term'), R(0, 0, 955, 545));
  assert.deepEqual(rectOf(f, 'a'), R(0, 550, 475, 150));
  assert.deepEqual(rectOf(f, 'b'), R(480, 550, 475, 150));
  assert.deepEqual(rectOf(f, 'c'), R(960, 0, 240, 230));
  assert.deepEqual(rectOf(f, 'd'), R(960, 235, 240, 230));
  assert.deepEqual(rectOf(f, 'e'), R(960, 470, 240, 230));
  assert.deepEqual(kindOf(f, 'gutter').map(x => [x.path, x.i, x.dir, x.rect]), [
    [[0], 1, 'col', R(0, 545, 955, 5)],
    [[0, 1], 1, 'row', R(475, 550, 5, 150)],
    [[], 1, 'row', R(955, 0, 5, 700)],
    [[1], 1, 'col', R(960, 230, 240, 5)],
    [[1], 2, 'col', R(960, 465, 240, 5)],
  ]);
  assertTiles(f, 1200, 700);
});

test('fit: widening the window gives the extra to the terminal; panels keep their pixels', () => {
  const f = T.fit(example(), NO_SEL, { width: 1600, height: 900 });
  assert.equal(rectOf(f, 'term').width, 1600 - 5 - 240);
  assert.equal(rectOf(f, 'c').width, 240);
  assert.equal(rectOf(f, 'a').height, 150);
  assert.equal(rectOf(f, 'term').height, 900 - 5 - 150);
  assertTiles(f, 1600, 900);
});

test('fit: shrinking shares what is left in proportion to how far above its minimum each asked', () => {
  // 495 usable (500 less the gutter): the terminal needs 320, the right column's minimum is 120, the 55 spare px go to it.
  const f = T.fit(example(), NO_SEL, { width: 500, height: 700 });
  assert.equal(rectOf(f, 'c').width, 175);
  assert.equal(rectOf(f, 'term').width, 320);
  assertTiles(f, 500, 700);
});

test('fit: 445 wide is the last width where the column stays open, at its minimum', () => {
  const f = T.fit(example(), NO_SEL, { width: 445, height: 700 });
  assert.equal(rectOf(f, 'c').width, 120);
  assert.equal(rectOf(f, 'term').width, 320);
  assert.equal(kindOf(f, 'rail').length, 0);
});

test('fit: 440 wide folds the column to a rail of 28 and the terminal keeps 320', () => {
  const f = T.fit(example(), NO_SEL, { width: 440, height: 700 });
  assert.deepEqual(kindOf(f, 'rail'), [{ kind: 'rail', dir: 'v', modules: ['git', 'fog', 'bugvault'], groups: [{ id: 'c', tabs: ['git'] }, { id: 'd', tabs: ['fog'] }, { id: 'e', tabs: ['bugvault'] }], rect: R(412, 0, 28, 700) }]);
  assert.equal(rectOf(f, 'term').width, 412);
  assert.equal(kindOf(f, 'group').length, 2);
  assert.deepEqual(f.splits[0], { path: [], dir: 'row', px: [412, 28], state: ['open', 'rail'], min: [320, 28] });
  assertTiles(f, 440, 700);
});

test('fit: 330 wide has no rail at all, the terminal has the whole width', () => {
  const f = T.fit(example(), NO_SEL, { width: 330, height: 700 });
  assert.equal(kindOf(f, 'rail').length, 0);
  assert.equal(rectOf(f, 'term').width, 330);
  assert.equal(kindOf(f, 'gutter').filter(x => x.path.length === 0).length, 0);
  assertTiles(f, 330, 700);
});

const threeAcross = () => T.normalize(v2(row([g('l1', 'agents'), g('l2', 'vault'), term, g('r', ...IDS.slice(2))], [150, 150, 0, 150])), IDS);

test('fit: two fixed kids on one axis, the one farther from the terminal folds first', () => {
  // All open needs 785; at 690 folding the outer left one is enough.
  const f = T.fit(threeAcross(), NO_SEL, { width: 690, height: 400 });
  assert.deepEqual(kindOf(f, 'rail'), [{ kind: 'rail', dir: 'v', modules: ['agents'], groups: [{ id: 'l1', tabs: ['agents'] }], rect: R(0, 0, 28, 400) }]);
  assert.deepEqual(rectOf(f, 'l2'), R(28, 0, 150, 400));
  assert.deepEqual(rectOf(f, 'term'), R(183, 0, 352, 400));
  assert.deepEqual(rectOf(f, 'r'), R(540, 0, 150, 400));
  assertTiles(f, 690, 400);
});

test('fit: two fixed kids at the same distance, the later one folds first', () => {
  const both = T.normalize(v2(row([g('l', 'agents'), term, g('r', ...IDS.slice(1))], [200, 0, 200])), IDS);
  const f = T.fit(both, NO_SEL, { width: 560, height: 400 });
  assert.deepEqual(kindOf(f, 'rail').map(r => r.modules), [IDS.slice(1)]);
  assert.deepEqual(rectOf(f, 'l'), R(0, 0, 200, 400));
  assert.deepEqual(rectOf(f, 'term'), R(205, 0, 327, 400));
  assertTiles(f, 560, 400);
});

test('fit: 444 wide folds, 445 does not (the boundary is the terminal\'s 320 plus a gutter plus 120)', () => {
  assert.equal(kindOf(T.fit(example(), NO_SEL, { width: 444, height: 700 }), 'rail').length, 1);
  assert.equal(kindOf(T.fit(example(), NO_SEL, { width: 445, height: 700 }), 'rail').length, 0);
});

test('fit: when even the rails leave the terminal too little, the farthest rail goes first', () => {
  // Three rails of 28 leave 296 in 380; two leave 324.
  const f = T.fit(threeAcross(), { active: {}, foldAll: true }, { width: 380, height: 400 });
  assert.deepEqual(kindOf(f, 'rail').map(r => [r.modules, r.rect]), [
    [['vault'], R(0, 0, 28, 400)],
    [IDS.slice(2), R(352, 0, 28, 400)],
  ]);
  assert.deepEqual(rectOf(f, 'term'), R(28, 0, 324, 400));
  assertTiles(f, 380, 400);
});

test('fit: foldAll folds every fixed kid whatever the window size', () => {
  const f = T.fit(example(), { active: {}, foldAll: true }, { width: 1200, height: 700 });
  assert.equal(kindOf(f, 'group').length, 0);
  assert.deepEqual(kindOf(f, 'rail').map(r => [r.dir, r.modules, r.rect]), [
    ['h', ['agents', 'vault'], R(0, 670, 1172, 30)],
    ['v', ['git', 'fog', 'bugvault'], R(1172, 0, 28, 700)],
  ]);
  assert.deepEqual(rectOf(f, 'term'), R(0, 0, 1172, 670));
  assert.equal(kindOf(f, 'gutter').length, 0);
  assertTiles(f, 1200, 700);
});

test('fit: a column of equal proportions shares the height with gutters between', () => {
  const l = T.normalize(v2(row([term, col([g('a', 'agents'), g('b', 'vault'), g('c', ...IDS.slice(2))], [1, 1, 1])], [0, 180])), IDS);
  const f = T.fit(l, NO_SEL, { width: 800, height: 610 });
  assert.deepEqual([rectOf(f, 'a'), rectOf(f, 'b'), rectOf(f, 'c')], [R(620, 0, 180, 200), R(620, 205, 180, 200), R(620, 410, 180, 200)]);
  assert.equal(kindOf(f, 'gutter').filter(x => x.dir === 'col').length, 2);
});

test('fit: in a column of proportions a kid under its minimum is raised, the big one pays', () => {
  const l = T.normalize(v2(row([term, col([g('a', 'agents'), g('b', 'vault'), g('c', ...IDS.slice(2))], [10, 1, 1])], [0, 180])), IDS);
  const f = T.fit(l, NO_SEL, { width: 800, height: 600 });
  assert.deepEqual([rectOf(f, 'a').height, rectOf(f, 'b').height, rectOf(f, 'c').height], [430, 80, 80]);
  assert.deepEqual(f.splits.find(s => s.path.length === 1), { path: [1], dir: 'col', px: [430, 80, 80], state: ['open', 'open', 'open'], min: [80, 80, 80] });
});

test('fit: pixels that do not divide go to the biggest remainders and the column still adds up', () => {
  const l = T.normalize(v2(row([term, col([g('a', 'agents'), g('b', 'vault'), g('c', ...IDS.slice(2))], [1, 1, 1])], [0, 180])), IDS);
  const f = T.fit(l, NO_SEL, { width: 800, height: 600 });
  assert.deepEqual([197, 197, 196], [rectOf(f, 'a').height, rectOf(f, 'b').height, rectOf(f, 'c').height]);
});

test('fit: a junk viewport gives zero-or-positive integers and no NaN', () => {
  for (const vp of [null, undefined, 7, {}, { width: '9' }, { width: -5, height: NaN }, { width: Infinity, height: 3.7 }, { width: 100.9, height: 50.2 }]) {
    const f = T.fit(example(), NO_SEL, vp);
    for (const b of f.boxes) {
      for (const v of Object.values(b.rect)) assert.ok(Number.isInteger(v) && v >= 0, `${JSON.stringify(vp)} ${JSON.stringify(b)}`);
    }
  }
});

test('fit: a tiny window still puts every box inside it and tiles it', () => {
  for (const [w, h] of [[0, 0], [10, 10], [100, 50], [320, 160], [319, 159]]) {
    const f = T.fit(example(), NO_SEL, { width: w, height: h });
    f.boxes.forEach(b => assert.ok(b.rect.x + b.rect.width <= w && b.rect.y + b.rect.height <= h, `${w}x${h} ${JSON.stringify(b)}`));
  }
});

test('fit never changes the layout or the selection and reads a junk selection', () => {
  const l = deepFreeze(example());
  const sel = deepFreeze({ active: { a: 'vault' }, foldAll: false });
  assert.doesNotThrow(() => T.fit(l, sel, { width: 700, height: 500 }));
  assert.doesNotThrow(() => T.fit(l, 'junk', { width: 700, height: 500 }));
});

// --- migration from L1 --------------------------------------------------------

const DL = { defaultLayout: require('../app/dock-migrate').defaultV1 };   // L1's default shape (D4: dock-layout.js is gone)
const v1 = (zones, extra = {}) => ({
  version: 1,
  zones: { left: [], right: [], top: [], bottom: [], ...zones },
  active: { left: null, right: null, top: null, bottom: null },
  hidden: [],
  size: { left: 200, right: 240, top: 170, bottom: 150 },
  restore: null,
  ...extra,
});

test('L1\'s default loads as the tree default', () => {
  assert.deepEqual(T.fromV1(DL.defaultLayout(IDS), IDS), T.defaultLayout(IDS));
});

test('all four zones become the L1 picture: top over left-terminal-right over bottom', () => {
  const l = T.fromV1(v1({ left: ['agents'], right: ['vault', 'git'], top: ['fog'], bottom: ['bugvault', 'models', 'projects', 'style'] }), IDS);
  assert.deepEqual(l.root, col([
    g('top', 'fog'),
    row([g('left', 'agents'), term, g('right', 'vault', 'git')], [200, 0, 240]),
    g('bottom', 'bugvault', 'models', 'projects', 'style'),
  ], [170, 0, 150]));
});

test('an empty zone contributes nothing and the wrapper collapses', () => {
  const lr = T.fromV1(v1({ left: ['agents'], right: IDS.slice(1) }), IDS);
  assert.deepEqual(lr.root, row([g('left', 'agents'), term, g('right', ...IDS.slice(1))], [200, 0, 240]));
  const b = T.fromV1(v1({ bottom: IDS }), IDS);
  assert.deepEqual(b.root, col([term, g('bottom', ...IDS)], [0, 150]));
});

test('hidden carries over, and a module this build does not know is lost', () => {
  const l = T.fromV1(v1({ right: ['agents', 'ghost', 'vault'] }, { hidden: ['git', 'ghost2'] }), IDS);
  assert.deepEqual(l.hidden, ['git']);
  assert.deepEqual(T.groups(l).flatMap(x => x.tabs).sort(), IDS.filter(i => i !== 'git').sort());
});

test('junk L1 input becomes the default', () => {
  for (const junk of [null, { zones: 7 }, 'x', []]) {
    assert.deepEqual(T.fromV1(junk, IDS), T.defaultLayout(IDS), JSON.stringify(junk));
  }
});

test('fromV1 never changes its input', () => {
  const raw = deepFreeze(v1({ left: ['agents'], right: IDS.slice(1) }));
  assert.doesNotThrow(() => T.fromV1(raw, IDS));
});

test('readAny: version 2 normalizes, an L1 shape migrates, anything else is the default', () => {
  const two = v2(row([term, g('a', 'agents')], [0, 222]));
  assert.deepEqual(T.readAny(two, IDS), T.normalize(two, IDS));
  const old = v1({ left: ['agents'], right: IDS.slice(1) });
  assert.deepEqual(T.readAny(old, IDS), T.fromV1(old, IDS));
  for (const junk of [null, 7, 'x', [], {}, { version: 3 }]) {
    assert.deepEqual(T.readAny(junk, IDS), T.defaultLayout(IDS));
  }
});

test('selectionFromV1: a window\'s L1 choices map straight across (group ids are the zone names)', () => {
  const sel = T.selectionFromV1({ active: { right: 'vault', left: null, top: 7, bottom: 'git' } });
  assert.deepEqual(sel, { active: { right: 'vault', bottom: 'git' }, foldAll: false, floatOrder: [], collapsed: {} });
  for (const junk of [null, 7, {}, { active: 5 }]) {
    assert.deepEqual(T.selectionFromV1(junk), { active: {}, foldAll: false, floatOrder: [], collapsed: {} });
  }
});

// --- PR #100 review (Dexter F1, F2, F5) --------------------------------------------

test('F1: a lone panel dropped where it already sits changes nothing: the very same layout comes back', () => {
  const L = T.normalize(v2(row([term, g('right', 'git')], [0, 400]), { hidden: IDS.filter(id => id !== 'git') }), IDS);
  assert.equal(T.dock(L, 'git', { edge: 'right' }), L, 'the right rim');
  assert.equal(T.dock(L, 'git', { cell: 'term', side: 'right' }), L, "the terminal's right band");
  assert.equal(T.groupOf(L, 'git').id, 'right');
  assert.deepEqual(L.root.sizes, [0, 400]);
});

test('F1: a lone panel dropped somewhere else still moves, and keeps nothing of the old shape', () => {
  const L = T.normalize(v2(row([term, g('right', 'git')], [0, 400]), { hidden: IDS.filter(id => id !== 'git') }), IDS);
  assert.notEqual(T.dock(L, 'git', { edge: 'left' }), L);
  assert.notEqual(T.dock(L, 'git', { edge: 'top' }), L);
  assert.notEqual(T.dock(L, 'git', { cell: 'term', side: 'left' }), L);
});

test('F1: a lone panel at the left, or in a column, dropped where it already is also changes nothing', () => {
  const left = T.normalize(v2(row([g('l', 'git'), term, g('r', 'vault')], [250, 0, 300]), { hidden: IDS.filter(id => id !== 'git' && id !== 'vault') }), IDS);
  assert.equal(T.dock(left, 'git', { edge: 'left' }), left);
  assert.equal(T.dock(left, 'git', { cell: 'term', side: 'left' }), left);
  const top = T.normalize(v2(col([g('t', 'git'), row([term, g('r', 'vault')], [0, 200])], [150, 0]), { hidden: IDS.filter(id => id !== 'git' && id !== 'vault') }), IDS);
  assert.equal(T.dock(top, 'git', { edge: 'top' }), top);
});

// --- PR #100 review (Dexter F2, F5) ------------------------------------------------

test('F2: a seat never names a group that was destroyed, even when a new group takes the old name', () => {
  const ids = ['A', 'B', 'C'];
  let l = T.defaultLayout(ids);
  l = T.dock(l, 'B', { cell: 'right', side: 'bottom' });
  l = T.dock(l, 'C', { cell: 'g1', side: 'center' });
  assert.deepEqual(T.groupOf(l, 'C').tabs, ['B', 'C']);
  l = T.hide(l, 'C');
  assert.equal(l.seat.C.group, 'g1');
  l = T.dock(l, 'B', { cell: 'right', side: 'center' });                      // g1 is destroyed
  assert.equal(l.seat.C.group, null, 'the seat forgets a group that no longer exists');
  l = T.dock(l, 'A', { edge: 'top' });                                        // a new group must not inherit the name g1
  l = T.show(l, 'C');
  assert.ok(T.groupOf(l, 'C').tabs.includes('B'), 'C comes back beside B, not into the unrelated top group');
  assert.ok(!T.groupOf(l, 'C').tabs.includes('A'));
});

test('F2: normalize never names a group after a group a seat still points at', () => {
  const ids = ['A', 'B', 'C'];
  const raw = v2(row([term, { type: 'group', tabs: ['A', 'B'] }], [0, 180]), {
    hidden: ['C'], seat: { C: { group: 'g1', beside: 'B', side: 'center' } },
  });
  const l = T.normalize(raw, ids);
  assert.notEqual(T.groupOf(l, 'A').id, 'g1', 'the unnamed group skips the name the seat holds');
  assert.equal(l.seat.C.group, null, 'and the seat, naming no group of this tree, forgets it');
});

test('F2: dock never names a new group after one a seat points at', () => {
  const ids = ['A', 'B', 'C'];
  const l = T.normalize(v2(row([term, g('right', 'A', 'B')], [0, 180]), {
    hidden: ['C'], seat: { C: { group: 'right', beside: 'B', side: 'center' } },
  }), ids);
  const next = T.dock(l, 'A', { edge: 'top' });
  assert.equal(T.groupOf(next, 'A').id, 'g1');
  const l2 = { ...l, seat: { C: { group: 'g1', beside: 'B', side: 'center' } } };    // hand-built: a seat naming a free name
  assert.notEqual(T.groupOf(T.dock(l2, 'A', { edge: 'top' }), 'A').id, 'g1');
});

test('F5: a stored group named "term" is renamed, so the terminal and the group are told apart', () => {
  const l = T.normalize(v2(row([term, g('term', 'git')], [0, 200]), { hidden: IDS.filter(id => id !== 'git') }), IDS);
  const gr = T.groupOf(l, 'git');
  assert.notEqual(gr.id, 'term');
  // A drop on the group splits the group, never the terminal.
  const next = T.dock(l, 'agents', { cell: gr.id, side: 'left' });
  assert.equal(T.count(next, 'term'), 1);
  assert.ok(next.root.kids.some(k => k.type === 'term'), 'the terminal is still a direct kid of the root');
  assert.ok(T.groups(next).some(x => x.id === gr.id && x.tabs.includes('git')));
});


// --- hidden until used (BACKLOG #71: Claude's panel) -----------------------------------------------------------

test('Claude\'s panel starts hidden: it is in no group of a default layout, only in the hidden list', () => {
  const ids = [...IDS, 'canvas'];
  const l = T.defaultLayout(ids);
  assert.deepEqual(modulesOf(l).sort(), [...ids].sort(), 'it is still a module of the layout');
  assert.deepEqual(l.hidden, ['canvas']);
  assert.ok(!T.groups(l).some(gr => gr.tabs.includes('canvas')));
});

test('a saved layout that predates the panel gets it hidden, not as a new tab in someone\'s first group', () => {
  const old = v2(row([term, g('right', ...IDS)], [0, 180]));
  const l = T.normalize(old, [...IDS, 'canvas']);
  assert.deepEqual(l.hidden, ['canvas']);
  assert.ok(!T.groups(l).some(gr => gr.tabs.includes('canvas')));
  assert.deepEqual(T.groups(l)[0].tabs, IDS, 'everything else is untouched');
});

test('once the person has the panel in a group, normalize keeps it there', () => {
  const placed = v2(row([term, g('right', ...IDS, 'canvas')], [0, 180]));
  const l = T.normalize(placed, [...IDS, 'canvas']);
  assert.deepEqual(l.hidden, []);
  assert.ok(T.groups(l)[0].tabs.includes('canvas'));
});

test('show() docks the hidden panel on the right when nothing says where it was', () => {
  const l = T.defaultLayout([...IDS, 'canvas']);
  const shown = T.show(l, 'canvas');
  assert.deepEqual(shown.hidden, []);
  assert.ok(modulesOf(shown).includes('canvas'));
  assert.ok(T.groups(shown).some(gr => gr.tabs.includes('canvas')));
});

test('other modules a newer build adds still land in the first group; only the opt-in ones start hidden', () => {
  const old = v2(row([term, g('right', ...IDS)], [0, 180]));
  const l = T.normalize(old, [...IDS, 'brand-new']);
  assert.deepEqual(l.hidden, []);
  assert.ok(T.groups(l)[0].tabs.includes('brand-new'));
  assert.deepEqual(T.HIDDEN_UNTIL_USED, ['canvas']);
});

test('Claude\'s panel is hidden after the L1 migration too (a layout from before it existed), not dropped into a zone', () => {
  const ids = [...IDS, 'canvas'];
  const l = T.fromV1(DL.defaultLayout(IDS), ids);
  assert.deepEqual(l.hidden, ['canvas']);
  assert.ok(!T.groups(l).some(gr => gr.tabs.includes('canvas')));
  assert.deepEqual(T.groups(l)[0].tabs, IDS);
  assert.deepEqual(T.readAny(DL.defaultLayout(IDS), ids).hidden, ['canvas'], 'readAny migrates the same way');
});

// Ricardo, 2026-10-06 (#71 open question 1, "keep all" = the recommendation): Claude's panel docks itself 320 px wide, not the 180 every
// new cell gets (the question card is cramped at 180). Only its OWN default: a size the person dragged to is kept, other modules stay 180.
const sizeOfCell = (layout, id) => {
  let out = null;
  const visit = (n) => { if (n.type === 'split') n.kids.forEach((k, i) => { if (k.type === 'group' && k.tabs.includes(id)) out = { dir: n.dir, size: n.sizes[i] }; visit(k); }); };
  visit(layout.root);
  return out;
};

test("Claude's panel docks itself 320 px wide when it is shown from hidden (the old 180 was cramped for the question card)", () => {
  const l = T.show(T.defaultLayout([...IDS, 'canvas']), 'canvas');
  assert.deepEqual(sizeOfCell(l, 'canvas'), { dir: 'row', size: 320 });
});

test('320 is the panel\'s own default only: the module before it keeps its size, and another hidden module still docks at 180', () => {
  const start = T.defaultLayout([...IDS, 'canvas']);
  const withPanel = T.show(start, 'canvas');
  assert.equal(sizeOfCell(withPanel, 'agents').size, 180);
  const hiddenStyle = T.hide(start, 'style');
  assert.deepEqual(sizeOfCell(T.show(hiddenStyle, 'style'), 'agents'), { dir: 'row', size: 180 });
  const shownStyle = T.show(T.hide(T.show(start, 'canvas'), 'style'), 'style');
  assert.ok(T.groups(shownStyle).some(gr => gr.tabs.includes('style')));
});

// Ricardo, 2026-10-13 (#33): the Ask panel, in a cell of its own beside the terminal, opens 360 px wide. In a shared group it follows the group.
test('the Ask panel opens 360 px wide in a cell of its own, and only there', () => {
  const ids = [...IDS, 'ask'];
  const alone = T.dock(T.defaultLayout(ids), 'ask', { cell: 'term', side: 'right' });
  assert.deepEqual(sizeOfCell(alone, 'ask'), { dir: 'row', size: 360 });
  assert.ok(!T.groups(alone).some(gr => gr.tabs.includes('ask') && gr.tabs.length > 1), 'a cell of its own');
  // in the shared group (the default), nothing about it sets a width: the group keeps its 180
  assert.deepEqual(sizeOfCell(T.defaultLayout(ids), 'agents'), { dir: 'row', size: 180 });
  assert.ok(T.groups(T.defaultLayout(ids)).some(gr => gr.tabs.includes('ask') && gr.tabs.includes('agents')));
});

test('the Ask panel\'s own width is a row width only: docked under the terminal it gets the usual height', () => {
  const l = T.dock(T.defaultLayout([...IDS, 'ask']), 'ask', { cell: 'term', side: 'bottom' });
  assert.deepEqual(sizeOfCell(l, 'ask'), { dir: 'col', size: 160 });
});

test('a column default is unchanged for the panel (320 is a width): docked under the terminal it gets the usual height', () => {
  const l = T.dock(T.show(T.defaultLayout([...IDS, 'canvas']), 'canvas'), 'canvas', { cell: 'term', side: 'bottom' });
  assert.equal(sizeOfCell(l, 'canvas').dir, 'col');
  assert.equal(sizeOfCell(l, 'canvas').size, T.DEFAULT_SIZE.col);
});
