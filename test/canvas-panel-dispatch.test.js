'use strict';
/**
 * Claude's panel IPC with several project windows (single-instance PR 2, step 2): the panel's own page talks on canvas:fetch /
 * canvas:shelf / canvas:send / canvas:open, and the answer must come from the window that owns THAT panel, never "the" window.
 */
const test = require('node:test');
const assert = require('node:assert');
const { panelDispatch, registerCanvasIpc } = require('../app/canvas-views');
const { createProjectRegistry } = require('../app/project-registry');

function fakeViews(name, panel) {
  const calls = [];
  return {
    calls,
    isPanel: (s) => s === panel,
    fetchFor: async (s, req) => { calls.push(['fetch', s, req]); return { ok: true, from: name }; },
    shelfFor: (s) => { calls.push(['shelf', s]); return [{ url: name }]; },
    messageFrom: (s, m) => { calls.push(['send', s, m]); return true; },
    openFrom: (s, m) => { calls.push(['open', s, m]); return true; },
  };
}

function rig() {
  const panelA = { id: 1 }; const panelB = { id: 2 };
  const a = { root: 'A', canvasViews: fakeViews('A', panelA), isStrip: () => false, isTabView: () => false };
  const b = { root: 'B', canvasViews: fakeViews('B', panelB), isStrip: () => false, isTabView: () => false };
  const registry = createProjectRegistry(); registry.add(a); registry.add(b);
  return { a, b, panelA, panelB, dispatch: panelDispatch((s) => registry.panelOwner(s)) };
}

test('a panel\'s fetch, shelf read, send and open reach only the window that owns that panel', async () => {
  const { a, b, panelA, panelB, dispatch } = rig();
  assert.deepStrictEqual(await dispatch.fetchFor(panelB, { url: 'x' }), { ok: true, from: 'B' });
  assert.deepStrictEqual(dispatch.shelfFor(panelA), [{ url: 'A' }]);
  assert.strictEqual(dispatch.messageFrom(panelB, { kind: 'send', text: 't' }), true);
  assert.strictEqual(dispatch.openFrom(panelA, { url: 'u' }), true);
  assert.deepStrictEqual(a.canvasViews.calls.map((c) => c[0]), ['shelf', 'open']);
  assert.deepStrictEqual(b.canvasViews.calls.map((c) => c[0]), ['fetch', 'send']);
});

test('an unknown sender gets each method\'s own refusal and reaches no window', async () => {
  const { a, b, dispatch } = rig();
  const stranger = { id: 99 };
  assert.deepStrictEqual(await dispatch.fetchFor(stranger, {}), { ok: false, error: 'not a panel' });
  assert.deepStrictEqual(dispatch.shelfFor(stranger), []);
  assert.strictEqual(dispatch.messageFrom(stranger, {}), false);
  assert.strictEqual(dispatch.openFrom(stranger, {}), false);
  assert.strictEqual(dispatch.fetchFor === undefined, false);
  assert.deepStrictEqual([...a.canvasViews.calls, ...b.canvasViews.calls], []);
  // null / undefined senders too
  assert.deepStrictEqual(dispatch.shelfFor(null), []);
  assert.strictEqual(dispatch.messageFrom(undefined, {}), false);
});

test('registerCanvasIpc registers the four panel channels once, over the dispatch', async () => {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } };
  const { b, panelB, dispatch } = rig();
  registerCanvasIpc(ipc, dispatch);
  assert.deepStrictEqual(Object.keys(handlers).sort(), ['canvas:fetch', 'canvas:open', 'canvas:send', 'canvas:shelf']);
  assert.deepStrictEqual(await handlers['canvas:fetch']({ sender: panelB }, { url: 'x' }), { ok: true, from: 'B' });
  assert.strictEqual(b.canvasViews.calls.length, 1);
});
