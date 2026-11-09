'use strict';
/**
 * BACKLOG #109 part 2 (and the #164 answer that leans on it): a drop between two rail tabs puts the tab there, and the order is
 * remembered. Before #109 the dock rail was always drawn grouped (Work, Repo, Me: app/rail-groups.js) whatever order
 * `layout.rail` held (the order the panels were unpinned in). Now:
 *
 *   - `dockTree.moveOnRail(layout, id, before)` reorders the rail, starting from the order it is DRAWN in, and marks the layout
 *     `railOrdered: true`; from then on the rail is drawn in `layout.rail`'s order, a separator wherever the group changes.
 *   - A layout without the mark (every layout saved before #109) is drawn grouped, as before. A mark that is not `true` is no mark.
 *   - `dockDrag.railDrop` is where on the rail a drop lands: before the tab whose middle is past the pointer, else at the end.
 *   - Reordering never changes which panels are docked, floating or hidden.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const T = require('../app/dock-tree');
const G = require('../app/rail-groups');
const D = require('../app/dock-drag');
const { TABS } = require('../app/side-tabs');

const IDS = TABS.map(t => t.id);
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };
const ids = items => items.filter(i => !i.sep).map(i => i.id);

// Every panel on the rail (the start layout), Claude's panel brought onto it too.
const allRailed = () => T.showOnRail(T.startLayout(IDS), 'canvas');
// Two docked groups and three panels on the rail.
const mixed = () => ['vault', 'git', 'agents'].reduce((l, id) => T.unpin(l, id), T.defaultLayout(IDS));
const notRail = l => ({ root: l.root, floats: l.floats, hidden: l.hidden });

// --- the drawn order -----------------------------------------------------------------------

test('inOrder keeps the order it is given and puts a separator wherever the group changes', () => {
  assert.deepEqual(G.inOrder(['agents', 'git', 'canvas', 'fog']), [{ id: 'agents' }, { id: 'git' }, { sep: true }, { id: 'canvas' }, { sep: true }, { id: 'fog' }]);
  assert.deepEqual(G.inOrder(['git', 'agents']), [{ id: 'git' }, { id: 'agents' }], 'one group: no separator');
  assert.deepEqual(G.inOrder([]), []);
  for (const j of [null, undefined, 5, 'x', {}]) assert.deepEqual(G.inOrder(j), []);
  assert.deepEqual(G.inOrder([null, 3, '', 'git']), [{ id: 'git' }]);
});

test('a rail without the mark is drawn grouped, as before #109', () => {
  const l = mixed();
  assert.deepEqual(l.rail, ['vault', 'git', 'agents'], 'stored in unpin order');
  assert.equal('railOrdered' in l, false, 'no mark on a layout nobody reordered');
  assert.deepEqual(T.drawnRail(l), ['agents', 'git', 'vault']);
});

test('fit tells the dock rail whether it is ordered', () => {
  const vp = { width: 1200, height: 700 };
  const box = l => T.fit(l, { active: {}, foldAll: false }, vp).boxes.find(b => b.kind === 'rail' && b.id === 'dock');
  assert.equal(box(mixed()).ordered, false);
  assert.equal(box(T.moveOnRail(mixed(), 'vault', 'agents')).ordered, true);
});

// --- placement ------------------------------------------------------------------------------

test('a drop before another tab puts it there, starting from the drawn order, and marks the layout', () => {
  const l = T.moveOnRail(mixed(), 'vault', 'git');          // drawn: agents, git, vault
  assert.deepEqual(l.rail, ['agents', 'vault', 'git']);
  assert.equal(l.railOrdered, true);
  assert.deepEqual(T.drawnRail(l), ['agents', 'vault', 'git']);
});

test('first and last: before the first tab, and before nothing (the end)', () => {
  assert.deepEqual(T.moveOnRail(mixed(), 'vault', 'agents').rail, ['vault', 'agents', 'git']);
  assert.deepEqual(T.moveOnRail(mixed(), 'agents', null).rail, ['git', 'vault', 'agents']);
});

test('a drop onto itself, or just after itself, changes nothing: the very same layout, no mark', () => {
  const l = mixed();
  assert.equal(T.moveOnRail(l, 'git', 'git'), l);
  assert.equal(T.moveOnRail(l, 'agents', 'git'), l, 'agents already sits right before git');
  assert.equal(T.moveOnRail(l, 'vault', null), l, 'vault is already last');
  const o = T.moveOnRail(l, 'vault', 'agents');
  assert.equal(T.moveOnRail(o, 'vault', 'vault'), o);
  assert.equal(T.moveOnRail(o, 'git', null), o);
});

test('a tab that is not on the rail, or a place that is not on it, changes nothing', () => {
  const l = mixed();
  for (const [id, before] of [['fog', 'git'], ['nope', null], [null, 'git'], [5, null], ['git', 'fog'], ['git', 'nope'], ['git', 7], ['git', undefined]]) {
    assert.equal(T.moveOnRail(l, id, before), l, `${id} before ${before}`);
  }
});

test('reordering never changes what is docked, floating or hidden', () => {
  const l = T.dock(mixed(), 'style', { float: { x: 40, y: 40, w: 300, h: 200 } });
  const o = T.moveOnRail(l, 'vault', 'agents');
  assert.deepEqual(notRail(o), notRail(l));
  assert.deepEqual([...o.rail].sort(), [...l.rail].sort());
});

test('Ricardo\'s three favourites to the top: Agents, Git, Claude\'s panel', () => {
  let l = allRailed();
  const drawn0 = T.drawnRail(l);
  l = T.moveOnRail(l, 'canvas', drawn0[0]);
  l = T.moveOnRail(l, 'git', T.drawnRail(l)[0]);
  l = T.moveOnRail(l, 'agents', T.drawnRail(l)[0]);
  assert.deepEqual(T.drawnRail(l).slice(0, 3), ['agents', 'git', 'canvas']);
  assert.equal(T.drawnRail(l).length, drawn0.length);
  assert.deepEqual(ids(G.inOrder(T.drawnRail(l))), T.drawnRail(l));
});

test('after a reorder, an unpinned panel joins at the end and a pinned one leaves the rest in their order', () => {
  const o = T.moveOnRail(mixed(), 'vault', 'agents');        // vault, agents, git
  assert.deepEqual(T.drawnRail(T.unpin(o, 'fog')), ['vault', 'agents', 'git', 'fog']);
  const p = T.pin(o, 'agents');
  assert.deepEqual(T.drawnRail(p), ['vault', 'git']);
  assert.equal(p.railOrdered, true);
});

// --- persistence ----------------------------------------------------------------------------

test('the order and its mark survive the save and the read (JSON, normalize, readStored)', () => {
  const o = T.moveOnRail(mixed(), 'vault', 'agents');
  const saved = JSON.parse(JSON.stringify(o));
  for (const read of [T.normalize(saved, IDS), T.readStored(saved, IDS), T.readAny(saved, IDS)]) {
    assert.deepEqual(read.rail, ['vault', 'agents', 'git']);
    assert.equal(read.railOrdered, true);
    assert.deepEqual(T.drawnRail(read), ['vault', 'agents', 'git']);
  }
});

test('an old layout without a mark loads as it always did: no mark, drawn grouped, nothing else moves', () => {
  const saved = JSON.parse(JSON.stringify(mixed()));
  const read = T.readStored(saved, IDS);
  assert.equal('railOrdered' in read, false);
  assert.deepEqual(read, T.readStored(saved, IDS));
  assert.deepEqual(T.drawnRail(read), ['agents', 'git', 'vault']);
});

test('a corrupt mark is no mark: the rail drawn grouped, the docked tree untouched', () => {
  const base = JSON.parse(JSON.stringify(mixed()));
  for (const junk of ['yes', 1, 0, {}, [], null, 'true']) {
    const read = T.normalize({ ...base, railOrdered: junk }, IDS);
    assert.equal('railOrdered' in read, false, JSON.stringify(junk));
    assert.deepEqual(read.root, T.normalize(base, IDS).root);
    assert.deepEqual(T.drawnRail(read), ['agents', 'git', 'vault']);
  }
});

test('a corrupt order keeps what it can: junk, unknown and repeated ids dropped, the rest in order, the docked tree untouched', () => {
  const base = JSON.parse(JSON.stringify(T.moveOnRail(mixed(), 'vault', 'agents')));
  const read = T.normalize({ ...base, rail: ['git', 7, 'nope', null, 'vault', 'git', '', 'agents'] }, IDS);
  assert.deepEqual(read.rail, ['git', 'vault', 'agents']);
  assert.equal(read.railOrdered, true);
  assert.deepEqual(read.root, T.normalize(base, IDS).root);
});

// --- where on the rail a drop lands -----------------------------------------------------------

const RAIL = { rect: { x: 948, y: 0, width: 52, height: 600 }, dir: 'v', slots: [
  { id: 'agents', rect: { x: 948, y: 0, width: 52, height: 40 } },
  { id: 'git', rect: { x: 948, y: 40, width: 52, height: 40 } },
  { id: 'vault', rect: { x: 948, y: 91, width: 52, height: 40 } },      // after a separator
] };
const NO_HIT = { zones: [], target: null };
const at = (y, id = 'vault', hit = NO_HIT, x = 960) => D.railDrop(hit, RAIL, { x, y }, id);

test('a drop on the rail lands before the tab whose middle is past the pointer, else at the end', () => {
  assert.deepEqual(at(5).target, { rail: 'dock', before: 'agents' });
  assert.deepEqual(at(19).target, { rail: 'dock', before: 'agents' });
  assert.deepEqual(at(21).target, { rail: 'dock', before: 'git' });
  assert.deepEqual(at(500, 'agents').target, { rail: 'dock', before: null });
});

test('the hot zone is a thin line across the rail at the gap, inside the rail', () => {
  const r = at(21);
  const line = r.zones.find(z => z.line);
  assert.ok(line && line.hot === true);
  assert.deepEqual(line.target, r.target);
  assert.equal(line.rect.height, 2);
  assert.equal(line.rect.y, 39, 'centred on the gap above git');
  assert.ok(line.rect.x >= RAIL.rect.x && line.rect.x + line.rect.width <= RAIL.rect.x + RAIL.rect.width);
  assert.equal(at(500, 'agents').zones.find(z => z.line).rect.y, 130, 'at the end: under the last tab, inside the rail');
  assert.equal(at(5).zones.find(z => z.line).rect.y, 0, 'at the top: never above the rail');
});

// PR #241 Miguel L6: the line stands 6 px in from each side of the rail, so it reads as a gap marker and not the rail's border; a
// rail too narrow for that (16 px or less across) gets a line the whole way across.
test('the line is inset 6 px from each side, and spans a rail too narrow for the inset', () => {
  const line = rail => D.railDrop(NO_HIT, rail, { x: rail.rect.x + 2, y: 21 }, 'vault').zones.find(z => z.line).rect;
  assert.deepEqual([line(RAIL).x, line(RAIL).width], [954, 40]);
  const narrow = w => ({ ...RAIL, rect: { ...RAIL.rect, width: w }, slots: RAIL.slots.map(s => ({ ...s, rect: { ...s.rect, width: w } })) });
  assert.deepEqual([line(narrow(17)).x, line(narrow(17)).width], [954, 5], '17 px: still inset');
  assert.deepEqual([line(narrow(16)).x, line(narrow(16)).width], [948, 16], '16 px: across the whole rail');
});

test('a drop that would leave the tab where it is shows no line and has no target', () => {
  for (const [y, id] of [[100, 'vault'], [500, 'vault'], [55, 'git'], [21, 'agents']]) {
    const r = at(y, id);
    assert.equal(r.target, null, `${id} at ${y}`);
    assert.equal(r.zones.some(z => z.line), false);
  }
});

test('the rim along the rail\'s side of the window and a float on top win over the rail; off the rail, the zones are the cell\'s', () => {
  const rim = { zones: [{ rect: { x: 986, y: 14, width: 14, height: 572 }, target: { edge: 'right' }, hot: true }], target: { edge: 'right' } };
  assert.equal(at(100, 'agents', rim, 990), rim);
  const float = { zones: [{ rect: { x: 900, y: 50, width: 300, height: 200 }, target: { cell: 'f1', side: 'center' }, hot: true }], target: { cell: 'f1', side: 'center' } };
  assert.equal(at(100, 'agents', float), float);
  const cell = { zones: [{ rect: { x: 0, y: 0, width: 10, height: 10 }, target: { cell: 'term', side: 'left' }, hot: true }], target: { cell: 'term', side: 'left' } };
  assert.equal(D.railDrop(cell, RAIL, { x: 100, y: 100 }, 'agents'), cell);
});

// Found by verify/probe-rail-drag.js: the window's top rim is 14 px tall and the first rail tab starts at the top, so a drop just
// above the first tab docked the panel along the window's top edge instead of putting it first. Over the rail, the rim strips
// that cross its ends are the rail's; the top edge can still be had anywhere left of the rail.
test('over the rail, the top and bottom rim strips are the rail\'s: a drop there reorders, it never docks along the edge', () => {
  const top = { zones: [{ rect: { x: 0, y: 0, width: 1000, height: 14 }, target: { edge: 'top' }, hot: true }], target: { edge: 'top' } };
  const r = at(3, 'vault', top);
  assert.deepEqual(r.target, { rail: 'dock', before: 'agents' });
  assert.equal(r.zones.filter(z => z.hot).length, 1);
  assert.equal(r.zones.find(z => z.hot).line, true, 'the rim stays lit but is not the hot zone');
  const bottom = { zones: [{ rect: { x: 0, y: 586, width: 1000, height: 14 }, target: { edge: 'bottom' }, hot: true }], target: { edge: 'bottom' } };
  assert.deepEqual(at(590, 'agents', bottom).target, { rail: 'dock', before: null });
  assert.deepEqual(at(3, 'agents', top).target, null, 'a drop that leaves it in place is no drop at all, not a dock along the top');
  assert.equal(D.railDrop(top, RAIL, { x: 500, y: 3 }, 'vault'), top, 'off the rail the top edge is the top edge');
});

test('over the rail the rim\'s zones stay lit, none of them hot, and the line is the one hot zone', () => {
  const lit = { zones: [{ rect: { x: 986, y: 14, width: 14, height: 572 }, target: { edge: 'right' }, hot: false }], target: null };
  const r = at(21, 'vault', lit);
  assert.equal(r.zones.length, 2);
  assert.equal(r.zones.filter(z => z.hot).length, 1);
  assert.equal(r.zones.find(z => z.hot).line, true);
});

test('a horizontal rail measures along x', () => {
  const h = { rect: { x: 0, y: 560, width: 300, height: 40 }, dir: 'h', slots: [
    { id: 'a', rect: { x: 0, y: 560, width: 60, height: 40 } }, { id: 'b', rect: { x: 60, y: 560, width: 60, height: 40 } }] };
  assert.deepEqual(D.railDrop(NO_HIT, h, { x: 70, y: 580 }, 'zz').target, { rail: 'dock', before: 'b' });
  assert.equal(D.railDrop(NO_HIT, h, { x: 70, y: 580 }, 'zz').zones.find(z => z.line).rect.width, 2);
});

test('no rail, a junk rail or a junk point: the hit as it was', () => {
  for (const rail of [null, undefined, 5, {}, { rect: RAIL.rect }, { ...RAIL, slots: 'x' }, { ...RAIL, dir: 'q' }]) assert.equal(D.railDrop(NO_HIT, rail, { x: 960, y: 20 }, 'vault'), NO_HIT, JSON.stringify(rail));
  for (const p of [null, {}, { x: NaN, y: 2 }, { x: 'a', y: 1 }]) assert.equal(D.railDrop(NO_HIT, RAIL, p, 'vault'), NO_HIT);
});

// --- a long rail scrolls under a drag (PR #241 Dexter 2, Miguel M2) ----------------------------
// A full rail on a laptop overflows and scrolls; #164's "favourites to the top" is exactly a drop at a gap scrolled out of sight.
// While a drag holds the pointer near either end of the rail, the rail scrolls that way, faster the nearer the end.

test('the auto-scroll edge and speed', () => {
  assert.equal(D.RAIL_SCROLL.edge, 28);
  assert.equal(D.RAIL_SCROLL.max, 12);
});

test('near the rail\'s top it scrolls up, near its bottom down, faster the nearer; in between, not at all', () => {
  const step = y => D.railScrollStep(RAIL, { x: 960, y });
  assert.equal(step(0), -12, 'at the very top: the most');
  assert.equal(step(27), -1, 'just inside the edge: the least, never zero');
  assert.equal(step(28), 0);
  assert.equal(step(300), 0);
  assert.equal(step(571), 0);
  assert.equal(step(573), 1);
  assert.equal(step(599), 12);
  assert.ok(step(5) < step(20), 'nearer the top is faster up');
});

test('off the rail, a junk rail or a junk point: no scroll; a horizontal rail scrolls along x', () => {
  assert.equal(D.railScrollStep(RAIL, { x: 100, y: 5 }), 0, 'beside the rail');
  for (const rail of [null, {}, { rect: RAIL.rect }, { ...RAIL, dir: 'q' }]) assert.equal(D.railScrollStep(rail, { x: 960, y: 5 }), 0);
  for (const p of [null, {}, { x: NaN, y: 5 }]) assert.equal(D.railScrollStep(RAIL, p), 0);
  const h = { rect: { x: 0, y: 560, width: 300, height: 40 }, dir: 'h' };
  assert.equal(D.railScrollStep(h, { x: 2, y: 580 }) < 0, true);
  assert.equal(D.railScrollStep(h, { x: 298, y: 580 }) > 0, true);
});

// --- the property ---------------------------------------------------------------------------

test('property: whatever sequence of rail drops, the rail holds each module exactly once and nothing else moves', () => {
  const start = T.dock(mixed(), 'style', { float: { x: 40, y: 40, w: 300, h: 200 } });
  const withFog = T.unpin(start, 'fog');
  const pool = [...withFog.rail, 'style', 'nope', null, 7];
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom(...pool), fc.constantFrom(...pool)), { maxLength: 15 }), (moves) => {
    let l = withFog;
    for (const [id, before] of moves) {
      const next = T.moveOnRail(l, id, before);
      const onRail = l.rail.includes(id) && (before === null || l.rail.includes(before));
      if (onRail && before !== id) {
        const drawn = T.drawnRail(next);
        const k = drawn.indexOf(id);
        assert.equal(before === null ? k === drawn.length - 1 : drawn[k + 1] === before, true, `${id} lands before ${before}`);
      } else assert.equal(next, l, `${id} before ${before} changes nothing`);
      l = next;
      assert.deepEqual([...l.rail].sort(), [...withFog.rail].sort());
      assert.equal(new Set(l.rail).size, l.rail.length);
      assert.deepEqual(notRail(l), notRail(withFog));
      assert.deepEqual(T.drawnRail(T.normalize(JSON.parse(JSON.stringify(l)), IDS)), T.drawnRail(l), 'and it reads back the same');
    }
  }), RUNS);
});
