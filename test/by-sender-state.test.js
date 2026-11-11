'use strict';
/**
 * State that main keeps per SENDER, not per "the" window (single-instance PR 2, step 3): pushes (P4), toast clicks (P6), the ▾ menu's
 * busy flag (P7), the avatar picker's parent, and the clipboard / favourites bridges with no `win`.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createPushers } = require('../app/push-targets');
const { createBusyGate } = require('../app/busy-gate');
const { clickFor, createToastHolder } = require('../app/toast-holder');
const { createProjectRegistry } = require('../app/project-registry');
const { registerAvatarHandlers, PICK_CHANNEL } = require('../app/avatar-bridge');
const { registerClipboardHandlers, CLIPBOARD_READ } = require('../app/clipboard-bridge');
const { registerFavouriteHandlers } = require('../app/favourites-bridge');

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function fakeWin(root, nViews) {
  const sent = [];
  const views = Array.from({ length: nViews }, (_, i) => ({ webContents: { id: `${root}${i}`, isDestroyed: () => false, send: (ch, v) => sent.push([`${root}${i}`, ch, v]) } }));
  return {
    root, sent, views, tabShell: { clicks: [], attentionClick(s) { this.clicks.push(s); } },
    isStrip: () => false, isTabView: () => false, canvasViews: { isPanel: () => false },
    forEachView(fn) { for (const v of views) fn(v); },
  };
}

test('P4: pushToAll reaches every live view of every window exactly once; pushToProject only that window\'s', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const n = 1 + Math.floor(rand() * 4);
    const wins = Array.from({ length: n }, (_, i) => fakeWin(`W${i}-`, 1 + Math.floor(rand() * 3)));
    const registry = createProjectRegistry();
    for (const w of wins) registry.add(w);
    const { pushToAll, pushToProject } = createPushers(registry);
    pushToAll('chrome', { x: seed });
    for (const w of wins) {
      assert.strictEqual(w.sent.length, w.views.length, 'one push per live view');
      assert.deepStrictEqual(w.sent.map((s) => s[0]).sort(), w.views.map((v) => v.webContents.id).sort());
    }
    const target = wins[Math.floor(rand() * n)];
    for (const w of wins) w.sent.length = 0;
    pushToProject(target)('layout', 1);
    for (const w of wins) assert.strictEqual(w.sent.length, w === target ? w.views.length : 0);
  }
});

test('P6: a toast click calls only its own window; a window closed since the toast was shown is ignored', () => {
  const a = fakeWin('A', 1); const b = fakeWin('B', 1);
  const registry = createProjectRegistry(); registry.add(a); registry.add(b);
  const click = clickFor(registry);
  click({ sender: 's1', owner: a });
  click({ sender: 's2', owner: b });
  assert.deepStrictEqual(a.tabShell.clicks, ['s1']);
  assert.deepStrictEqual(b.tabShell.clicks, ['s2']);
  registry.remove(a);                       // A's window closed after the toast was shown
  click({ sender: 's3', owner: a });
  assert.deepStrictEqual(a.tabShell.clicks, ['s1'], 'a closed window is not called');
  assert.deepStrictEqual(b.tabShell.clicks, ['s2']);
  const noShell = { root: 'C', tabShell: null }; registry.add(noShell);
  assert.doesNotThrow(() => click({ sender: 's', owner: noShell }));
  assert.doesNotThrow(() => click({ sender: 's', owner: null }));
});

test('P6: the holder hands the click what show() was given, untouched', () => {
  const made = [];
  class N { constructor() { this.h = {}; made.push(this); } on(ev, fn) { this.h[ev] = fn; } show() {} }
  const got = [];
  const holder = createToastHolder({ Notification: N, onClick: (who) => got.push(who), log: () => {} });
  const who = { sender: { id: 1 }, owner: { root: 'A' } };
  holder.show({ title: 't', body: 'b' }, who);
  made[0].h.click();
  assert.strictEqual(got[0], who);
});

test('P7: a busy menu in one window never blocks another\'s; the same owner twice is blocked until it leaves', () => {
  const gate = createBusyGate();
  const a = {}; const b = {};
  assert.strictEqual(gate.enter(a), true);
  assert.strictEqual(gate.enter(a), false, 'the same strip twice');
  assert.strictEqual(gate.enter(b), true, 'another window is not blocked');
  gate.leave(a);
  assert.strictEqual(gate.enter(a), true);
  gate.leave(b); gate.leave(b);
  assert.strictEqual(gate.has(b), false);
});

test('the avatar picker sits on the asking page\'s own window, falling back to win', async () => {
  const handlers = new Map();
  const parents = [];
  const dialog = { showOpenDialog: async (parent) => { parents.push(parent); return { canceled: true, filePaths: [] }; } };
  const winA = { id: 'A' }; const winB = { id: 'B' }; const fallback = { id: 'fallback' };
  const parentFor = (s) => (s === 'sa' ? winA : s === 'sb' ? winB : null);
  registerAvatarHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, store: {}, win: fallback, dialog, isSender: () => true, parentFor });
  await handlers.get(PICK_CHANNEL)({ sender: 'sa' });
  await handlers.get(PICK_CHANNEL)({ sender: 'sb' });
  await handlers.get(PICK_CHANNEL)({ sender: 'other' });
  assert.deepStrictEqual(parents, [winA, winB, fallback]);
});

test('the clipboard and favourites bridges answer through isSender alone, with no win', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f) };
  const clipboard = { readText: () => 'hi', availableFormats: () => ['text/plain'], readBuffer: () => Buffer.alloc(0) };
  const isSender = (s) => s === 'ok';
  registerClipboardHandlers({ ipcMain, clipboard, isSender });
  registerFavouriteHandlers({ ipcMain, store: { read: () => ({}), update() {} }, isSender });
  const denied = await handlers.get(CLIPBOARD_READ)({ sender: 'nope' });
  assert.ok(denied && typeof denied === 'object');
  assert.notStrictEqual(denied.text, 'hi', 'an unknown sender reads nothing');
  assert.deepStrictEqual(await handlers.get('favourites:get')({ sender: 'nope' }), { openrouter: [], claude: [] });
});
