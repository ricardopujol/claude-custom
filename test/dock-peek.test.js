'use strict';
/**
 * A rail's panel opening over the terminal (BACKLOG #53, dockable panels D4). A group folded to a rail (collapsed
 * on purpose, Ctrl+B, or a window too narrow for it) has no room for its panel; pressing its button opens that
 * panel as a popover next to the rail, over whatever is there, for a look or a quick use. Nothing is saved, and
 * the layout never changes: it closes on Esc, a press outside, or the rail's button again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const T = require('../app/dock-tree');
const V = require('../app/dock-tree-display');
const { TABS } = require('../app/side-tabs');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const R = (x, y, width, height) => ({ x, y, width, height });
const VP = { width: 1000, height: 600 };
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };
const overlap = (a, b) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
  && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const vRail = (rect, ...modules) => ({ kind: 'rail', dir: 'v', modules, rect });
const hRail = (rect, ...modules) => ({ kind: 'rail', dir: 'h', modules, rect });

// --- peekFor: where the popover goes -------------------------------------------------------

test('a right-hand rail opens its panel to its left, full height, 280 wide', () => {
  const p = T.peekFor([vRail(R(972, 0, 28, 600), 'agents', 'vault')], 'vault', VP);
  assert.deepEqual(p, { module: 'vault', modules: ['agents', 'vault'], dir: 'v', rect: R(692, 0, 280, 600) });
});

test('a left-hand rail opens its panel to its right', () => {
  const p = T.peekFor([vRail(R(0, 0, 28, 600), 'git')], 'git', VP);
  assert.deepEqual(p.rect, R(28, 0, 280, 600));
});

test('a rail under the terminal opens upward, 220 high; one at the top opens downward', () => {
  assert.deepEqual(T.peekFor([hRail(R(0, 570, 1000, 30), 'fog')], 'fog', VP).rect, R(0, 350, 1000, 220));
  assert.deepEqual(T.peekFor([hRail(R(0, 0, 1000, 30), 'fog')], 'fog', VP).rect, R(0, 30, 1000, 220));
});

test('a short rail inside a stack gets a popover as long as it needs, held inside the window', () => {
  // a right column's rail (180 wide): the popover is wider than the rail, and nudged back inside
  const p = T.peekFor([hRail(R(820, 100, 180, 30), 'git')], 'git', VP);
  assert.ok(p.rect.x + p.rect.width <= 1000 && p.rect.x >= 0);
  assert.ok(p.rect.width >= 180);
  assert.equal(p.rect.y + p.rect.height <= 600, true);
});

test('no rail holds the module, or the window is junk: no popover', () => {
  const rails = [vRail(R(972, 0, 28, 600), 'agents')];
  assert.equal(T.peekFor(rails, 'git', VP), null);
  assert.equal(T.peekFor(rails, 'agents', null), null);
  assert.equal(T.peekFor(rails, 'agents', { width: 0, height: 0 }), null);
  assert.equal(T.peekFor([vRail(R(0, 0, 28, 600), 'agents')], 'agents', { width: 28, height: 600 }), null, 'a window that is all rail has no room beside it');
  assert.equal(T.peekFor(rails, 7, VP), null);
  assert.equal(T.peekFor('rails', 'agents', VP), null);
  assert.equal(T.peekFor([null, 3, { kind: 'rail' }], 'agents', VP), null);
});

test('a window too small for 280 gives the popover what is left beside the rail', () => {
  const p = T.peekFor([vRail(R(172, 0, 28, 300), 'git')], 'git', { width: 200, height: 300 });
  assert.deepEqual(p.rect, R(0, 0, 172, 300));
});

test('peekFor reads rails out of fit: a collapsed group beside the terminal', () => {
  const l = T.defaultLayout(IDS);
  const f = T.fit(l, { collapsed: { right: true } }, VP);
  const p = T.peekFor(f.boxes, 'vault', VP);
  assert.equal(p.dir, 'v');
  assert.deepEqual(p.modules, IDS.filter(id => id !== 'canvas'));
});

// --- the rule it must keep ------------------------------------------------------------------

test('P1: the popover is whole inside the window, never over its own rail, and sized in whole pixels', () => {
  const railArb = fc.oneof(
    fc.record({ dir: fc.constant('v'), x: fc.integer({ min: 0, max: 3000 }), y: fc.integer({ min: 0, max: 2000 }), width: fc.constant(28), height: fc.integer({ min: 1, max: 2000 }) }),
    fc.record({ dir: fc.constant('h'), x: fc.integer({ min: 0, max: 3000 }), y: fc.integer({ min: 0, max: 2000 }), width: fc.integer({ min: 1, max: 3000 }), height: fc.constant(30) }),
  );
  const vp = fc.record({ width: fc.integer({ min: 1, max: 4000 }), height: fc.integer({ min: 1, max: 3000 }) });
  fc.assert(fc.property(railArb, vp, (r, v) => {
    // A rail drawn by fit lies inside its window.
    fc.pre(r.x + r.width <= v.width && r.y + r.height <= v.height);
    const rect = R(r.x, r.y, r.width, r.height);
    const p = T.peekFor([{ kind: 'rail', dir: r.dir, modules: ['git'], rect }], 'git', v);
    if (p === null) return;
    for (const k of Object.values(p.rect)) assert.ok(Number.isInteger(k) && k >= 0, JSON.stringify(p.rect));
    assert.ok(p.rect.width > 0 && p.rect.height > 0);
    assert.ok(p.rect.x + p.rect.width <= v.width && p.rect.y + p.rect.height <= v.height, `${JSON.stringify(p.rect)} leaves ${v.width}x${v.height}`);
    assert.ok(!overlap(p.rect, rect), `${JSON.stringify(p.rect)} covers its rail ${JSON.stringify(rect)}`);
  }), RUNS);
});

// --- peekAfter: what ends it (the page keeps only { module } or null) -----------------------

const A = V.peekAfter;

test('pressing a rail\'s button opens that module; pressing it again closes', () => {
  assert.deepEqual(A(null, { type: 'rail', module: 'git' }), { module: 'git' });
  assert.equal(A({ module: 'git' }, { type: 'rail', module: 'git' }), null);
});

test('pressing another rail\'s button moves the popover there', () => {
  assert.deepEqual(A({ module: 'git' }, { type: 'rail', module: 'fog' }), { module: 'fog' });
});

test('a tab inside the popover switches it; with none open there is nothing to switch', () => {
  assert.deepEqual(A({ module: 'git' }, { type: 'tab', module: 'fog' }), { module: 'fog' });
  assert.equal(A(null, { type: 'tab', module: 'fog' }), null);
});

test('Esc, a press outside, a drop and a layout that lost the rail all close it', () => {
  for (const type of ['escape', 'outside', 'drop', 'gone']) assert.equal(A({ module: 'git' }, { type }), null, type);
});

test('junk in changes nothing it can\'t explain', () => {
  assert.deepEqual(A({ module: 'git' }, null), { module: 'git' });
  assert.deepEqual(A({ module: 'git' }, { type: 'wave' }), { module: 'git' });
  assert.equal(A({ module: 7 }, { type: 'rail', module: 7 }), null, 'a state that is not a module is no popover');
  assert.equal(A(null, { type: 'rail', module: 7 }), null);
  assert.equal(A('git', { type: 'escape' }), null);
});

// --- treePlan carries it ---------------------------------------------------------------------

const plan = (layout, sel, peek) => V.treePlan(layout, sel, TABS, VP, { faceSize: () => 77, peek });

test('treePlan draws the popover of a rail with its tabs, the chosen one on, and counts its panel as shown', () => {
  const sel = { collapsed: { right: true } };
  const p = plan(T.defaultLayout(TABS.map(t => t.id)), sel, { module: 'vault' });
  assert.equal(p.peek.module, 'vault');
  assert.equal(p.peek.rect.width, 280);
  assert.deepEqual(p.peek.tabs.filter(t => t.on).map(t => t.id), ['vault']);
  assert.ok(p.peek.tabs.length > 1);
  assert.ok(p.shown.includes('vault'), 'the vault rule needs to see it on screen');
  assert.equal(p.peek.tabs.find(t => t.id === 'vault').label, TABS.find(t => t.id === 'vault').label);
});

test('treePlan has no popover when the module is not on a rail (the group is open, or it is gone)', () => {
  const p = plan(T.defaultLayout(TABS.map(t => t.id)), {}, { module: 'vault' });
  assert.equal(p.peek, null);
  assert.ok(!p.shown.includes('vault'));
  assert.equal(plan(T.defaultLayout(TABS.map(t => t.id)), { collapsed: { right: true } }, null).peek, null);
  assert.equal(plan(T.defaultLayout(TABS.map(t => t.id)), { collapsed: { right: true } }, undefined).peek, null);
});

test('treePlan: the module the popover shows is not also shown by another group', () => {
  const p = plan(T.defaultLayout(TABS.map(t => t.id)), { collapsed: { right: true } }, { module: 'git' });
  assert.equal(p.shown.filter(id => id === 'git').length, 1);
});
