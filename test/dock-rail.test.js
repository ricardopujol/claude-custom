'use strict';
/**
 * The dock's own rail (BACKLOG #85): a panel is PINNED (a real panel in the layout, the terminal gives it room) or UNPINNED
 * (a tab on the rail at the window's right edge; hovering it slides its panel over the terminal). The layout holds the rail
 * as `rail: [moduleId...]`, and every module is in exactly one of the tree, a float, the rail or hidden.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const T = require('../app/dock-tree');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };

const everywhere = l => [
  ...T.groups(l).flatMap(g => g.tabs), ...l.floats.flatMap(f => f.tabs), ...l.rail, ...l.hidden,
];
const sorted = a => [...a].sort();

// --- normalize ---------------------------------------------------------------------

test('the default layout has an empty rail', () => {
  assert.deepEqual(T.defaultLayout(IDS).rail, []);
});

test('a stored layout with no rail (another build) reads as an empty rail and nothing moves', () => {
  const d = T.defaultLayout(IDS);
  const { rail, ...old } = d;
  const read = T.normalize(old, IDS);
  assert.deepEqual(read, d);
});

test('a railed module is kept, once, in the order listed; unknown, repeated and junk names go', () => {
  const d = T.defaultLayout(IDS);
  const l = T.normalize({ ...d, root: T.unpin(T.unpin(d, 'git'), 'vault').root, rail: ['git', 'ghost', 'git', 7, null, 'vault'] }, IDS);
  assert.deepEqual(l.rail, ['git', 'vault']);
  assert.deepEqual(sorted(everywhere(l)), sorted(IDS));
});

test('a rail that is not a list reads as empty', () => {
  const d = T.defaultLayout(IDS);
  for (const junk of [null, 'git', 7, {}, true]) assert.deepEqual(T.normalize({ ...d, rail: junk }, IDS).rail, []);
});

test('a module the tree already holds is not also on the rail, and a railed one is not also hidden', () => {
  const d = T.defaultLayout(IDS);
  assert.deepEqual(T.normalize({ ...d, rail: ['agents'] }, IDS).rail, []);
  const l = T.normalize({ ...d, root: T.unpin(d, 'git').root, rail: ['git'], hidden: ['git'] }, IDS);
  assert.deepEqual(l.rail, ['git']);
  assert.deepEqual(l.hidden, []);
});

test('a railed module keeps its seat; a seat of a pinned module is dropped', () => {
  const d = T.defaultLayout(IDS);
  const u = T.unpin(d, 'git');
  assert.ok(u.seat.git);
  assert.ok(!T.pin(u, 'git').seat.git);
});

// --- unpin / pin -----------------------------------------------------------------------

test('unpin sends a docked module to the end of the rail, and it leaves the tree', () => {
  const d = T.defaultLayout(IDS);
  const u = T.unpin(T.unpin(d, 'git'), 'vault');
  assert.deepEqual(u.rail, ['git', 'vault']);
  assert.ok(!T.groupOf(u, 'git'));
  assert.deepEqual(sorted(everywhere(u)), sorted(IDS));
});

test('unpin of a floating module puts it on the rail and removes the float when it was alone', () => {
  const d = T.dock(T.defaultLayout(IDS), 'git', { float: { x: 40, y: 40 } });
  assert.equal(d.floats.length, 1);
  const u = T.unpin(d, 'git');
  assert.deepEqual(u.rail, ['git']);
  assert.equal(u.floats.length, 0);
});

test('unpin of something already on the rail, hidden or unknown changes nothing (the same object)', () => {
  const d = T.defaultLayout(IDS);
  const u = T.unpin(d, 'git');
  assert.equal(T.unpin(u, 'git'), u);
  const h = T.hide(d, 'fog');
  assert.equal(T.unpin(h, 'fog'), h);
  assert.equal(T.unpin(d, 'ghost'), d);
  assert.equal(T.unpin(d, 7), d);
});

test('pin returns a module to the group it left', () => {
  const d = T.defaultLayout(IDS);
  const back = T.pin(T.unpin(d, 'git'), 'git');
  assert.deepEqual(back.rail, []);
  assert.equal(T.groupOf(back, 'git').id, T.groupOf(d, 'git').id);
  assert.deepEqual(sorted(T.groupOf(back, 'git').tabs), sorted(T.groupOf(d, 'git').tabs));
});

test('a module never pinned before (it started on the rail) gets a new group beside the terminal on the right', () => {
  const d = T.defaultLayout(['agents']);
  const l = T.normalize({ ...d, rail: ['vault'] }, ['agents', 'vault']);
  const p = T.pin(l, 'vault');
  assert.deepEqual(p.rail, []);
  const kids = p.root.kids;
  assert.equal(kids[kids.length - 1].tabs.join(), 'vault');
});

test('pin of a module that is not on the rail changes nothing (the same object)', () => {
  const d = T.defaultLayout(IDS);
  assert.equal(T.pin(d, 'git'), d);
  assert.equal(T.pin(d, 'ghost'), d);
  const h = T.hide(d, 'fog');
  assert.equal(T.pin(h, 'fog'), h);
});

test('unpinGroup sends every tab of a group to the rail, in order, and the group goes', () => {
  const d = T.defaultLayout(IDS);
  const id = T.groups(d)[0].id;
  const u = T.unpinGroup(d, id);
  assert.deepEqual(u.rail, IDS.filter(x => !T.HIDDEN_UNTIL_USED.includes(x)));
  assert.equal(T.groups(u).length, 0);
  assert.equal(T.unpinGroup(d, 'nope'), d);
});

// --- hide / show with the rail -----------------------------------------------------------

test('hide takes a railed module off the rail; show of a hidden module docks it (pinned) at its seat', () => {
  const d = T.defaultLayout(IDS);
  const h = T.hide(T.unpin(d, 'git'), 'git');
  assert.deepEqual(h.rail, []);
  assert.ok(h.hidden.includes('git'));
  const s = T.show(h, 'git');
  assert.ok(T.groupOf(s, 'git'));
});

test('showOnRail brings a hidden module back as a rail tab', () => {
  const d = T.defaultLayout(IDS);
  const h = T.hide(d, 'git');
  const r = T.showOnRail(h, 'git');
  assert.deepEqual(r.rail, ['git']);
  assert.ok(!r.hidden.includes('git'));
  assert.equal(T.showOnRail(d, 'git'), d);
  // ...and pinning it then goes back where it was hidden from.
  assert.ok(T.groupOf(T.pin(r, 'git'), 'git'));
});

test('dock moves a railed module to its target', () => {
  const d = T.unpin(T.defaultLayout(IDS), 'git');
  const l = T.dock(d, 'git', { edge: 'left' });
  assert.deepEqual(l.rail, []);
  assert.equal(T.groups(l)[0].tabs.join(), 'git');
});

// --- fit ---------------------------------------------------------------------------------

test('a non-empty rail takes a 28 px strip at the right edge and the tree fits in the rest', () => {
  const d = T.unpin(T.defaultLayout(IDS), 'git');
  const { boxes } = T.fit(d, null, { width: 1000, height: 600 });
  const rail = boxes.find(b => b.kind === 'rail' && b.id === 'dock');
  assert.deepEqual(rail.rect, { x: 972, y: 0, width: 28, height: 600 });
  assert.deepEqual(rail.modules, ['git']);
  assert.equal(rail.dir, 'v');
  const right = Math.max(...boxes.filter(b => b.kind !== 'rail').map(b => b.rect.x + b.rect.width));
  assert.ok(right <= 972);
});

test('an empty rail draws nothing and leaves the tree as it was', () => {
  const d = T.defaultLayout(IDS);
  const { boxes } = T.fit(d, null, { width: 1000, height: 600 });
  assert.ok(!boxes.some(b => b.kind === 'rail'));
});

test('the terminal is as wide with the rail open over it as with it closed (hover never resizes it)', () => {
  const d = T.unpin(T.defaultLayout(IDS), 'git');
  const { boxes } = T.fit(d, null, { width: 1000, height: 600 });
  const term = boxes.find(b => b.kind === 'term').rect;
  const peek = T.peekFor(boxes, 'git', { width: 1000, height: 600 });
  assert.ok(peek.rect.x + peek.rect.width <= 972);
  assert.ok(peek.rect.x >= 0);
  assert.ok(term.width > 0);
});

test('a window too narrow for the strip draws no rail rather than a negative tree', () => {
  const d = T.unpin(T.defaultLayout(IDS), 'git');
  const { boxes } = T.fit(d, null, { width: 20, height: 600 });
  for (const b of boxes) assert.ok(b.rect.width >= 0);
});

// --- properties -----------------------------------------------------------------------------

const opArb = fc.oneof(
  fc.record({ op: fc.constantFrom('unpin', 'pin', 'hide', 'show', 'showOnRail'), id: fc.constantFrom(...IDS, 'ghost') }),
  fc.record({ op: fc.constant('dock'), id: fc.constantFrom(...IDS), edge: fc.constantFrom('left', 'right', 'top', 'bottom') }),
  fc.record({ op: fc.constant('float'), id: fc.constantFrom(...IDS) }),
);
const apply = (l, o) => {
  switch (o.op) {
    case 'dock': return T.dock(l, o.id, { edge: o.edge });
    case 'float': return T.dock(l, o.id, { float: true });
    default: return T[o.op](l, o.id);
  }
};

test('P: after any mix of operations every module is in exactly one of tree, float, rail, hidden', () => {
  fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
    const l = ops.reduce(apply, T.defaultLayout(IDS));
    assert.deepEqual(sorted(everywhere(l)), sorted(IDS));
    assert.deepEqual(T.normalize(l, IDS), l);
    for (const id of l.rail) assert.ok(!l.hidden.includes(id) && !T.groupOf(l, id) && !T.floatOf(l, id));
  }), RUNS);
});

test('P: unpin then pin leaves the module in the tree and unpin of it again puts it back on the rail', () => {
  fc.assert(fc.property(fc.array(opArb, { maxLength: 15 }), fc.constantFrom(...IDS), (ops, id) => {
    const l = ops.reduce(apply, T.defaultLayout(IDS));
    if (!T.groupOf(l, id)) return;
    const u = T.unpin(l, id);
    assert.ok(u.rail.includes(id));
    const p = T.pin(u, id);
    assert.ok(T.groupOf(p, id));
    assert.ok(!p.rail.includes(id));
    assert.ok(T.unpin(p, id).rail.includes(id));
  }), RUNS);
});

test('P: a stored rail of any junk still gives a layout holding every module once', () => {
  const junk = fc.oneof(fc.constantFrom('ghost', 7, null, undefined, '', {}, [], true), fc.constantFrom(...IDS));
  fc.assert(fc.property(fc.oneof(fc.array(junk, { maxLength: 12 }), junk), fc.array(fc.constantFrom(...IDS, 'ghost'), { maxLength: 4 }), (rail, hidden) => {
    const l = T.normalize({ ...T.defaultLayout(IDS), rail, hidden }, IDS);
    assert.deepEqual(sorted(everywhere(l)), sorted(IDS));
    for (const id of l.rail) assert.ok(!l.hidden.includes(id));
  }), RUNS);
});

test('P: fit never gives the tree or the rail a negative or overlapping rectangle', () => {
  fc.assert(fc.property(fc.array(opArb, { maxLength: 15 }), fc.integer({ min: 0, max: 1600 }), fc.integer({ min: 0, max: 900 }), (ops, width, height) => {
    const l = ops.reduce(apply, T.defaultLayout(IDS));
    const { boxes } = T.fit(l, null, { width, height });
    for (const b of boxes) assert.ok(b.rect.width >= 0 && b.rect.height >= 0 && b.rect.x >= 0 && b.rect.y >= 0);
    const rail = boxes.find(b => b.kind === 'rail' && b.id === 'dock');
    if (rail) for (const b of boxes.filter(x => x.kind === 'group' || x.kind === 'term')) assert.ok(b.rect.x + b.rect.width <= rail.rect.x);
  }), RUNS);
});

// --- review fixes (PR #168 Dexter 2, 4): a group unpinned and re-pinned stays one group; the strip yields to the terminal ---------

const two = () => T.normalize({
  version: 2, floats: [], rail: [], hidden: [], seat: {},
  root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'group', id: 'g1', tabs: ['git', 'vault'] }], sizes: [0, 180] },
}, ['git', 'vault']);
const pinAll = (l, ids) => ids.reduce(T.pin, l);
const oneGroupWith = (l, ids) => {
  const gs = T.groups(l);
  assert.equal(gs.length, 1, JSON.stringify(gs.map(g => g.tabs)));
  assert.deepEqual(sorted(gs[0].tabs), sorted(ids));
};

test('Dexter 2: unpinGroup, then pin in rail order, gives one group again', () => {
  const u = T.unpinGroup(two(), 'g1');
  assert.deepEqual(u.rail, ['git', 'vault']);
  oneGroupWith(pinAll(u, ['git', 'vault']), ['git', 'vault']);
});

test('Dexter 2: ...and in the reverse order', () => {
  oneGroupWith(pinAll(T.unpinGroup(two(), 'g1'), ['vault', 'git']), ['git', 'vault']);
});

test('Dexter 2: the same for tabs unpinned one by one, in either pin order', () => {
  const u = T.unpin(T.unpin(two(), 'git'), 'vault');
  oneGroupWith(pinAll(u, ['git', 'vault']), ['git', 'vault']);
  oneGroupWith(pinAll(u, ['vault', 'git']), ['git', 'vault']);
});

test('Dexter 2: a group of three with a neighbour comes back as one group (placed as a hidden panel is, beside its old neighbour), whichever tab is pinned first', () => {
  const ids = ['agents', 'git', 'vault', 'fog'];
  const l = T.normalize({
    version: 2, floats: [], rail: [], hidden: [], seat: {},
    root: { type: 'split', dir: 'row', kids: [{ type: 'group', id: 'a', tabs: ['agents'] }, { type: 'term' }, { type: 'group', id: 'b', tabs: ['git', 'vault', 'fog'] }], sizes: [150, 0, 200] },
  }, ids);
  for (const order of [['git', 'vault', 'fog'], ['fog', 'git', 'vault'], ['vault', 'fog', 'git']]) {
    const p = pinAll(T.unpinGroup(l, 'b'), order);
    assert.equal(T.groups(p).length, 2, order.join());
    const gb = T.groupOf(p, 'git');
    assert.deepEqual(sorted(gb.tabs), ['fog', 'git', 'vault']);
    assert.equal(T.groupOf(p, 'agents').tabs.join(), 'agents', 'the neighbour keeps its own group');
  }
});

test('Dexter 2: a mate pinned somewhere else is joined where it is now', () => {
  const u = T.unpinGroup(two(), 'g1');
  const moved = T.dock(T.pin(u, 'git'), 'git', { edge: 'left' });
  const p = T.pin(moved, 'vault');
  assert.equal(T.groupOf(p, 'vault').id, T.groupOf(p, 'git').id);
});

test('P: every pin order of an unpinned group lands in one group, and the layout stays normalized', () => {
  const perms = [['git', 'vault'], ['vault', 'git']];
  fc.assert(fc.property(fc.constantFrom(...perms), fc.boolean(), (order, byGroup) => {
    const l = byGroup ? T.unpinGroup(two(), 'g1') : T.unpin(T.unpin(two(), 'git'), 'vault');
    const p = pinAll(l, order);
    assert.equal(T.groups(p).length, 1);
    assert.deepEqual(T.normalize(p, ['git', 'vault']), p);
  }), RUNS);
});

// --- fit: the strip yields to the terminal -----------------------------------------------------------------------------

test('Dexter 4: a window with no room for a strip and the terminal draws no strip: the terminal keeps its minimum', () => {
  const d = T.unpin(T.defaultLayout(['agents', 'git']), 'git');
  for (const width of [T.TERM_MIN.width + 1, T.TERM_MIN.width + 27, T.TERM_MIN.width + 28 - 1]) {
    const { boxes } = T.fit(d, null, { width, height: 600 });
    assert.ok(boxes.find(b => b.kind === 'term').rect.width >= T.TERM_MIN.width, `at ${width}`);
  }
  const wide = T.fit(d, null, { width: T.TERM_MIN.width + 28 + 120 + 5, height: 600 });
  assert.ok(wide.boxes.some(b => b.kind === 'rail' && b.id === 'dock'), 'with room the strip is there');
});

test('Dexter 4: a folded group\'s rail is not dropped for the strip', () => {
  const l = T.normalize({
    version: 2, floats: [], rail: ['vault'], hidden: [], seat: {},
    root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'group', id: 'g1', tabs: ['git'] }], sizes: [0, 180] },
  }, ['git', 'vault']);
  const sel = T.toggleCollapse(null, l, 'g1');
  const withRail = T.fit(l, sel, { width: 356, height: 600 });
  const tree = withRail.boxes.filter(b => b.kind === 'rail');
  assert.ok(tree.some(b => b.id !== 'dock'), 'the folded group still has its rail');
  assert.ok(withRail.boxes.find(b => b.kind === 'term').rect.width >= T.TERM_MIN.width);
});

test('P: whatever the window, an unpinned panel never takes the terminal under its minimum or removes a folded rail', () => {
  fc.assert(fc.property(fc.integer({ min: 200, max: 900 }), fc.boolean(), (width, fold) => {
    const base = T.normalize({
      version: 2, floats: [], rail: [], hidden: [], seat: {},
      root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'group', id: 'g1', tabs: ['git'] }], sizes: [0, 180] },
    }, ['git', 'vault']);
    const railed = T.unpin(base, 'vault');
    const sel = fold ? T.toggleCollapse(null, base, 'g1') : null;
    const a = T.fit(base, sel, { width, height: 600 });
    const b = T.fit(railed, sel, { width, height: 600 });
    const termA = a.boxes.find(x => x.kind === 'term').rect.width;
    const termB = b.boxes.find(x => x.kind === 'term').rect.width;
    assert.ok(termB >= Math.min(termA, T.TERM_MIN.width));
    assert.ok(b.boxes.filter(x => x.kind === 'rail' && x.id !== 'dock').length >= a.boxes.filter(x => x.kind === 'rail').length);
  }), RUNS);
});
