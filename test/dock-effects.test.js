'use strict';
/**
 * What a redraw may do besides drawing, and the page's focus rules (layout pass L1, PR #82; backlog #36): the
 * tested half of app/dock-effects.js (these rules lived in app/dock-zones-display.js until dockable panels D4).
 */
const test = require('node:test');
const assert = require('node:assert');

const { renderEffects, describeFocus, focusOnOpen, overrideOnHello, WIDE_FACE_CHROME } = require('../app/dock-effects');

test('the wide-group portrait chrome is the card name line plus the tab bar', () => {
  assert.strictEqual(WIDE_FACE_CHROME, 60);
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
