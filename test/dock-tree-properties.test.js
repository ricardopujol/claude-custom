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

// A float as a damaged file might hold it: any field may be missing or wrong, positions and sizes included.
const floatArb = fc.oneof(
  { weight: 6, arbitrary: fc.record({ id: groupIdArb, tabs: tabsArb, x: sizeArb, y: sizeArb, w: sizeArb, h: sizeArb }, { requiredKeys: ['tabs'] }) },
  { weight: 1, arbitrary: junk },
);
const floatsArb = fc.oneof({ weight: 6, arbitrary: fc.array(floatArb, { maxLength: 4 }) }, { weight: 1, arbitrary: fc.anything() });

// A stored value: usually a version-2 layout with damage in it, sometimes anything at all.
const rawArb = fc.oneof(
  { weight: 8, arbitrary: fc.record({ version: fc.constant(2), root: nodeArb, hidden: tabsArb, seat: seatArb, floats: floatsArb }, { requiredKeys: ['version'] }) },
  { weight: 1, arbitrary: fc.anything() },
);

const sideArb = fc.constantFrom('left', 'right', 'top', 'bottom', 'center', 'diag');
// `pick` indexes the cells that exist at that moment, so most drops hit a real cell.
const opArb = fc.oneof(
  fc.record({ op: fc.constant('dock'), id: idOrJunk, kind: fc.constant('cell'), pick: fc.nat(12), side: sideArb }),
  fc.record({ op: fc.constant('dock'), id: idOrJunk, kind: fc.constant('edge'), edge: fc.constantFrom('left', 'right', 'top', 'bottom', 'mid') }),
  fc.record({ op: fc.constant('dock'), id: idOrJunk, kind: fc.constant('junk'), target: fc.oneof(junk, fc.constant({ float: { x: 1, y: 2 } })) }),
  // D2: floating, and the float's own moves. `pick` indexes the floats that exist at that moment.
  fc.record({ op: fc.constant('float'), id: idOrJunk, spot: fc.oneof(fc.constant(true), fc.record({ x: sizeArb, y: sizeArb, w: sizeArb, h: sizeArb }, { requiredKeys: [] }), junk) }),
  fc.record({ op: fc.constant('move'), pick: fc.nat(6), x: sizeArb, y: sizeArb, vp: fc.option(fc.record({ width: fc.integer({ min: 0, max: 3000 }), height: fc.integer({ min: 0, max: 3000 }) })) }),
  fc.record({ op: fc.constant('resize'), pick: fc.nat(6), w: sizeArb, h: sizeArb, vp: fc.option(fc.record({ width: fc.integer({ min: 0, max: 3000 }), height: fc.integer({ min: 0, max: 3000 }) })) }),
  fc.record({ op: fc.constant('hide'), id: idOrJunk }),
  fc.record({ op: fc.constant('show'), id: idOrJunk }),
  fc.record({ op: fc.constant('size'), path: fc.array(fc.nat(3), { maxLength: 4 }), sizes: fc.array(sizeArb, { maxLength: 5 }) }),
);
const opsArb = fc.array(opArb, { maxLength: 25, size: 'medium' });

const selArb = fc.oneof(
  fc.record({ active: fc.dictionary(groupIdArb.filter(x => typeof x === 'string'), idOrJunk), foldAll: fc.boolean(), floatOrder: fc.array(groupIdArb, { maxLength: 6 }) }),
  fc.anything(),
);
const viewportArb = fc.record({ width: fc.integer({ min: 0, max: 4000 }), height: fc.integer({ min: 0, max: 4000 }) });

// --- helpers -------------------------------------------------------------------

function step(l, o) {
  if (o.op === 'hide') return T.hide(l, o.id);
  if (o.op === 'show') return T.show(l, o.id);
  if (o.op === 'size') return T.setSplitSizes(l, o.path, o.sizes);
  if (o.op === 'float') return T.dock(l, o.id, { float: o.spot });
  if (o.op === 'move' || o.op === 'resize') {
    const fid = l.floats.length ? l.floats[o.pick % l.floats.length].id : 'nope';
    return o.op === 'move' ? T.moveFloat(l, fid, { x: o.x, y: o.y }, o.vp || undefined) : T.resizeFloat(l, fid, { w: o.w, h: o.h }, o.vp || undefined);
  }
  if (o.kind === 'edge') return T.dock(l, o.id, { edge: o.edge });
  if (o.kind === 'junk') return T.dock(l, o.id, o.target);
  const cells = ['term', ...T.allGroups(l).map(gr => gr.id), 'nope'];
  return T.dock(l, o.id, { cell: cells[o.pick % cells.length], side: o.side });
}

