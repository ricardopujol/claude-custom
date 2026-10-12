'use strict';
/**
 * Moving a panel with the keyboard (BACKLOG #53, dockable panels D4): the same zones the pointer lights, stepped
 * with the arrow keys. `nextZone` is pure geometry over the boxes `fit` drew, so any panel reachable by dragging
 * is reachable without a mouse, and nothing the keyboard can reach is a drop the model would refuse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const D = require('../app/dock-drag');
const T = require('../app/dock-tree');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const R = (x, y, width, height) => ({ x, y, width, height });
const VP = { width: 1000, height: 600 };
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };
const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The default layout in 1000 x 600 (as dock-drag.test.js): the terminal, a gutter and one group on the right.
const BOXES = [
  { kind: 'term', rect: R(0, 0, 815, 600) },
  { kind: 'gutter', path: [], i: 1, dir: 'row', rect: R(815, 0, 5, 600) },
  { kind: 'group', id: 'right', tabs: ['agents', 'vault'], active: 'agents', rect: R(820, 0, 180, 600) },
];

// --- candidates -----------------------------------------------------------------------------

test('every zone the pointer can light is a candidate: the rim, each cell\'s bands and middle, a float\'s join', () => {
  const withFloat = [...BOXES, { kind: 'float', id: 'f', tabs: ['git'], active: 'git', rect: R(100, 100, 300, 200) }];
  const c = D.candidates(withFloat, VP);
  const targets = c.map(z => z.target);
  for (const edge of ['top', 'bottom', 'left', 'right']) assert.ok(targets.some(t => t.edge === edge), edge);
  for (const side of ['top', 'bottom', 'left', 'right', 'center']) assert.ok(targets.some(t => t.cell === 'right' && t.side === side), `group ${side}`);
  for (const side of ['top', 'bottom', 'left', 'right']) assert.ok(targets.some(t => t.cell === 'term' && t.side === side), `term ${side}`);
  assert.ok(targets.some(t => t.float === true), 'the terminal\'s middle floats');
  assert.ok(targets.some(t => t.cell === 'f' && t.side === 'center'), 'a float takes a tab');
  assert.ok(!targets.some(t => t.cell === 'term' && t.side === 'center'), 'the terminal is never joined');
  for (const z of c) assert.ok(z.rect.width * z.rect.height > 0, 'no empty zones');
});

test('a float being moved is not one of its own candidates', () => {
  const withFloat = [...BOXES, { kind: 'float', id: 'f', tabs: ['git'], active: 'git', rect: R(100, 100, 300, 200) }];
  assert.ok(!D.candidates(withFloat, VP, { exclude: 'f' }).some(z => z.target.cell === 'f'));
});

test('junk boxes and windows give the rim at most, never a throw', () => {
  assert.deepEqual(D.candidates(null, VP).map(z => z.target.edge), ['top', 'bottom', 'left', 'right']);
  assert.deepEqual(D.candidates([null, 3, {}], VP).length, 4);
  assert.deepEqual(D.candidates(BOXES, null), []);
});

// --- the first target -----------------------------------------------------------------------

test('a move starts on the middle of the group the panel sits in', () => {
  assert.deepEqual(D.startTarget(BOXES, 'vault'), { cell: 'right', side: 'center' });
});

test('a panel in a float starts on that float\'s own join zone (a drop there changes nothing)', () => {
  const withFloat = [...BOXES, { kind: 'float', id: 'f', tabs: ['git'], active: 'git', rect: R(100, 100, 300, 200) }];
  assert.deepEqual(D.startTarget(withFloat, 'git'), { cell: 'f', side: 'center' });
});

test('a panel on a rail, or unknown, starts on the terminal\'s middle', () => {
  assert.deepEqual(D.startTarget([{ kind: 'term', rect: R(0, 0, 972, 600) }, { kind: 'rail', dir: 'v', modules: ['git'], rect: R(972, 0, 28, 600) }], 'git'), { float: true });
  assert.deepEqual(D.startTarget(BOXES, 'nope'), { float: true });
});

// --- PR #159 Dexter 2: the page hands over the PLAN's boxes, whose tabs are { id, label, ... } objects ---

const { TABS } = require('../app/side-tabs');
const V = require('../app/dock-tree-display');
const planBoxes = (l, vp = VP, sel = {}) => V.treePlan(l, sel, TABS, vp, {}).boxes;
const allIds = TABS.map(t => t.id);

test('Dexter 2: on the plan\'s own boxes a move starts on the middle of the group the panel sits in', () => {
  const l = T.defaultLayout(allIds);
  assert.deepEqual(D.startTarget(planBoxes(l), 'vault'), { cell: 'right', side: 'center' });
});

test('Dexter 2: ...and of the float it floats in', () => {
  const l = T.dock(T.defaultLayout(allIds), 'vault', { float: { x: 40, y: 40 } });
  assert.deepEqual(D.startTarget(planBoxes(l), 'vault'), { cell: l.floats[0].id, side: 'center' });
});

test('Dexter 2: Move then Enter with no step leaves the placement exactly as it was (the very same layout)', () => {
  const l = T.defaultLayout(allIds);
  const boxes = planBoxes(l);
  const start = D.startTarget(boxes, 'vault');
  assert.equal(T.dock(l, 'vault', start), l);
  assert.match(D.describeTarget(start, c => `the ${c} group`), /as a tab in the right group/);
});

test('Dexter 2: a first arrow steps from the group, not from the terminal', () => {
  const l = T.defaultLayout(allIds);
  const boxes = planBoxes(l);
  assert.deepEqual(D.nextZone(boxes, VP, D.startTarget(boxes, 'vault'), 'ArrowLeft'), { cell: 'right', side: 'left' });
});

// --- stepping -------------------------------------------------------------------------------

test('arrow keys walk from the group\'s middle: left into its left band, then the terminal', () => {
  let t = { cell: 'right', side: 'center' };
  t = D.nextZone(BOXES, VP, t, 'ArrowLeft');
  assert.deepEqual(t, { cell: 'right', side: 'left' });
  t = D.nextZone(BOXES, VP, t, 'ArrowLeft');
  assert.equal(t.cell, 'term', 'the next zone leftward is the terminal\'s right band');
  assert.equal(t.side, 'right');
});

test('up and down step through a cell\'s bands, then onto the rim', () => {
  let t = { cell: 'right', side: 'center' };
  t = D.nextZone(BOXES, VP, t, 'ArrowUp');
  assert.deepEqual(t, { cell: 'right', side: 'top' });
  t = D.nextZone(BOXES, VP, t, 'ArrowUp');
  assert.deepEqual(t, { edge: 'top' });
  assert.deepEqual(D.nextZone(BOXES, VP, t, 'ArrowUp'), t, 'nothing above the top rim: it stays');
});

test('the far right is the right rim; from there only back', () => {
  let t = { cell: 'right', side: 'center' };
  t = D.nextZone(BOXES, VP, t, 'ArrowRight');
  assert.deepEqual(t, { cell: 'right', side: 'right' });
  t = D.nextZone(BOXES, VP, t, 'ArrowRight');
  assert.deepEqual(t, { edge: 'right' });
  assert.deepEqual(D.nextZone(BOXES, VP, t, 'ArrowRight'), t);
});

test('a key that is not an arrow, or no current target, never moves it', () => {
  const t = { cell: 'right', side: 'center' };
  for (const key of ['Enter', 'a', 'Escape', '', null, 7]) assert.deepEqual(D.nextZone(BOXES, VP, t, key), t, String(key));
});

test('Tab steps to the next zone in the order the pointer would meet them, Shift+Tab to the one before, round and round', () => {
  const all = D.candidates(BOXES, VP).map(z => z.target);
  let t = all[0];
  const walked = [t];
  for (let i = 1; i < all.length; i += 1) { t = D.nextZone(BOXES, VP, t, 'Tab'); walked.push(t); }
  assert.deepEqual(walked, all, 'every zone once');
  assert.deepEqual(D.nextZone(BOXES, VP, t, 'Tab'), all[0], 'and round to the first');
  assert.deepEqual(D.nextZone(BOXES, VP, all[0], 'ShiftTab'), all[all.length - 1], 'backwards round to the last');
  assert.deepEqual(D.nextZone(BOXES, VP, all[3], 'ShiftTab'), all[2]);
});

test('with no target yet an arrow lands on the terminal\'s float zone (the middle of the window)', () => {
  assert.deepEqual(D.nextZone(BOXES, VP, null, 'ArrowLeft'), { float: true });
});

test('a target that no longer exists (the layout changed under the move) steps from the terminal\'s middle', () => {
  const t = D.nextZone(BOXES, VP, { cell: 'gone', side: 'center' }, 'ArrowRight');
  assert.ok(t !== null && typeof t === 'object');
});

// --- what is lit ----------------------------------------------------------------------------

test('zonesFor lights the rim and the cell of the target, the target hot', () => {
  const z = D.zonesFor(BOXES, VP, { cell: 'right', side: 'top' });
  assert.equal(z.zones.filter(x => x.hot).length, 1);
  assert.deepEqual(z.zones.find(x => x.hot).target, { cell: 'right', side: 'top' });
  assert.deepEqual(z.target, { cell: 'right', side: 'top' });
  assert.equal(z.zones.filter(x => x.target.edge).length, 4, 'the rim is always lit');
  assert.ok(!z.zones.some(x => x.target.cell === 'term'), 'the terminal\'s zones are not (another cell)');
});

test('a rim target lights the rim alone with that edge hot', () => {
  const z = D.zonesFor(BOXES, VP, { edge: 'left' });
  assert.deepEqual(z.zones.map(x => x.hot), [false, false, true, false]);
});

test('the terminal\'s float zone lights the terminal\'s cell', () => {
  const z = D.zonesFor(BOXES, VP, { float: true });
  assert.deepEqual(z.zones.find(x => x.hot).target, { float: true });
  assert.ok(z.zones.some(x => x.target.cell === 'term' && x.target.side === 'left'));
});

test('a target that is not on screen lights the rim with nothing hot and answers a null target', () => {
  const z = D.zonesFor(BOXES, VP, { cell: 'gone', side: 'top' });
  assert.equal(z.zones.filter(x => x.hot).length, 0);
  assert.equal(z.target, null);
});

// --- what it says ---------------------------------------------------------------------------

const nameOf = c => (c === 'term' ? 'the terminal' : `the ${c} group`);

test('describeTarget says where the panel will land, in words', () => {
  assert.equal(D.describeTarget({ edge: 'left' }, nameOf), 'along the window\'s left edge');
  assert.equal(D.describeTarget({ cell: 'right', side: 'left' }, nameOf), 'left of the right group');
  assert.equal(D.describeTarget({ cell: 'right', side: 'right' }, nameOf), 'right of the right group');
  assert.equal(D.describeTarget({ cell: 'term', side: 'top' }, nameOf), 'above the terminal');
  assert.equal(D.describeTarget({ cell: 'term', side: 'bottom' }, nameOf), 'below the terminal');
  assert.equal(D.describeTarget({ cell: 'right', side: 'center' }, nameOf), 'as a tab in the right group');
  assert.equal(D.describeTarget({ float: true }, nameOf), 'floating over the terminal');
  assert.equal(D.describeTarget(null, nameOf), 'nowhere');
  assert.equal(D.describeTarget({ junk: 1 }, nameOf), 'nowhere');
});

// --- properties -----------------------------------------------------------------------------

const sizeArb = fc.integer({ min: -50, max: 3000 });
const tabsArb = fc.array(fc.constantFrom(...IDS), { maxLength: 9 });
const { node: nodeArb } = fc.letrec(tie => ({
  node: fc.oneof({ depthSize: 'small', maxDepth: 4 }, tie('leaf'), tie('split')),
  leaf: fc.oneof(
    { weight: 1, arbitrary: fc.constant({ type: 'term' }) },
    { weight: 3, arbitrary: fc.record({ type: fc.constant('group'), id: fc.constantFrom('a', 'b', 'c', 'g1', 'g2'), tabs: tabsArb }) },
  ),
  split: fc.record({ type: fc.constant('split'), dir: fc.constantFrom('row', 'col'), kids: fc.array(tie('node'), { maxLength: 4 }), sizes: fc.array(sizeArb, { maxLength: 5 }) }),
}));
const layoutArb = fc.record({
  version: fc.constant(2), root: nodeArb, hidden: tabsArb,
  floats: fc.array(fc.record({ id: fc.constantFrom('f', 'h'), tabs: tabsArb, x: sizeArb, y: sizeArb, w: sizeArb, h: sizeArb }), { maxLength: 3 }),
}).map(raw => T.normalize(raw, IDS));
const selArb = fc.record({
  foldAll: fc.boolean(),
  collapsed: fc.dictionary(fc.constantFrom('a', 'b', 'c', 'g1', 'g2', 'right'), fc.constant(true)),
});
const vpArb = fc.record({ width: fc.integer({ min: 320, max: 2500 }), height: fc.integer({ min: 160, max: 1500 }) });
const keyArb = fc.constantFrom('ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown');
const stepsArb = fc.array(keyArb, { minLength: 1, maxLength: 12 });

function wholeLayout(l) {
  const all = [...T.groups(l).flatMap(g => g.tabs), ...l.floats.flatMap(f => f.tabs), ...l.hidden];
  assert.deepEqual([...all].sort(), [...IDS].sort());
  assert.equal(T.count(l, 'term'), 1);
  assert.deepEqual(T.normalize(l, IDS), l);
}

test('P1: a step lands on a zone that exists (or stays), and always goes the way the key says', () => {
  fc.assert(fc.property(layoutArb, selArb, vpArb, stepsArb, (l, sel, vp, keys) => {
    const boxes = T.fit(l, sel, vp).boxes;
    const cands = D.candidates(boxes, vp);
    let t = D.startTarget(boxes, IDS[0]);
    for (const key of keys) {
      const next = D.nextZone(boxes, vp, t, key);
      assert.ok(next !== null, 'a target');
      if (!same(next, t)) {
        assert.ok(cands.some(z => same(z.target, next)), `${JSON.stringify(next)} is not a zone on screen`);
        const from = cands.find(z => same(z.target, t));
        if (from) {
          const a = centre(from.rect);
          const b = centre(cands.find(z => same(z.target, next)).rect);
          if (key === 'ArrowLeft') assert.ok(b.x < a.x);
          if (key === 'ArrowRight') assert.ok(b.x > a.x);
          if (key === 'ArrowUp') assert.ok(b.y < a.y);
          if (key === 'ArrowDown') assert.ok(b.y > a.y);
        }
      }
      t = next;
    }
  }), RUNS);
});

test('P1b: Tab reaches every zone there is, from wherever the move began (arrows alone can miss a zone behind another)', () => {
  fc.assert(fc.property(layoutArb, selArb, vpArb, fc.nat(7), (l, sel, vp, which) => {
    const boxes = T.fit(l, sel, vp).boxes;
    const own = T.floatOf(l, IDS[which % IDS.length]);
    const opts = { exclude: own ? own.id : null };
    const cands = D.candidates(boxes, vp, opts);
    let t = D.startTarget(boxes, IDS[which % IDS.length]);
    const seen = new Set();
    for (let i = 0; i <= cands.length + 1; i += 1) { t = D.nextZone(boxes, vp, t, 'Tab', opts); seen.add(JSON.stringify(t)); }
    for (const z of cands) assert.ok(seen.has(JSON.stringify(z.target)), `${JSON.stringify(z.target)} is never reached`);
  }), RUNS);
});

test('P2: every zone the keyboard can reach is a drop the model accepts: any panel, any zone, a whole layout back', () => {
  fc.assert(fc.property(layoutArb, selArb, vpArb, fc.nat(7), (l, sel, vp, which) => {
    const boxes = T.fit(l, sel, vp).boxes;
    const id = IDS[which % IDS.length];
    const own = T.floatOf(l, id);
    for (const z of D.candidates(boxes, vp, { exclude: own ? own.id : null })) {
      const target = z.target.float === true ? { float: T.floatSpotAt({ x: z.rect.x + z.rect.width / 2, y: z.rect.y + z.rect.height / 2 }, vp) } : z.target;
      const next = T.dock(l, id, target);
      wholeLayout(next);
    }
  }), RUNS);
});

test('P3: zonesFor lights exactly one zone for a target that is a candidate, and the target comes back', () => {
  fc.assert(fc.property(layoutArb, selArb, vpArb, fc.nat(60), (l, sel, vp, pick) => {
    const boxes = T.fit(l, sel, vp).boxes;
    const cands = D.candidates(boxes, vp);
    fc.pre(cands.length > 0);
    const target = cands[pick % cands.length].target;
    const lit = D.zonesFor(boxes, vp, target);
    assert.equal(lit.zones.filter(z => z.hot).length, 1);
    assert.ok(same(lit.zones.find(z => z.hot).target, target));
    assert.ok(same(lit.target, target));
  }), RUNS);
});

// --- PR #159 Dexter 4 / Miguel S6: a move that starts on a rail ------------------------------------------------------------

const railBoxes = () => [
  { kind: 'term', rect: R(0, 0, 972, 600) },
  { kind: 'rail', dir: 'v', modules: ['git', 'fog'], rect: R(972, 0, 28, 600), groups: [{ id: 'gA', tabs: ['git'] }, { id: 'gB', tabs: ['fog'] }] },
];

test('Dexter 4: a panel on a rail starts on its own group\'s zone (lit over the rail), not on the terminal\'s float zone', () => {
  const boxes = railBoxes();
  assert.deepEqual(D.startTarget(boxes, 'git'), { cell: 'gA', side: 'center' });
  assert.deepEqual(D.startTarget(boxes, 'fog'), { cell: 'gB', side: 'center' }, 'a folded column: the group that holds it');
  const lit = D.zonesFor(boxes, VP, D.startTarget(boxes, 'git'));
  assert.deepEqual(lit.target, { cell: 'gA', side: 'center' }, 'the start is on screen: Enter right away finds a place to drop');
  assert.deepEqual(lit.zones.find(z => z.hot).rect, R(972, 0, 28, 600));
});

test('Dexter 4: ...and a key from there goes on to the zones around it', () => {
  const boxes = railBoxes();
  const from = D.startTarget(boxes, 'git');
  const left = D.nextZone(boxes, VP, from, 'ArrowLeft');
  assert.ok(left && !same(left, from), 'the arrow left of the rail finds the terminal\'s side of it');
  const next = D.nextZone(boxes, VP, from, 'Tab');
  const prev = D.nextZone(boxes, VP, from, 'ShiftTab');
  assert.ok(next && prev && !same(next, from) && !same(prev, from));
  assert.ok(D.candidates(boxes, VP).some(z => same(z.target, next)) && D.candidates(boxes, VP).some(z => same(z.target, prev)));
});

test('Dexter 4: dock treats that start as the group it already is in: nothing changes', () => {
  const l = T.normalize({ version: 2, root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'group', id: 'gA', tabs: ['git', 'fog'] }], sizes: [0, 180] }, floats: [], hidden: IDS.filter(i => !['git', 'fog'].includes(i)), seat: {} }, IDS);
  const boxes = T.fit(l, { collapsed: { gA: ['git', 'fog'] } }, VP).boxes;
  const start = D.startTarget(boxes, 'git');
  assert.deepEqual(start, { cell: 'gA', side: 'center' });
  assert.deepEqual(T.dock(l, 'git', start), l);
});

test('a rail knows the groups it holds (fit): one per group, a folded column lists each', () => {
  const l = T.normalize({ version: 2, root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'split', dir: 'col', kids: [{ type: 'group', id: 'gA', tabs: ['git'] }, { type: 'group', id: 'gB', tabs: ['fog'] }], sizes: [1, 1] }], sizes: [0, 180] }, floats: [], hidden: IDS.filter(i => !['git', 'fog'].includes(i)), seat: {} }, IDS);
  const rail = T.fit(l, { collapsed: { gA: ['git'], gB: ['fog'] } }, VP).boxes.find(b => b.kind === 'rail');
  assert.deepEqual(rail.groups, [{ id: 'gA', tabs: ['git'] }, { id: 'gB', tabs: ['fog'] }]);
});

// --- PR #159 Dexter 5: the words follow what dock did ----------------------------------------------------------------------

test('Dexter 5: a drop dock refused is announced as not moved, never as "Moved"', () => {
  assert.equal(D.describeDrop(true, 'Git', 'right of the Fog group'), 'Moved Git right of the Fog group.');
  assert.match(D.describeDrop(false, 'Git', 'right of the Git group'), /^Not moved/);
  assert.doesNotMatch(D.describeDrop(false, 'Git', 'as a tab in the Git group'), /Moved/);
});

test('Dexter 5: dock returns the same layout for a lone panel\'s own band, its own centre, and a lone panel\'s touching rim', () => {
  const l = T.normalize({ version: 2, root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'group', id: 'g2', tabs: ['git'] }], sizes: [0, 180] }, floats: [], hidden: IDS.filter(i => i !== 'git'), seat: {} }, IDS);
  const same2 = (t) => JSON.stringify(T.dock(l, 'git', t)) === JSON.stringify(l);
  assert.ok(same2({ cell: 'g2', side: 'right' }), 'right of its own group');
  assert.ok(same2({ cell: 'g2', side: 'center' }), 'its own centre');
});
