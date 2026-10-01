'use strict';
/**
 * What the page draws for a layout (layout pass L1, Task 5): the pure half of
 * app/dock-zones-display.js. The DOM half (applyPlan) only copies this onto
 * elements; verify/probe-dock-zones.js measures the result in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');

const { zonePlan, dragSize, layoutRows, moveTargets } = require('../app/dock-zones-display');
const { defaultLayout, moveModule, selectModule, MIN, RAIL } = require('../app/dock-layout');
const { TABS } = require('../app/side-tabs');
const { faceSize } = require('../app/roster-width');

const IDS = TABS.map(t => t.id);
const VP = { width: 1200, height: 800 };
const plan = (layout, vp = VP) => zonePlan(layout, TABS, vp, { faceSize });

test('the default layout draws today\'s window: one right zone, seven tabs, Agents on, 180 wide', () => {
  const p = plan(defaultLayout(IDS));
  const r = p.zones.right;
  assert.strictEqual(r.empty, false);
  assert.strictEqual(r.collapsed, false);
  assert.strictEqual(r.shape, 'tall');
  assert.strictEqual(r.size, 180);
  assert.strictEqual(r.panel, 'agents');
  assert.deepStrictEqual(r.tabs.map(t => t.id), IDS);
  assert.deepStrictEqual(r.tabs.filter(t => t.on).map(t => t.id), ['agents']);
  assert.deepStrictEqual(r.tabs[1], { id: 'vault', label: 'Vault', title: 'Local encrypted secrets', on: false });
  for (const z of ['left', 'top', 'bottom']) {
    assert.strictEqual(p.zones[z].empty, true, z);
    assert.strictEqual(p.zones[z].size, 0, z);
    assert.strictEqual(p.zones[z].panel, null, z);
  }
  assert.deepStrictEqual(p.shown, ['agents']);
  assert.strictEqual(p.face, faceSize(180));
});

test('a collapsed zone keeps its tabs and shows no panel', () => {
  const p = plan(selectModule(defaultLayout(IDS), 'agents'));
  assert.strictEqual(p.zones.right.collapsed, true);
  assert.strictEqual(p.zones.right.panel, null);
  assert.strictEqual(p.zones.right.size, RAIL.side);
  assert.strictEqual(p.zones.right.tabs.length, IDS.length);
  assert.deepStrictEqual(p.shown, []);
});

test('top and bottom zones are wide; every zone that shows a module lists it in shown', () => {
  const l = moveModule(moveModule(defaultLayout(IDS), 'vault', 'top'), 'fog', 'left');
  const p = plan(l);
  assert.strictEqual(p.zones.top.shape, 'wide');
  assert.strictEqual(p.zones.top.panel, 'vault');
  assert.strictEqual(p.zones.left.shape, 'tall');
  assert.deepStrictEqual([...p.shown].sort(), ['agents', 'fog', 'vault']);
});

test('hidden modules get no tab anywhere', () => {
  const p = plan(moveModule(defaultLayout(IDS), 'style', 'hide'));
  for (const z of Object.values(p.zones)) assert.ok(!z.tabs.some(t => t.id === 'style'));
});

test('portraits follow the Agents zone: its width when tall, its height when wide', () => {
  const tall = plan(defaultLayout(IDS));
  assert.strictEqual(tall.face, faceSize(180));
  const wide = plan(moveModule(defaultLayout(IDS), 'agents', 'bottom'));
  assert.strictEqual(wide.face, Math.max(28, Math.min(150, wide.zones.bottom.size - 60)));
});

test('with Agents not showing, the portrait size is left alone (null)', () => {
  assert.strictEqual(plan(selectModule(defaultLayout(IDS), 'vault')).face, null);
});

test('the sizes are the fitted ones, not the stored ones', () => {
  const l = { ...defaultLayout(IDS), size: { left: 180, right: 5000, top: 160, bottom: 160 } };
  assert.strictEqual(plan(l).zones.right.size, VP.width - 320);
});

// --- dragSize: the size under the pointer while a grip is dragged -------------

const RECT = { left: 100, right: 1100, top: 50, bottom: 750 };

test('each zone is measured from its own anchored edge', () => {
  assert.strictEqual(dragSize('right', { x: 900, y: 0 }, RECT), 200);
  assert.strictEqual(dragSize('left', { x: 340, y: 0 }, RECT), 240);
  assert.strictEqual(dragSize('top', { x: 0, y: 250 }, RECT), 200);
  assert.strictEqual(dragSize('bottom', { x: 0, y: 600 }, RECT), 150);
});

test('a pointer past the anchored edge or a junk point gives null, not a negative size', () => {
  assert.strictEqual(dragSize('right', { x: 1200, y: 0 }, RECT), null);
  assert.strictEqual(dragSize('left', { x: NaN, y: 0 }, RECT), null);
  assert.strictEqual(dragSize('middle', { x: 500, y: 500 }, RECT), null);
  assert.strictEqual(dragSize('top', { x: 0, y: 10 }, null), null);
});

test('MIN is respected later by setSize, so dragSize may answer below it', () => {
  assert.ok(dragSize('right', { x: 1090, y: 0 }, RECT) < MIN.side);
});

// --- the layout menu and the right-click menu (Task 7) ------------------------

test('the layout menu lists every module with where it is, hidden ones included', () => {
  const l = moveModule(moveModule(defaultLayout(IDS), 'vault', 'left'), 'style', 'hide');
  const rows = layoutRows(l, TABS);
  assert.deepStrictEqual(rows.map(r => r.id), IDS);           // TABS order, stable
  assert.deepStrictEqual(rows.find(r => r.id === 'vault'), { id: 'vault', label: 'Vault', at: 'left' });
  assert.strictEqual(rows.find(r => r.id === 'style').at, 'hidden');
  assert.strictEqual(rows.find(r => r.id === 'agents').at, 'right');
});

test('the right-click menu offers every zone and Hide, except where the module already is', () => {
  const t = moveTargets(defaultLayout(IDS), 'vault');
  assert.deepStrictEqual(t.map(x => x.target), ['left', 'right', 'top', 'bottom', 'hide']);
  assert.deepStrictEqual(t.map(x => x.label), ['Left', 'Right', 'Top', 'Bottom', 'Hide']);
  assert.deepStrictEqual(t.filter(x => !x.enabled).map(x => x.target), ['right']);
  const hidden = moveTargets(moveModule(defaultLayout(IDS), 'vault', 'hide'), 'vault');
  assert.deepStrictEqual(hidden.filter(x => !x.enabled).map(x => x.target), ['hide']);
});

test('an unknown module has nowhere to go', () => {
  assert.deepStrictEqual(moveTargets(defaultLayout(IDS), 'ghost'), []);
});
