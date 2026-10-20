'use strict';
// The tray's three install-wide switches (app/tray-settings.js), kept in the same chrome-global record as the window chrome
// without disturbing its two keys.
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const {
  readTraySettings, writeTraySetting, registerTrayHandlers, TRAY_DEFAULTS, GET_CHANNEL, SET_CHANNEL,
} = require('../app/tray-settings');
const { CHROME_KEY, readChromeSettings } = require('../app/window-chrome-bridge');

function fakeStore(seed = {}, { failRead = false, failWrite = false } = {}) {
  const data = { ...seed };
  return {
    data,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    readState: (name) => (failRead ? { status: 'unreadable', value: null }
      : name in data ? { status: 'ok', value: data[name] } : { status: 'missing', value: null }),
    update: (name, fallback, fn) => {
      if (failWrite) throw new Error('disk full');
      data[name] = fn(name in data ? data[name] : fallback); return data[name];
    },
  };
}

test('defaults: the tray icon on, close-to-tray off, start minimised off', () => {
  assert.deepStrictEqual(TRAY_DEFAULTS, { trayIcon: true, minimiseOnClose: false, startMinimised: false });
  assert.deepStrictEqual(readTraySettings(fakeStore()), TRAY_DEFAULTS);
});

test('close-to-tray is OFF unless the file says a real true', () => {
  for (const bad of [1, 'true', null, {}, [], 'yes']) {
    assert.strictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: { minimiseOnClose: bad, startMinimised: bad } })).minimiseOnClose, false, String(bad));
    assert.strictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: { minimiseOnClose: bad, startMinimised: bad } })).startMinimised, false, String(bad));
  }
  assert.strictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: { minimiseOnClose: true } })).minimiseOnClose, true);
});

test('the tray icon is on unless the file says a real false', () => {
  assert.strictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: { trayIcon: false } })).trayIcon, false);
  for (const odd of [0, 'false', null, undefined]) {
    assert.strictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: { trayIcon: odd } })).trayIcon, true, String(odd));
  }
});

test('an unreadable file or a corrupt record reads as the safe defaults, never throws', () => {
  assert.deepStrictEqual(readTraySettings(fakeStore({}, { failRead: true })), TRAY_DEFAULTS);
  assert.deepStrictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: 'junk' })), TRAY_DEFAULTS);
  assert.deepStrictEqual(readTraySettings(fakeStore({ [CHROME_KEY]: [1, 2] })), TRAY_DEFAULTS);
  assert.deepStrictEqual(readTraySettings({ readState() { throw new Error('boom'); } }), TRAY_DEFAULTS);
  assert.deepStrictEqual(readTraySettings(null), TRAY_DEFAULTS);
});

test('writeTraySetting: sets one key, keeps the window chrome keys, and answers the new settings', () => {
  const store = fakeStore({ [CHROME_KEY]: { statusInHeader: false, framelessWindow: true } });
  const saved = writeTraySetting(store, 'startMinimised', true);
  assert.deepStrictEqual(saved, { trayIcon: true, minimiseOnClose: false, startMinimised: true });
  assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: false, framelessWindow: true, startMinimised: true });
  assert.deepStrictEqual(readChromeSettings(store), { statusInHeader: false, framelessWindow: true });
});

test('writeTraySetting: refuses an unknown key, a non-boolean, an unreadable file, and a failed write', () => {
  const store = fakeStore({ [CHROME_KEY]: { statusInHeader: true } });
  assert.strictEqual(writeTraySetting(store, 'statusInHeader', false), null);
  assert.strictEqual(writeTraySetting(store, 'startMinimised', 'true'), null);
  assert.strictEqual(writeTraySetting(store, '__proto__', true), null);
  assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: true });
  assert.strictEqual(writeTraySetting(fakeStore({}, { failRead: true }), 'trayIcon', false), null);
  assert.strictEqual(writeTraySetting(fakeStore({}, { failWrite: true }), 'trayIcon', false), null);
});

test('property: writing a setting never changes the other two or the chrome keys', () => {
  const key = fc.constantFrom('trayIcon', 'minimiseOnClose', 'startMinimised');
  fc.assert(fc.property(key, fc.boolean(), fc.boolean(), fc.boolean(), (k, value, status, frameless) => {
    const store = fakeStore({ [CHROME_KEY]: { statusInHeader: status, framelessWindow: frameless } });
    const before = readTraySettings(store);
    const after = writeTraySetting(store, k, value);
    assert.deepStrictEqual({ ...after, [k]: before[k] }, before);
    assert.strictEqual(after[k], value);
    assert.strictEqual(store.data[CHROME_KEY].statusInHeader, status);
    assert.strictEqual(store.data[CHROME_KEY].framelessWindow, frameless);
  }));
});

function setup(opts = {}) {
  const handlers = new Map();
  const view = {};
  const changes = [];
  const store = opts.store || fakeStore();
  registerTrayHandlers({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store,
    isSender: s => s === view, onChange: s => changes.push(s),
  });
  return { call: (ch, ...a) => handlers.get(ch)({ sender: view }, ...a), callFrom: (ch, sender, ...a) => handlers.get(ch)({ sender }, ...a), changes, store };
}

test('handlers: get answers the settings; a sender that is not one of this window\'s views gets nothing', () => {
  const { call, callFrom } = setup();
  assert.deepStrictEqual(call(GET_CHANNEL), TRAY_DEFAULTS);
  assert.strictEqual(callFrom(GET_CHANNEL, {}), null);
  assert.strictEqual(callFrom(SET_CHANNEL, {}, 'startMinimised', true), null);
});

test('handlers: set saves, answers, and tells main (onChange) once; a refused set tells nobody', () => {
  const { call, changes, store } = setup();
  assert.deepStrictEqual(call(SET_CHANNEL, 'trayIcon', false), { trayIcon: false, minimiseOnClose: false, startMinimised: false });
  assert.deepStrictEqual(changes, [{ trayIcon: false, minimiseOnClose: false, startMinimised: false }]);
  assert.strictEqual(call(SET_CHANNEL, 'nope', true), null);
  assert.strictEqual(call(SET_CHANNEL, 'trayIcon', 'x'), null);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(store.data[CHROME_KEY].trayIcon, false);
});
