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

// A tree with `agents` and `vault` in one group on the right, `git` floating, the rest hidden nowhere:
const base = () => T.normalize(v2(row([term, g('a', 'agents', 'vault')], [0, 200]), { floats: [fl('f', ['git'])] }), IDS);

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
