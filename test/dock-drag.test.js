'use strict';
/**
 * Drop zones as pure geometry (BACKLOG #53, D1 Task 8): given the boxes `fit`
 * drew and a pointer position, which zones to light and which one is under the
 * pointer. The page only draws what this returns.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../app/dock-drag');

const R = (x, y, width, height) => ({ x, y, width, height });
const VP = { width: 1000, height: 600 };
// The default layout in 1000 x 600: the terminal, a gutter and one group on the right.
const BOXES = [
  { kind: 'term', rect: R(0, 0, 815, 600) },
  { kind: 'gutter', path: [], i: 1, dir: 'row', rect: R(815, 0, 5, 600) },
  { kind: 'group', id: 'right', tabs: ['agents', 'vault'], active: 'agents', rect: R(820, 0, 180, 600) },
];
const at = (x, y, boxes = BOXES, vp = VP, opts) => D.zonesAt(boxes, vp, { x, y }, opts);
const hotOf = r => r.zones.filter(z => z.hot);
const contains = (r, x, y) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
const area = r => r.width * r.height;
const overlap = (a, b) => area(a) > 0 && area(b) > 0 && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// The group is 180 x 600 at (820, 0): a 26 px tab bar, then a body of 574 cut into 28% bands
// (161 px top and bottom, 50 px left and right).

test('every region of a group: point -> target', () => {
  for (const [x, y, target] of [
    [900, 20, { cell: 'right', side: 'center' }],             // the tab bar (the top 14 px are the window's rim)
    [900, 100, { cell: 'right', side: 'top' }],
    [900, 500, { cell: 'right', side: 'bottom' }],
    [835, 300, { cell: 'right', side: 'left' }],
    [960, 300, { cell: 'right', side: 'right' }],
    [900, 300, { cell: 'right', side: 'center' }],            // the middle
  ]) assert.deepEqual(at(x, y).target, target, `${x},${y}`);
});

test('the edges of the bands: the top band ends at 187, the left band at 870', () => {
  assert.deepEqual(at(900, 186).target, { cell: 'right', side: 'top' });
  assert.deepEqual(at(900, 187).target, { cell: 'right', side: 'center' });
  assert.deepEqual(at(869, 300).target, { cell: 'right', side: 'left' });
  assert.deepEqual(at(870, 300).target, { cell: 'right', side: 'center' });
  assert.deepEqual(at(900, 25).target, { cell: 'right', side: 'center' });
  assert.deepEqual(at(900, 26).target, { cell: 'right', side: 'top' });
});

test('every region of the terminal: four sides, and the middle floats the panel (D2)', () => {
  for (const [x, y, target] of [
    [400, 50, { cell: 'term', side: 'top' }],
    [400, 500, { cell: 'term', side: 'bottom' }],
    [100, 300, { cell: 'term', side: 'left' }],
    [700, 300, { cell: 'term', side: 'right' }],
    [400, 300, { float: true }],
  ]) assert.deepEqual(at(x, y).target, target, `${x},${y}`);
  assert.equal(hotOf(at(400, 300)).length, 1);
});

test('the terminal has no tab bar: its top band starts at its top edge', () => {
  assert.deepEqual(at(400, 20).target, { cell: 'term', side: 'top' });
});

test('the rim beats a cell\'s band: 14 px on each window edge', () => {
  assert.deepEqual(at(400, 5).target, { edge: 'top' });
  assert.deepEqual(at(400, 595).target, { edge: 'bottom' });
  assert.deepEqual(at(5, 300).target, { edge: 'left' });
  assert.deepEqual(at(995, 300).target, { edge: 'right' });       // inside the group's right band
  assert.deepEqual(at(400, 14).target, { cell: 'term', side: 'top' });
  assert.deepEqual(at(400, 13).target, { edge: 'top' });
  assert.deepEqual(at(14, 300).target, { cell: 'term', side: 'left' });
  assert.deepEqual(at(13, 300).target, { edge: 'left' });
});

test('a corner belongs to the top or bottom rim, not to two zones', () => {
  assert.deepEqual(at(3, 3).target, { edge: 'top' });
  assert.deepEqual(at(997, 597).target, { edge: 'bottom' });
  assert.equal(hotOf(at(3, 3)).length, 1);
});

test('the rim is always listed, four zones, even with the pointer nowhere near', () => {
  const r = at(400, 300);
  assert.deepEqual(r.zones.filter(z => z.target && z.target.edge).map(z => z.target.edge), ['top', 'bottom', 'left', 'right']);
  assert.deepEqual(r.zones[0].rect, R(0, 0, 1000, 14));
  assert.deepEqual(r.zones[1].rect, R(0, 586, 1000, 14));
  assert.deepEqual(r.zones[2].rect, R(0, 14, 14, 572));
  assert.deepEqual(r.zones[3].rect, R(986, 14, 14, 572));
});

test('over a group the rim and that group\'s six zones are listed, and nothing of other cells', () => {
  const r = at(900, 300);
  assert.equal(r.zones.length, 4 + 6);
  assert.deepEqual(r.zones.slice(4).map(z => z.target.side), ['center', 'top', 'bottom', 'left', 'right', 'center']);
  assert.deepEqual(r.zones.slice(4).map(z => z.rect), [
    R(820, 0, 180, 26), R(820, 26, 180, 161), R(820, 439, 180, 161),
    R(820, 187, 50, 252), R(950, 187, 50, 252), R(870, 187, 80, 252),
  ]);
});

test('over the terminal: the rim, its four sides and the float zone in the middle', () => {
  const r = at(400, 300);
  assert.deepEqual(r.zones.slice(4).map(z => z.target.side || 'float'), ['top', 'bottom', 'left', 'right', 'float']);
  assert.deepEqual(r.zones.slice(4).map(z => z.rect), [
    R(0, 0, 815, 168), R(0, 432, 815, 168), R(0, 168, 228, 264), R(587, 168, 228, 264), R(228, 168, 359, 264),
  ]);
});

test('exactly the zone under the pointer is hot, and it is the answer', () => {
  for (const [x, y] of [[900, 10], [900, 100], [400, 50], [5, 300], [400, 300], [960, 300], [997, 3]]) {
    const r = at(x, y);
    const hot = hotOf(r);
    assert.ok(hot.length <= 1, `${x},${y}`);
    if (hot.length) {
      assert.ok(contains(hot[0].rect, x, y));
      assert.deepEqual(r.target, hot[0].target);
    } else {
      assert.equal(r.target, null);
    }
  }
});

test('over a rail, a gutter or nothing: only the rim is listed and nothing is hot', () => {
  const rail = [{ kind: 'term', rect: R(0, 0, 972, 600) }, { kind: 'rail', dir: 'v', modules: ['git'], rect: R(972, 0, 28, 600) }];
  for (const [x, y, boxes] of [[985, 300, rail], [817, 300, BOXES], [500, 300, []]]) {
    const r = at(x, y, boxes);
    assert.equal(r.zones.length, 4, `${x},${y}`);
    assert.equal(r.target, null);
    assert.equal(hotOf(r).length, 0);
  }
});

test('a point outside the window has no target, and the rim is still listed', () => {
  for (const [x, y] of [[-5, 10], [1000, 300], [500, 600], [500, -1], [2000, 2000]]) {
    const r = at(x, y);
    assert.equal(r.target, null, `${x},${y}`);
    assert.equal(r.zones.length, 4);
    assert.equal(hotOf(r).length, 0);
  }
});

test('zones never overlap each other, except that the rim lies over a cell\'s own', () => {
  for (const [x, y] of [[900, 300], [400, 300], [900, 20], [100, 100]]) {
    const r = at(x, y);
    const rim = r.zones.filter(z => z.target.edge);
    const cell = r.zones.filter(z => !z.target.edge);
    rim.forEach((a, i) => rim.slice(i + 1).forEach(b => assert.ok(!overlap(a.rect, b.rect), 'rim vs rim')));
    cell.forEach((a, i) => cell.slice(i + 1).forEach(b => assert.ok(!overlap(a.rect, b.rect), 'cell vs cell')));
  }
});

test('a cell\'s zones tile the cell exactly, the terminal\'s float zone included', () => {
  const sum = zs => zs.reduce((s, z) => s + area(z.rect), 0);
  const group = at(900, 300).zones.filter(z => !z.target.edge);
  assert.equal(sum(group), 180 * 600);
  const term = at(400, 300).zones.filter(z => !z.target.edge);
  assert.equal(sum(term), 815 * 600);
});

// --- floats (D2) ------------------------------------------------------------------

const FLOATS = [
  ...BOXES,
  { kind: 'float', id: 'f1', tabs: ['git'], active: 'git', rect: R(300, 100, 300, 200) },
  { kind: 'float', id: 'f2', tabs: ['fog'], active: 'fog', rect: R(450, 150, 300, 200) },     // drawn after f1: on top where they overlap
];

test('over a float: the whole float is one zone, "join as a tab"; nothing of the cells under it', () => {
  const r = at(350, 120, FLOATS);
  assert.deepEqual(r.target, { cell: 'f1', side: 'center' });
  assert.equal(r.zones.length, 4 + 1);
  assert.deepEqual(r.zones[4].rect, R(300, 100, 300, 200));
  assert.equal(hotOf(r).length, 1);
});

test('the topmost float wins where two overlap (the last drawn)', () => {
  assert.deepEqual(at(500, 200, FLOATS).target, { cell: 'f2', side: 'center' });
  assert.deepEqual(at(320, 200, FLOATS).target, { cell: 'f1', side: 'center' });
});

test('a float hides the cell under it, the window\'s rim still wins over it', () => {
  const edge = [...BOXES, { kind: 'float', id: 'f', tabs: ['git'], active: 'git', rect: R(0, 0, 200, 200) }];
  assert.deepEqual(at(100, 100, edge).target, { cell: 'f', side: 'center' }, 'over the terminal\'s top-left band, the float');
  assert.deepEqual(at(100, 5, edge).target, { edge: 'top' }, 'the rim is first in the list');
});

test('the float being dragged by a tab is not a target: what is under it decides', () => {
  assert.deepEqual(at(500, 200, FLOATS, VP, { exclude: 'f2' }).target, { cell: 'f1', side: 'center' });
  assert.deepEqual(at(500, 280, FLOATS, VP, { exclude: 'f1' }).target, { cell: 'f2', side: 'center' });
  assert.deepEqual(at(400, 250, FLOATS, VP, { exclude: 'f2' }).target, { cell: 'f1', side: 'center' });
  const r = at(350, 120, FLOATS, VP, { exclude: 'f1' });
  assert.deepEqual(r.target, { cell: 'term', side: 'top' }, 'the terminal under f1');
  assert.deepEqual(at(350, 120, FLOATS, VP, { exclude: 7 }).target, { cell: 'f1', side: 'center' }, 'junk excludes nothing');
});

test('a float has no zones of its own beyond the one: not a tab bar, not bands', () => {
  for (const [x, y] of [[310, 105], [445, 250], [320, 295]]) assert.deepEqual(at(x, y, FLOATS).target, { cell: 'f1', side: 'center' }, `${x},${y}`);
});

test('a float box with no rectangle is ignored, and the terminal\'s float zone is not offered over a float', () => {
  assert.equal(D.zonesAt([{ kind: 'float', id: 'x' }, ...BOXES], VP, { x: 400, y: 300 }).target.float, true);
  assert.deepEqual(at(400, 300, [...BOXES, { kind: 'float', id: 'g', tabs: ['a'], active: 'a', rect: R(380, 280, 100, 100) }]).target, { cell: 'g', side: 'center' });
});

test('the tab bar height is a parameter, and a bar taller than the group takes the whole group', () => {
  assert.deepEqual(at(900, 30, BOXES, VP, { tabBar: 40 }).target, { cell: 'right', side: 'center' });
  const short = [{ kind: 'group', id: 'g', tabs: ['a'], active: 'a', rect: R(100, 100, 200, 20) }];
  const r = at(150, 110, short);
  assert.deepEqual(r.target, { cell: 'g', side: 'center' });
  assert.equal(r.zones.length, 4 + 1, 'a group with no body has only its bar');
  assert.deepEqual(at(150, 110, BOXES, VP, { tabBar: 'wide' }).target, { cell: 'term', side: 'top' }, 'junk falls back to 26');
});

test('junk input gives the rim only and never throws', () => {
  assert.equal(D.zonesAt(null, VP, { x: 400, y: 300 }).target, null);
  assert.equal(D.zonesAt(BOXES, null, { x: 400, y: 300 }).target, null);
  assert.equal(D.zonesAt(BOXES, VP, null).target, null);
  assert.equal(D.zonesAt(BOXES, VP, { x: NaN, y: 3 }).target, null);
  assert.equal(D.zonesAt(BOXES, VP, { x: '5', y: 3 }).target, null);
  assert.equal(D.zonesAt([null, 7, { kind: 'group' }], VP, { x: 400, y: 300 }).target, null);
  assert.equal(D.zonesAt(BOXES, { width: '9' }, { x: 1, y: 1 }).zones.length, 4);
});

test('a window too small for a 14 px rim on both sides still lists a rim that does not overlap itself', () => {
  const r = D.zonesAt([], { width: 20, height: 10 }, { x: 1, y: 1 });
  const rim = r.zones;
  rim.forEach((a, i) => rim.slice(i + 1).forEach(b => assert.ok(!overlap(a.rect, b.rect))));
  assert.equal(r.target.edge, 'top');
});

test('zonesAt never changes its input', () => {
  const frozen = (o) => { Object.values(o).forEach(v => v && typeof v === 'object' && frozen(v)); return Object.freeze(o); };
  assert.doesNotThrow(() => D.zonesAt(frozen(JSON.parse(JSON.stringify(BOXES))), frozen({ ...VP }), frozen({ x: 900, y: 300 })));
});

test('it reads what fit returns: a group has its zones where fit drew it', () => {
  const T = require('../app/dock-tree');
  const l = T.normalize({ version: 2, floats: [], hidden: [], seat: {}, root: { type: 'split', dir: 'row', sizes: [0, 240], kids: [{ type: 'term' }, { type: 'split', dir: 'col', sizes: [1, 1], kids: [{ type: 'group', id: 'c', tabs: ['git'] }, { type: 'group', id: 'd', tabs: ['fog'] }] }] } }, ['git', 'fog']);
  const f = T.fit(l, null, { width: 1200, height: 700 });
  // Git is the top group of the right column: x 960..1200, y 0..350 (less the gutter, 347 + 348).
  const git = f.boxes.find(b => b.id === 'c').rect;
  assert.deepEqual(D.zonesAt(f.boxes, { width: 1200, height: 700 }, { x: git.x + 120, y: git.y + 100 }).target, { cell: 'c', side: 'top' });
  assert.deepEqual(D.zonesAt(f.boxes, { width: 1200, height: 700 }, { x: git.x + 120, y: git.y + git.height - 20 }).target, { cell: 'c', side: 'bottom' });
});
