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
