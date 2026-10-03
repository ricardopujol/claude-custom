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

test('floats are not part of D1: their modules fall back into the tree', () => {
  const l = T.normalize(v2(row([term, g('a', 'agents')], [0, 200]), { floats: [{ id: 'f', tabs: ['vault'], x: 1, y: 1, w: 9, h: 9 }] }), IDS);
  assert.deepEqual(l.floats, []);
  assert.deepEqual(T.groups(l)[0].tabs, IDS);
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
  for (const t of [null, undefined, 7, {}, { float: { x: 1, y: 1 } }]) assert.equal(T.dock(l, 'vault', t), l);
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

// --- migration from L1 --------------------------------------------------------

const DL = require('../app/dock-layout');
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
  assert.deepEqual(sel, { active: { right: 'vault', bottom: 'git' }, foldAll: false });
  for (const junk of [null, 7, {}, { active: 5 }]) {
    assert.deepEqual(T.selectionFromV1(junk), { active: {}, foldAll: false });
  }
});
