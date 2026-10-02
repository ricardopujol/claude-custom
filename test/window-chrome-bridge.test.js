'use strict';
/**
 * Layout pass L2: main's half of the window-chrome settings -- "status line in
 * the header" (BACKLOG #27) and "hide the title bar" (#28). Same boundary shape
 * as avatar-bridge: gated to the window's views, strict on input, followed
 * across project windows.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  readChromeSettings, registerChromeHandlers, watchChromeSettings,
  CHROME_KEY, GET_CHANNEL, SET_STATUS_CHANNEL, SET_FRAMELESS_CHANNEL, PUSH_CHANNEL,
} = require('../app/window-chrome-bridge');
const { createStore } = require('../host/store');
const { quiet } = require('../host/status-relay');
const { tmpDir } = require('./tmp-dir');

const OFF = { statusInHeader: false, framelessWindow: false };

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}
function fakeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    update: (name, fallback, fn) => { data[name] = fn(name in data ? data[name] : fallback); return data[name]; },
  };
}
function setup({ store = fakeStore() } = {}) {
  const sent = [];
  const view = {};
  const ipcMain = fakeIpc();
  const sync = {};
  registerChromeHandlers({ ipcMain, store, sync, isSender: s => s === view, send: (ch, v) => sent.push([ch, v]) });
  const call = (ch, ...args) => ipcMain.handlers.get(ch)({ sender: view }, ...args);
  return { ipcMain, store, sent, call, sync };
}

test('both settings default to OFF when nothing has been saved', () => {
  assert.deepStrictEqual(readChromeSettings(fakeStore()), OFF);
});

test('only a real boolean true turns a setting on; garbage reads as OFF', () => {
  for (const bad of [null, 1, 'true', undefined, {}, []]) {
    assert.deepStrictEqual(
      readChromeSettings(fakeStore({ [CHROME_KEY]: { statusInHeader: bad, framelessWindow: bad } })), OFF, String(bad));
  }
  assert.deepStrictEqual(readChromeSettings(fakeStore({ [CHROME_KEY]: { statusInHeader: true } })),
    { statusInHeader: true, framelessWindow: false });
  for (const rec of [null, 'x', [true]]) assert.deepStrictEqual(readChromeSettings(fakeStore({ [CHROME_KEY]: rec })), OFF);
});

test('a store that throws reads as OFF, not as a crash', () => {
  assert.deepStrictEqual(readChromeSettings({ read: () => { throw new Error('disk'); } }), OFF);
});

test('get answers the stored settings to a tab view; a stranger gets OFF and changes nothing', async () => {
  const { call, ipcMain, store } = setup({ store: fakeStore({ [CHROME_KEY]: { framelessWindow: true } }) });
  assert.deepStrictEqual(await call(GET_CHANNEL), { statusInHeader: false, framelessWindow: true });
  const stranger = { sender: {} };
  assert.deepStrictEqual(await ipcMain.handlers.get(GET_CHANNEL)(stranger), OFF);
  assert.strictEqual(ipcMain.handlers.get(SET_STATUS_CHANNEL)(stranger, true), null);
  assert.strictEqual(ipcMain.handlers.get(SET_FRAMELESS_CHANNEL)(stranger, true), null);
  assert.deepStrictEqual(store.data[CHROME_KEY], { framelessWindow: true });
});

test('each setter persists its own key, keeps the other, returns the settings and pushes them', () => {
  const { call, store, sent, sync } = setup();
  assert.deepStrictEqual(call(SET_STATUS_CHANNEL, true), { statusInHeader: true, framelessWindow: false });
  assert.deepStrictEqual(call(SET_FRAMELESS_CHANNEL, true), { statusInHeader: true, framelessWindow: true });
  assert.deepStrictEqual(call(SET_STATUS_CHANNEL, false), { statusInHeader: false, framelessWindow: true });
  assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: false, framelessWindow: true });
  assert.deepStrictEqual(sent.map(([ch]) => ch), [PUSH_CHANNEL, PUSH_CHANNEL, PUSH_CHANNEL]);
  assert.deepStrictEqual(sent[2][1], { statusInHeader: false, framelessWindow: true });
  assert.deepStrictEqual(sync.last, { statusInHeader: false, framelessWindow: true });
});

test('setters refuse anything that is not a boolean (the string "false" is truthy)', () => {
  const { call, store, sent } = setup();
  for (const bad of ['false', 'true', 0, 1, null, undefined, {}]) {
    assert.strictEqual(call(SET_STATUS_CHANNEL, bad), null);
    assert.strictEqual(call(SET_FRAMELESS_CHANNEL, bad), null);
  }
  assert.strictEqual(CHROME_KEY in store.data, false);
  assert.deepStrictEqual(sent, []);
});

test('the watcher pushes a change made by another window, once, and skips unreadable reads', () => {
  const store = fakeStore();
  let readStatus = 'ok';
  store.readState = () => ({ status: readStatus });
  let listener = null;
  const sent = [];
  const sync = {};
  watchChromeSettings({ store, file: 'x', sync, send: (ch, v) => sent.push([ch, v]),
    watchFile: (f, o, fn) => { listener = fn; }, unwatchFile: () => {} });
  listener();
  assert.deepStrictEqual(sent, [], 'nothing changed');
  store.data[CHROME_KEY] = { statusInHeader: true };
  readStatus = 'unreadable';
  listener();
  assert.deepStrictEqual(sent, [], 'an unreadable read says nothing about the choice');
  readStatus = 'ok';
  listener();
  listener();
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, { statusInHeader: true, framelessWindow: false }]]);
});

test('the file the real store writes is the file the relay reads (BACKLOG #27)', () => {
  const dir = tmpDir('chrome-store');
  const store = createStore({ dir });
  const { ipcMain } = (() => {
    const ipc = fakeIpc();
    const view = {};
    registerChromeHandlers({ ipcMain: ipc, store, isSender: s => s === view, send: () => {} });
    ipc.call = (ch, v) => ipc.handlers.get(ch)({ sender: view }, v);
    return { ipcMain: ipc };
  })();
  const file = path.join(dir, `${CHROME_KEY}.json`);
  assert.strictEqual(quiet(file), false, 'nothing saved yet: the row prints');
  // The real store's update returns nothing: the setter must still answer the
  // settings it saved, not OFF (the fake store above returned the value).
  assert.deepStrictEqual(ipcMain.call(SET_STATUS_CHANNEL, true), { statusInHeader: true, framelessWindow: false });
  assert.strictEqual(quiet(file), true);
  ipcMain.call(SET_FRAMELESS_CHANNEL, true);
  assert.strictEqual(quiet(file), true, 'the other setting must not disturb it');
  ipcMain.call(SET_STATUS_CHANNEL, false);
  assert.strictEqual(quiet(file), false);
});
