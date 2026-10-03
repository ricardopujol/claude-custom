'use strict';
/**
 * PROPERTIES of the dock tree (BACKLOG #53, D1 Task 7).
 *
 * The unit tests pin each rule; these pin what must hold after ANY mix of them,
 * starting from ANY stored value -- including one a newer build or another
 * branch wrote. Each property names an invariant the page relies on without
 * checking: a module shown twice or nowhere is a panel that vanishes, two
 * terminals are two ptys, and a terminal squeezed under its minimum is the one
 * thing this window is for. (L1's P1, P4 and P7 each found a real defect.)
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const T = require('../app/dock-tree');
const DL = require('../app/dock-layout');

const { TERM_MIN, MIN, GUTTER } = T;
const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };

// --- arbitraries ---------------------------------------------------------------

const junk = fc.constantFrom('ghost', 'fog2', 7, null, undefined, '', {}, [], true);
const idOrJunk = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...IDS) }, { weight: 1, arbitrary: junk });
const tabsArb = fc.array(idOrJunk, { maxLength: 9 });
// Sizes as a damaged or hand-edited file might hold them, including the two that broke L1.
const sizeArb = fc.oneof(
  fc.integer({ min: -50, max: 3000 }), fc.double(), fc.constant(null), fc.string(),
  fc.constant(1e306), fc.constant(5e-324), fc.constant(0), fc.constant(NaN),
);
const groupIdArb = fc.oneof(fc.constantFrom('a', 'b', 'c', 'g1', 'g2', 'right'), junk);

const { node: nodeArb } = fc.letrec(tie => ({
  node: fc.oneof({ depthSize: 'small', maxDepth: 5 }, tie('leaf'), tie('split')),
  leaf: fc.oneof(
    { weight: 1, arbitrary: fc.constant({ type: 'term' }) },
    { weight: 3, arbitrary: fc.record({ type: fc.constant('group'), id: groupIdArb, tabs: tabsArb }, { requiredKeys: ['type'] }) },
    { weight: 1, arbitrary: junk },
  ),
  split: fc.record({
    type: fc.constant('split'),
    dir: fc.oneof({ weight: 6, arbitrary: fc.constantFrom('row', 'col') }, { weight: 1, arbitrary: junk }),
    kids: fc.array(tie('node'), { maxLength: 4 }),
    sizes: fc.array(sizeArb, { maxLength: 5 }),
  }, { requiredKeys: ['type'] }),
}));

const seatArb = fc.dictionary(fc.constantFrom(...IDS, 'ghost'), fc.oneof(
  fc.record({ group: fc.oneof(groupIdArb, fc.constant(null)), beside: fc.oneof(idOrJunk, fc.constant(null)), side: fc.constantFrom('left', 'right', 'top', 'bottom', 'center', 'diag') }),
  junk,
));

// A stored value: usually a version-2 layout with damage in it, sometimes anything at all.
const rawArb = fc.oneof(
  { weight: 8, arbitrary: fc.record({ version: fc.constant(2), root: nodeArb, hidden: tabsArb, seat: seatArb, floats: fc.anything() }, { requiredKeys: ['version'] }) },
  { weight: 1, arbitrary: fc.anything() },
);

const sideArb = fc.constantFrom('left', 'right', 'top', 'bottom', 'center', 'diag');
// `pick` indexes the cells that exist at that moment, so most drops hit a real cell.
const opArb = fc.oneof(
  fc.record({ op: fc.constant('dock'), id: idOrJunk, kind: fc.constant('cell'), pick: fc.nat(12), side: sideArb }),
  fc.record({ op: fc.constant('dock'), id: idOrJunk, kind: fc.constant('edge'), edge: fc.constantFrom('left', 'right', 'top', 'bottom', 'mid') }),
  fc.record({ op: fc.constant('dock'), id: idOrJunk, kind: fc.constant('junk'), target: fc.oneof(junk, fc.constant({ float: { x: 1, y: 2 } })) }),
  fc.record({ op: fc.constant('hide'), id: idOrJunk }),
  fc.record({ op: fc.constant('show'), id: idOrJunk }),
  fc.record({ op: fc.constant('size'), path: fc.array(fc.nat(3), { maxLength: 4 }), sizes: fc.array(sizeArb, { maxLength: 5 }) }),
);
const opsArb = fc.array(opArb, { maxLength: 25, size: 'medium' });

const selArb = fc.oneof(
  fc.record({ active: fc.dictionary(groupIdArb.filter(x => typeof x === 'string'), idOrJunk), foldAll: fc.boolean() }),
  fc.anything(),
);
const viewportArb = fc.record({ width: fc.integer({ min: 0, max: 4000 }), height: fc.integer({ min: 0, max: 4000 }) });

// --- helpers -------------------------------------------------------------------

function step(l, o) {
  if (o.op === 'hide') return T.hide(l, o.id);
  if (o.op === 'show') return T.show(l, o.id);
  if (o.op === 'size') return T.setSplitSizes(l, o.path, o.sizes);
  if (o.kind === 'edge') return T.dock(l, o.id, { edge: o.edge });
  if (o.kind === 'junk') return T.dock(l, o.id, o.target);
  const cells = ['term', ...T.groups(l).map(gr => gr.id), 'nope'];
  return T.dock(l, o.id, { cell: cells[o.pick % cells.length], side: o.side });
}

function walk(n, fn, parent = null) {
  fn(n, parent);
  if (n.type === 'split') n.kids.forEach(k => walk(k, fn, n));
}

function assertWellFormed(l) {
  // I1: every module exactly once across the groups and hidden.
  const all = [...T.groups(l).flatMap(gr => gr.tabs), ...l.hidden];
  assert.deepStrictEqual([...all].sort(), [...IDS].sort());
  // I2: exactly one terminal.
  assert.strictEqual(T.count(l, 'term'), 1);
  // I3 / I4 and the size rule.
  const seen = new Set();
  walk(l.root, (n, parent) => {
    if (n.type === 'group') {
      assert.ok(n.tabs.length > 0, 'an empty group');
      assert.ok(typeof n.id === 'string' && n.id && !seen.has(n.id), `group id ${n.id} is not unique`);
      seen.add(n.id);
    } else if (n.type === 'split') {
      assert.ok(n.kids.length >= 2, 'a split with fewer than two children');
      assert.ok(!parent || parent.dir !== n.dir, 'a split nested in a split of its own direction');
      assert.strictEqual(n.sizes.length, n.kids.length);
      n.kids.forEach((k, i) => {
        if (T.hasTerm(k)) assert.strictEqual(n.sizes[i], 0, 'the terminal\'s side stores 0');
        else assert.ok(Number.isFinite(n.sizes[i]) && n.sizes[i] > 0 && n.sizes[i] <= 10000, `size ${n.sizes[i]}`);
      });
    }
  });
  assert.strictEqual(new Set(l.hidden).size, l.hidden.length);
  for (const id of Object.keys(l.seat)) assert.ok(l.hidden.includes(id), `a seat for ${id}, which is not hidden`);
}

function run(layout, ops) {
  let l = layout;
  for (const o of ops) {
    const next = step(l, o);
    assertWellFormed(next);
    assert.deepStrictEqual(T.normalize(next, IDS), next, `${o.op} returned a layout normalize would change`);
    l = next;
  }
  return l;
}

const overlap = (a, b) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
  && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// --- properties ----------------------------------------------------------------

test('P1: normalizing a normalized layout changes nothing', () => {
  fc.assert(fc.property(rawArb, (raw) => {
    const once = T.normalize(raw, IDS);
    assert.deepStrictEqual(T.normalize(once, IDS), once);
  }), RUNS);
});

test('P2 + P3 + P4: any stored value, then any mix of operations, stays whole (I1-I4)', () => {
  fc.assert(fc.property(rawArb, opsArb, (raw, ops) => {
    const l = T.normalize(raw, IDS);
    assertWellFormed(l);
    run(l, ops);
  }), RUNS);
});

test('P5: fit puts every box inside the window and no two of them overlap', () => {
  fc.assert(fc.property(rawArb, opsArb, selArb, viewportArb, (raw, ops, sel, vp) => {
    const f = T.fit(run(T.normalize(raw, IDS), ops), sel, vp);
    for (const b of f.boxes) {
      const r = b.rect;
      for (const v of Object.values(r)) assert.ok(Number.isInteger(v) && v >= 0, JSON.stringify(b));
      assert.ok(r.x + r.width <= vp.width && r.y + r.height <= vp.height, `${JSON.stringify(b)} leaves ${vp.width}x${vp.height}`);
    }
    f.boxes.forEach((a, i) => f.boxes.slice(i + 1).forEach(b => assert.ok(!overlap(a.rect, b.rect), `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`)));
  }), RUNS);
});

test('P6: in a window at least the terminal\'s minimum on both axes, the terminal has its minimum', () => {
  const vp = fc.record({ width: fc.integer({ min: TERM_MIN.width, max: 4000 }), height: fc.integer({ min: TERM_MIN.height, max: 4000 }) });
  fc.assert(fc.property(rawArb, opsArb, selArb, vp, (raw, ops, sel, v) => {
    const f = T.fit(run(T.normalize(raw, IDS), ops), sel, v);
    const terms = f.boxes.filter(b => b.kind === 'term');
    assert.strictEqual(terms.length, 1);
    assert.ok(terms[0].rect.width >= TERM_MIN.width && terms[0].rect.height >= TERM_MIN.height, `${JSON.stringify(terms[0].rect)} in ${v.width}x${v.height}`);
  }), RUNS);
});

test('P7: fit never changes the layout or the selection it was given', () => {
  fc.assert(fc.property(rawArb, opsArb, selArb, viewportArb, (raw, ops, sel, vp) => {
    const l = run(T.normalize(raw, IDS), ops);
    const before = JSON.stringify([l, sel]);
    T.fit(l, sel, vp);
    assert.strictEqual(JSON.stringify([l, sel]), before);
  }), RUNS);
});

test('P7b: fit of the same inputs twice gives the same answer', () => {
  fc.assert(fc.property(rawArb, selArb, viewportArb, (raw, sel, vp) => {
    const l = T.normalize(raw, IDS);
    assert.deepStrictEqual(T.fit(l, sel, vp), T.fit(l, sel, vp));
  }), RUNS);
});

test('P8: an L1 layout migrated by fromV1 draws each zone at the size L1 gave it, in a roomy window', () => {
  const sizeV1 = fc.integer({ min: 120, max: 700 });
  const v1Arb = fc.record({
    zones: fc.record({ left: tabsArb, right: tabsArb, top: tabsArb, bottom: tabsArb }, { requiredKeys: [] }),
    hidden: tabsArb,
    size: fc.record({ left: sizeV1, right: sizeV1, top: fc.integer({ min: 80, max: 400 }), bottom: fc.integer({ min: 80, max: 400 }) }),
  });
  const vp = fc.record({ width: fc.integer({ min: 640, max: 4000 }), height: fc.integer({ min: 480, max: 3000 }) });
  fc.assert(fc.property(v1Arb, vp, (raw, v) => {
    const l1 = DL.normalizeLayout(raw, IDS);
    // Every non-empty zone showing: L1 collapses a zone on purpose, the tree keeps that in the window's selection.
    for (const z of DL.ZONES) l1.active[z] = l1.zones[z].length ? l1.zones[z][0] : null;
    const want = DL.fitSizes(l1, v);
    const tree = T.fromV1(l1, IDS);
    assertWellFormed(tree);
    const f = T.fit(tree, { active: {}, foldAll: false }, v);
    const open = DL.ZONES.filter(z => l1.zones[z].length);
    // The tree spends GUTTER px per open zone on a divider, which L1 never did: only when the window has
    // room for that as well is "the same picture" the claim. Squeezed, the tree folds one zone at a time
    // (the edge first) where L1 folds an axis together, which is the design (plan Task 6).
    const w = TERM_MIN.width + GUTTER * open.filter(z => z === 'left' || z === 'right').length;
    const h = TERM_MIN.height + GUTTER * open.filter(z => z === 'top' || z === 'bottom').length;
    const roomy = v.width >= w + want.left + want.right && v.height >= h + want.top + want.bottom
      && want.left >= MIN.width && want.right >= MIN.width;
    fc.pre(roomy);
    for (const z of open) {
      const box = f.boxes.find(b => b.kind === 'group' && b.id === z);
      assert.ok(box, `${z} has no box`);
      const got = z === 'left' || z === 'right' ? box.rect.width : box.rect.height;
      assert.ok(Math.abs(got - want[z]) <= 1, `${z}: ${got} vs L1's ${want[z]}`);
    }
  }), RUNS);
});
