'use strict';
/**
 * What the page draws for a layout (layout pass L1, Task 5): the pure half of
 * app/dock-zones-display.js. The DOM half (applyPlan) only copies this onto
 * elements; verify/probe-dock-zones.js measures the result in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');

const { zonePlan, dragSize, layoutRows, moveTargets, renderEffects, focusOnOpen, afterLayoutGet, overrideOnHello } = require('../app/dock-zones-display');
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

// --- what a redraw may do (PR #82 Dexter F2, Miguel B1) ------------------------

const S = (...ids) => new Set(ids);

test('THE REGRESSION: a redraw with the vault still showing never moves the keyboard focus', () => {
  // A resize, a grip drag, a layout pushed from another window or a hello
  // redraws. Moving focus to the terminal mid-secret typed the rest of the
  // secret into the session.
  const e = renderEffects(S('vault', 'agents'), S('vault', 'agents'));
  assert.strictEqual(e.focus, null);
  assert.deepStrictEqual(e.newlyShown, []);
  assert.strictEqual(e.vaultLeft, false);
});

test('a redraw that changes nothing the user is looking at leaves focus alone', () => {
  assert.strictEqual(renderEffects(S('agents'), S('agents')).focus, null);
  assert.strictEqual(renderEffects(S('agents'), S('agents', 'fog')).focus, null);
});

test('opening the vault focuses its search; leaving it sends focus back to the terminal', () => {
  const opened = renderEffects(S('agents'), S('vault'));
  assert.strictEqual(opened.focus, 'vault');
  assert.deepStrictEqual(opened.newlyShown, ['vault']);
  const left = renderEffects(S('vault'), S('agents'));
  assert.strictEqual(left.focus, 'term');
  assert.strictEqual(left.vaultLeft, true);
  assert.deepStrictEqual(left.newlyShown, ['agents']);
});

// --- the socket opening (backlog #36) ------------------------------------------

test('THE REGRESSION (#36): a reconnect never takes focus from a field the user is typing in', () => {
  // ws.onopen focused the terminal every time: a drop while a secret was
  // half-typed in #vault-secret sent the rest of it into the session.
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.strictEqual(focusOnOpen({ tag, inTerm: false }), false, tag);
  }
  assert.strictEqual(focusOnOpen({ tag: 'DIV', editable: true, inTerm: false }), false, 'contenteditable');
});

test('the first open, with nothing focused, still focuses the terminal', () => {
  assert.strictEqual(focusOnOpen(null), true, 'no active element');
  assert.strictEqual(focusOnOpen({ tag: 'BODY', inTerm: false }), true);
  assert.strictEqual(focusOnOpen({ tag: 'HTML', inTerm: false }), true);
  assert.strictEqual(focusOnOpen(undefined), true);
});

test('focus already in the terminal's own textarea counts as the terminal, and a button holds nothing', () => {
  assert.strictEqual(focusOnOpen({ tag: 'TEXTAREA', inTerm: true }), true);
  assert.strictEqual(focusOnOpen({ tag: 'BUTTON', inTerm: false }), true);
});

// --- reading the stored layout (PR #82 Dexter F3, Miguel I1) -------------------

test('only a MISSING store file means "migrate"; unreadable or corrupt never overwrites it', () => {
  assert.strictEqual(afterLayoutGet({ status: 'ok', layout: { version: 1 } }), 'use');
  assert.strictEqual(afterLayoutGet({ status: 'missing', layout: null }), 'migrate');
  for (const st of ['unreadable', 'corrupt', 'whatever']) {
    assert.strictEqual(afterLayoutGet({ status: st, layout: null }), 'keep', st);
  }
  assert.strictEqual(afterLayoutGet({ status: 'ok', layout: [] }), 'keep', 'ok but not a layout object');
  for (const bad of [null, undefined, 'x', 7]) assert.strictEqual(afterLayoutGet(bad), 'keep', String(bad));
});

// --- a tab's own layout changed while the socket was down (Dexter F8) ---------

test('with nothing pending, the host\'s word is applied', () => {
  assert.deepStrictEqual(overrideOnHello(null, { version: 1 }), { apply: { version: 1 }, resend: false, settled: false });
  assert.deepStrictEqual(overrideOnHello(null, null), { apply: null, resend: false, settled: false });
});

test('a change the host has not heard yet wins over the hello that carries the old value, and is sent again', () => {
  const pending = { layout: { version: 1, zones: { left: ['fog'] } } };
  assert.deepStrictEqual(overrideOnHello(pending, null), { apply: pending.layout, resend: true, settled: false });
  const reset = { layout: null };   // Reset to global, made offline
  assert.deepStrictEqual(overrideOnHello(reset, { version: 1 }), { apply: null, resend: true, settled: false });
});

test('the host echoing the pending change settles it', () => {
  const pending = { layout: { version: 1 } };
  assert.deepStrictEqual(overrideOnHello(pending, { version: 1 }), { apply: { version: 1 }, resend: false, settled: true });
  assert.deepStrictEqual(overrideOnHello({ layout: null }, null), { apply: null, resend: false, settled: true });
});

test('after the user\'s own click or key, focus returns to the terminal -- unless the vault is showing', () => {
  // A tab click left focus on the clicked button, so the next keystroke went
  // nowhere useful; the old setTab focused the terminal after every click.
  assert.strictEqual(renderEffects(S('agents'), S('fog'), { userAction: true }).focus, 'term');
  assert.strictEqual(renderEffects(S('agents'), S('agents'), { userAction: true }).focus, 'term');
  assert.strictEqual(renderEffects(S('vault'), S('vault', 'fog'), { userAction: true }).focus, null);
  assert.strictEqual(renderEffects(S('agents'), S('fog'), { userAction: false }).focus, null);
});

test('Dexter F7: a zone squeezed below its minimum is drawn as its rail, panel hidden, selection kept', () => {
  const l = defaultLayout(IDS);                           // Agents showing on the right
  const p = zonePlan(l, TABS, { width: 400, height: 800 }, { faceSize });   // 80 px for the zone: < 120
  assert.strictEqual(p.zones.right.collapsed, true);
  assert.strictEqual(p.zones.right.panel, null);
  assert.strictEqual(p.zones.right.size, RAIL.side);
  assert.deepStrictEqual(p.shown, []);
  assert.strictEqual(p.zones.right.tabs.find(t => t.id === 'agents').on, true, 'still the selected tab');
  assert.strictEqual(l.active.right, 'agents', 'the layout itself is untouched');
});