function walk(n, fn, parent = null) {
  fn(n, parent);
  if (n.type === 'split') n.kids.forEach(k => walk(k, fn, n));
}

function assertWellFormed(l) {
  // I1: every module exactly once across the groups, the floats and hidden.
  const all = [...T.groups(l).flatMap(gr => gr.tabs), ...l.floats.flatMap(f => f.tabs), ...l.hidden];
  assert.deepStrictEqual([...all].sort(), [...IDS].sort());
  // D2: a float is a group that isn't in the tree: it has tabs, a name from the group namespace, and sane numbers.
  for (const f of l.floats) {
    assert.ok(f.tabs.length > 0, 'an empty float');
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(f[k]), `float ${k} ${f[k]}`);
    assert.ok(f.x >= 0 && f.y >= 0 && f.x <= 10000 && f.y <= 10000, `float at ${f.x}, ${f.y}`);
    assert.ok(f.w >= T.FLOAT_MIN.width && f.h >= T.FLOAT_MIN.height && f.w <= 10000 && f.h <= 10000, `float ${f.w} x ${f.h}`);
  }
  const names = [...T.groups(l).map(gr => gr.id), ...l.floats.map(f => f.id)];
  assert.strictEqual(new Set(names).size, names.length, `a group or float name is used twice: ${names}`);
  assert.ok(names.every(n => typeof n === 'string' && n && n !== 'term'), `a bad name in ${names}`);
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
  // PR #100 F2: a seat names a group that exists, never one that was destroyed (its name may have been reused).
  const live = new Set(names);
  for (const [id, s] of Object.entries(l.seat)) {
    assert.ok(s.group === null || live.has(s.group), `${id}'s seat names ${s.group}, which is not a group`);
    if (s.float !== undefined) for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(s.float[k]), `${id}'s seat float ${k}`);
  }
  assert.ok(!T.groups(l).some(gr => gr.id === 'term'), 'a group named like the terminal');
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
    // A float hangs over the tree on purpose: only the tree's own boxes are disjoint.
    const tree = f.boxes.filter(b => b.kind !== 'float');
    tree.forEach((a, i) => tree.slice(i + 1).forEach(b => assert.ok(!overlap(a.rect, b.rect), `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`)));
  }), RUNS);
});

test('P5b (D2): every float is drawn whole inside the window, whatever size the window is; Ctrl+B draws none', () => {
  fc.assert(fc.property(rawArb, opsArb, selArb, viewportArb, (raw, ops, sel, vp) => {
    const l = run(T.normalize(raw, IDS), ops);
    const floats = T.fit(l, sel, vp).boxes.filter(b => b.kind === 'float');
    const folded = T.cleanSelection(sel).foldAll;
    assert.strictEqual(floats.length, folded ? 0 : l.floats.length);
    for (const b of floats) {
      const r = b.rect;
      for (const v of Object.values(r)) assert.ok(Number.isInteger(v) && v >= 0, JSON.stringify(b));
      assert.ok(r.x + r.width <= vp.width && r.y + r.height <= vp.height, `${JSON.stringify(b)} leaves ${vp.width}x${vp.height}`);
      assert.ok(b.tabs.includes(b.active), 'a float shows one of its own tabs');
    }
  }), RUNS);
});

test('P10 (D2): floats never change the terminal or any other box: fit of the layout with and without its floats agrees', () => {
  fc.assert(fc.property(rawArb, opsArb, selArb, viewportArb, (raw, ops, sel, vp) => {
    const l = run(T.normalize(raw, IDS), ops);
    const treeOf = fit => fit.boxes.filter(b => b.kind !== 'float');
    assert.deepStrictEqual(treeOf(T.fit(l, sel, vp)), treeOf(T.fit({ ...l, floats: [] }, sel, vp)));
    assert.deepStrictEqual(T.fit(l, sel, vp).splits, T.fit({ ...l, floats: [] }, sel, vp).splits);
  }), RUNS);
});

