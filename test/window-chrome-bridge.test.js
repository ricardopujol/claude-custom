'use strict';
/**
 * Layout pass L2: main's half of the window-chrome settings -- "status line in
 * the header" (BACKLOG #27) and "hide the title bar" (#28). Same boundary shape
 * as avatar-bridge: gated to the window's views, strict on input, followed
 * across project windows.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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

test('Dexter L2 #3: focus mode covers the strip only in a framed window', () => {
  const { viewTop } = require('../app/window-chrome-bridge');
  assert.strictEqual(viewTop({ focusMode: false, frameless: false, stripHeight: 34 }), 34);
  assert.strictEqual(viewTop({ focusMode: true, frameless: false, stripHeight: 34 }), 0);
  // Frameless: the strip is the window's only title bar (drag, minimise, close).
  assert.strictEqual(viewTop({ focusMode: true, frameless: true, stripHeight: 34 }), 34);
  assert.strictEqual(viewTop({ focusMode: false, frameless: true, stripHeight: 34 }), 34);
});

const DEFAULTS = { statusInHeader: true, framelessWindow: false };

test('#67: nothing saved -> the status row is in the header (on), the title bar stays (off)', () => {
  assert.deepStrictEqual(readChromeSettings(fakeStore()), DEFAULTS);
});

test('#67: only a real boolean false turns the header off; frameless needs a real true; garbage reads as the defaults', () => {
  for (const bad of [null, 1, 'true', 'false', 0, undefined, {}, []]) {
    assert.deepStrictEqual(
      readChromeSettings(fakeStore({ [CHROME_KEY]: { statusInHeader: bad, framelessWindow: bad } })), DEFAULTS, String(bad));
  }
  assert.deepStrictEqual(readChromeSettings(fakeStore({ [CHROME_KEY]: { statusInHeader: false } })),
    { statusInHeader: false, framelessWindow: false });
  assert.deepStrictEqual(readChromeSettings(fakeStore({ [CHROME_KEY]: { framelessWindow: true } })),
    { statusInHeader: true, framelessWindow: true });
  for (const rec of [null, 'x', [true]]) assert.deepStrictEqual(readChromeSettings(fakeStore({ [CHROME_KEY]: rec })), DEFAULTS);
});

test('#67: a store that throws reads as the defaults for a frame decision, not as a crash', () => {
  assert.deepStrictEqual(readChromeSettings({ read: () => { throw new Error('disk'); } }), DEFAULTS);
});

test('#67: main and the relay agree on every record, so the fields show in the header exactly when the CLI row is quiet', () => {
  const dir = tmpDir('chrome-agree');
  const file = path.join(dir, `${CHROME_KEY}.json`);
  const records = [{ statusInHeader: false }, { statusInHeader: true }, {}, { framelessWindow: true },
    { statusInHeader: 'false' }, null, 'x', [true]];
  for (const rec of records) {
    fs.writeFileSync(file, JSON.stringify(rec));
    const main = readChromeSettings(createStore({ dir })).statusInHeader;
    assert.strictEqual(quiet(file), main, JSON.stringify(rec));
  }
  fs.rmSync(file);
  assert.strictEqual(quiet(file), true, 'missing file');
});

test('get answers the stored settings to a tab view; a stranger gets OFF and changes nothing', async () => {
  const { call, ipcMain, store } = setup({ store: fakeStore({ [CHROME_KEY]: { framelessWindow: true } }) });
  assert.deepStrictEqual(await call(GET_CHANNEL), { statusInHeader: true, framelessWindow: true });
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

// A store whose readState can be made to fail, the way the real one reports a
// busy (antivirus) or corrupt file.
function flakyStore(seed = {}) {
  const store = fakeStore(seed);
  store.fail = null;                       // 'unreadable' | 'corrupt' | null
  store.readState = (name) => (store.fail ? { status: store.fail, value: null }
    : name in store.data ? { status: 'ok', value: store.data[name] } : { status: 'missing', value: null });
  return store;
}

test('Dexter L2 #1: get answers null (unknown) for an unreadable file, never a confident OFF', async () => {
  const store = flakyStore({ [CHROME_KEY]: { statusInHeader: true } });
  const { call } = setup({ store });
  store.fail = 'unreadable';
  assert.strictEqual(await call(GET_CHANNEL), null);
  store.fail = 'corrupt';
  assert.strictEqual(await call(GET_CHANNEL), null);
  store.fail = null;
  assert.deepStrictEqual(await call(GET_CHANNEL), { statusInHeader: true, framelessWindow: false });
});

test('Dexter L2 #1: one unreadable poll is retried, so another window\'s change still lands', () => {
  const store = flakyStore();
  let listener = null;
  const timers = [];
  const sent = [];
  watchChromeSettings({ store, file: 'x', sync: {}, send: (ch, v) => sent.push([ch, v]),
    watchFile: (f, o, fn) => { listener = fn; }, unwatchFile: () => {}, setTimer: (fn) => timers.push(fn) });
  store.data[CHROME_KEY] = { statusInHeader: false };  // window B's write...
  store.fail = 'unreadable';                           // ...lands while A's read is busy
  listener();                                          // the ONE poll watchFile gives for it
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(timers.length, 1, 'an unreadable read schedules a retry');
  listener();
  assert.strictEqual(timers.length, 1, 'retries never stack');
  store.fail = null;
  timers.shift()();
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, { statusInHeader: false, framelessWindow: false }]]);
});

test('Dexter L2 #1: the watcher decides on the value it just read, not on a second read', () => {
  const store = flakyStore({ [CHROME_KEY]: { statusInHeader: false } });
  store.read = () => { throw new Error('a second read would fall back to OFF'); };
  let listener = null;
  const sent = [];
  watchChromeSettings({ store, file: 'x', sync: { }, send: (ch, v) => sent.push([ch, v]),
    watchFile: (f, o, fn) => { listener = fn; }, unwatchFile: () => {}, setTimer: () => {} });
  store.data[CHROME_KEY] = { statusInHeader: true };
  listener();
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, { statusInHeader: true, framelessWindow: false }]]);
});

test('Dexter L2 #2: a setter refuses while the file is unreadable or corrupt, and leaves it alone', () => {
  for (const fail of ['unreadable', 'corrupt']) {
    const store = flakyStore({ [CHROME_KEY]: { statusInHeader: true, framelessWindow: true } });
    const { call, sent } = setup({ store });
    store.fail = fail;
    assert.strictEqual(call(SET_STATUS_CHANNEL, false), null, fail);
    assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: true, framelessWindow: true }, fail);
    assert.deepStrictEqual(sent, [], fail);
  }
});

test('the watcher pushes a change made by another window, once, and skips unreadable reads', () => {
  const store = fakeStore();
  let readStatus = 'ok';
  store.readState = (name) => ({ status: readStatus, value: readStatus === 'ok' ? store.data[name] : null });
  let listener = null;
  const sent = [];
  const sync = {};
  watchChromeSettings({ store, file: 'x', sync, send: (ch, v) => sent.push([ch, v]),
    watchFile: (f, o, fn) => { listener = fn; }, unwatchFile: () => {} });
  listener();
  assert.deepStrictEqual(sent, [], 'nothing changed');
  store.data[CHROME_KEY] = { statusInHeader: false };
  readStatus = 'unreadable';
  listener();
  assert.deepStrictEqual(sent, [], 'an unreadable read says nothing about the choice');
  readStatus = 'ok';
  listener();
  listener();
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, { statusInHeader: false, framelessWindow: false }]]);
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
  assert.strictEqual(quiet(file), true, 'nothing saved yet: the row is hidden (#67 default)');
  // The real store's update returns nothing: the setter must still answer the
  // settings it saved, not OFF (the fake store above returned the value).
  assert.deepStrictEqual(ipcMain.call(SET_STATUS_CHANNEL, true), { statusInHeader: true, framelessWindow: false });
  assert.strictEqual(quiet(file), true);
  ipcMain.call(SET_FRAMELESS_CHANNEL, true);
  assert.strictEqual(quiet(file), true, 'the other setting must not disturb it');
  ipcMain.call(SET_STATUS_CHANNEL, false);
  assert.strictEqual(quiet(file), false);
});
