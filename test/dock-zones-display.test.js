'use strict';
/**
 * What the page draws for a layout (layout pass L1, Task 5): the pure half of
 * app/dock-zones-display.js. The DOM half (applyPlan) only copies this onto
 * elements; verify/probe-dock-zones.js measures the result in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');

const { zonePlan, dragSize, layoutRows, moveTargets, renderEffects, describeFocus, focusOnOpen, afterLayoutGet, overrideOnHello } = require('../app/dock-zones-display');
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

const H = (over = {}) => ({ tag: 'INPUT', type: 'password', isTerminal: false, visible: true, connected: true, ...over });

test('THE REGRESSION (#36): a reconnect never takes focus from a field the user is typing in', () => {
  // ws.onopen focused the terminal every time: a drop while a secret was
  // half-typed in #vault-secret sent the rest of it into the session.
  for (const type of ['password', 'text', 'search', 'checkbox']) {
    assert.strictEqual(focusOnOpen(false, H({ type })), false, type);
  }
  assert.strictEqual(focusOnOpen(false, H({ tag: 'TEXTAREA', type: 'textarea' })), false);
  assert.strictEqual(focusOnOpen(false, H({ tag: 'SELECT', type: 'select-one' })), false);
  assert.strictEqual(focusOnOpen(false, H({ tag: 'DIV', type: null })), false, 'contenteditable');
});

test('a BUTTON in the vault form on reconnect holds focus (Tab onto Show, then Shift+Tab, must not reach the session)', () => {
  assert.strictEqual(focusOnOpen(false, H({ tag: 'BUTTON', type: 'button' })), false);
});

test('vault shown at load: the FIRST open focuses the terminal even though #vault-search holds focus', () => {
  // The layout restored at load focuses the vault's search before the socket
  // opens; "first" is a flag, never read from what has focus.
  assert.strictEqual(focusOnOpen(true, H({ type: 'search' })), true);
  assert.strictEqual(focusOnOpen(true, H({ tag: 'BUTTON', type: 'button' })), true);
});

test('a hidden or detached focused element on reconnect gives the terminal the keyboard', () => {
  assert.strictEqual(focusOnOpen(false, H({ visible: false })), true, 'hidden');
  assert.strictEqual(focusOnOpen(false, H({ connected: false })), true, 'detached');
});

test('nothing, body, or the terminal textarea on reconnect: the terminal takes focus', () => {
  assert.strictEqual(focusOnOpen(false, null), true);
  assert.strictEqual(focusOnOpen(false, undefined), true);
  assert.strictEqual(focusOnOpen(false, H({ tag: 'BODY', type: null })), true);
  assert.strictEqual(focusOnOpen(false, H({ tag: 'HTML', type: null })), true);
  assert.strictEqual(focusOnOpen(false, H({ tag: 'TEXTAREA', type: 'textarea', isTerminal: true })), true);
});

test('describeFocus reads an element into the descriptor focusOnOpen decides on', () => {
  const inside = { tagName: 'TEXTAREA', type: 'textarea', isConnected: true, getClientRects: () => [1] };
  const termEl = { contains: (e) => e === inside };
  const field = { tagName: 'INPUT', type: 'password', isConnected: true, getClientRects: () => [1] };
  const hidden = { tagName: 'INPUT', type: 'text', isConnected: true, getClientRects: () => [] };
  const gone = { tagName: 'INPUT', type: 'text', isConnected: false, getClientRects: () => [] };
  const div = { tagName: 'DIV', isConnected: true, getClientRects: () => [1] };
  assert.strictEqual(describeFocus(null, termEl), null);
  assert.deepStrictEqual(describeFocus(inside, termEl), { tag: 'TEXTAREA', type: 'textarea', isTerminal: true, visible: true, connected: true });
  assert.deepStrictEqual(describeFocus(field, termEl), { tag: 'INPUT', type: 'password', isTerminal: false, visible: true, connected: true });
  assert.strictEqual(describeFocus(hidden, termEl).visible, false);
  assert.strictEqual(describeFocus(gone, termEl).connected, false);
  assert.strictEqual(describeFocus(div, termEl).type, null);
  assert.strictEqual(describeFocus(field, null).isTerminal, false, 'no terminal yet');
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

// --- lean mode (#62, PR #140 Dexter F1): a remount that is not the person opening the vault takes no focus ---------------

test('renderEffects: quiet (lean mode putting the panels back) never moves the focus to the vault; what left is still reported', () => {
  const none = new Set();
  const withVault = new Set(['vault', 'git']);
  assert.strictEqual(renderEffects(none, withVault, { userAction: false }).focus, 'vault', 'a person opening the vault still takes it');
  const quiet = renderEffects(none, withVault, { userAction: false, quiet: true });
  assert.strictEqual(quiet.focus, null);
  assert.deepStrictEqual(quiet.newlyShown.sort(), ['git', 'vault'], 'the panels still load');
  assert.strictEqual(renderEffects(withVault, none, { quiet: true }).vaultLeft, true, 'its secrets still go out of sight');
});