test('P11 (D2): a float moved or resized with the window\'s size is drawn where it was put, at the size it was given', () => {
  const vpArb = fc.record({ width: fc.integer({ min: 200, max: 3000 }), height: fc.integer({ min: 150, max: 3000 }) });
  fc.assert(fc.property(rawArb, opsArb, fc.nat(6), sizeArb, sizeArb, sizeArb, sizeArb, vpArb, (raw, ops, pick, x, y, w, h, vp) => {
    const l = run(T.normalize(raw, IDS), ops);
    fc.pre(l.floats.length > 0);
    const id = l.floats[pick % l.floats.length].id;
    const drawn = lay => T.fit(lay, null, vp).boxes.find(b => b.kind === 'float' && b.id === id).rect;
    const moved = T.moveFloat(l, id, { x, y }, vp);
    assertWellFormed(moved);
    const before = drawn(l);
    const after = drawn(moved);
    // What the move stored is what `fit` draws: the model's clamp and fit's clamp agree (no drift on the next redraw).
    const stored = moved.floats.find(f => f.id === id);
    if (Number.isFinite(x) && Number.isFinite(y)) assert.deepStrictEqual([after.x, after.y], [stored.x, stored.y]);
    assert.strictEqual(after.width, before.width);
    const sized = T.resizeFloat(moved, id, { w, h }, vp);
    assertWellFormed(sized);
    const grown = drawn(sized);
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
      // Never past the window's edge unless the minimum forces it, and never moved by a resize.
      assert.ok(grown.x + grown.width <= vp.width && grown.y + grown.height <= vp.height, `${JSON.stringify(grown)} in ${vp.width}x${vp.height}`);
      assert.deepStrictEqual([grown.x, grown.y], [after.x, after.y]);
    }
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

// What a tree looks like with group names and sizes set aside.
const shapeOf = (n) => {
  if (n.type === 'term') return 'T';
  if (n.type === 'group') return `[${n.tabs.join(',')}]`;
  return `${n.dir}(${n.kids.map(shapeOf).join(' ')})`;
};

test('P9 (PR #100 F1): dropping a lone panel on any target either returns the same layout or changes its shape', () => {
  const targetArb = fc.oneof(
    fc.record({ edge: fc.constantFrom('left', 'right', 'top', 'bottom') }),
    fc.record({ pick: fc.nat(12), side: fc.constantFrom('left', 'right', 'top', 'bottom', 'center') }),
  );
  fc.assert(fc.property(rawArb, opsArb, fc.nat(12), targetArb, (raw, ops, which, t) => {
    const l = run(T.normalize(raw, IDS), ops);
    const lone = T.groups(l).filter(gr => gr.tabs.length === 1);
    fc.pre(lone.length > 0);
    const id = lone[which % lone.length].tabs[0];
    const cells = ['term', ...T.allGroups(l).map(gr => gr.id)];
    const target = t.edge ? { edge: t.edge } : { cell: cells[t.pick % cells.length], side: t.side };
    const next = T.dock(l, id, target);
    assertWellFormed(next);
    assert.ok(next === l || shapeOf(next.root) !== shapeOf(l.root), `${JSON.stringify(target)} rebuilt the same picture as a new layout`);
  }), RUNS);
});

test('P12 (PR #102 Dexter 1): the Window menu has one row per known module, whatever mix of docked, floating and hidden', () => {
  const V = require('../app/dock-tree-display');
  const TABS = IDS.map(id => ({ id, label: id, title: id }));
  fc.assert(fc.property(rawArb, opsArb, (raw, ops) => {
    const l = run(T.normalize(raw, IDS), ops);
    const rows = V.menuRows(l, TABS);
    assert.deepStrictEqual(rows.map(r => r.id), IDS);
    for (const r of rows) assert.strictEqual(r.shown, !l.hidden.includes(r.id), `${r.id} shown ${r.shown}`);
  }), RUNS);
});
