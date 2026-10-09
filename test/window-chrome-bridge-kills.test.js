'use strict';
/**
 * Kill tests for Mortimer's release-gate survivor S24 (2026-10-09), app/window-chrome-bridge.js half: the stored-record
 * shape guards (`settingsOf`, `ensureStatusDefault`, the setter's merge) and the change detector `same`
 * (`a.framelessWindow === b.framelessWindow`) that decides whether a window is told about a change.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  readChromeSettings, ensureStatusDefault, registerChromeHandlers, watchChromeSettings,
  CHROME_KEY, SET_STATUS_CHANNEL, SET_FRAMELESS_CHANNEL, PUSH_CHANNEL,
} = require('../app/window-chrome-bridge');

const DEFAULTS = { statusInHeader: true, framelessWindow: false };

// A store with no readState, so readChromeState takes the plain `read` path with whatever record is stored.
const rawStore = (rec) => ({
  data: { [CHROME_KEY]: rec },
  read(name, fallback) { return name in this.data ? this.data[name] : fallback; },
  update(name, fallback, fn) { this.data[name] = fn(name in this.data ? this.data[name] : fallback); return this.data[name]; },
});

// A store with readState, as host/store.js has.
const stateStore = (rec, status = 'ok') => ({
  data: status === 'missing' ? {} : { [CHROME_KEY]: rec },
  readState(name) { return name in this.data ? { status, value: this.data[name] } : { status: 'missing', value: null }; },
  read(name, fallback) { return name in this.data ? this.data[name] : fallback; },
  update(name, fallback, fn) { this.data[name] = fn(name in this.data ? this.data[name] : fallback); return this.data[name]; },
});

test('S24: a stored record that is not a plain object reads as the defaults, whatever properties it carries', () => {
  const armed = { statusInHeader: false, framelessWindow: true };
  const asArray = Object.assign([], armed);
  const asFunction = Object.assign(() => {}, armed);
  for (const [label, rec] of [['an array', asArray], ['a function', asFunction], ['null', null], ['a string', 'x'], ['a number', 5]]) {
    assert.deepStrictEqual(readChromeSettings(rawStore(rec)), DEFAULTS, label);
  }
});

test('S24: a real object record is read for both flags (the guards above are not a blanket default)', () => {
  assert.deepStrictEqual(readChromeSettings(rawStore({ statusInHeader: false, framelessWindow: true })),
    { statusInHeader: false, framelessWindow: true });
});

test('S24: ensureStatusDefault treats an array, a string or a null record as having no choice, and writes the default over it', () => {
  for (const [label, rec] of [
    ['an array carrying a boolean', Object.assign([], { statusInHeader: false })],
    ['a plain array', ['a', 'b']],
    ['a string', 'ab'],
    ['null', null],
  ]) {
    const store = stateStore(rec);
    assert.strictEqual(ensureStatusDefault(store), true, label);
    // The old value's characters / indices must not be spread into the record.
    assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: true }, label);
  }
});

test('S24: ensureStatusDefault leaves a record that already has a boolean choice alone, and keeps the other keys when it writes', () => {
  const chosen = stateStore({ statusInHeader: false, framelessWindow: true });
  assert.strictEqual(ensureStatusDefault(chosen), false);
  assert.deepStrictEqual(chosen.data[CHROME_KEY], { statusInHeader: false, framelessWindow: true });

  const partial = stateStore({ framelessWindow: true });
  assert.strictEqual(ensureStatusDefault(partial), true);
  assert.deepStrictEqual(partial.data[CHROME_KEY], { framelessWindow: true, statusInHeader: true });
});

test('S24: a setter merging into an array or string record starts from {} rather than spreading its elements', () => {
  for (const rec of [['x', 'y'], 'ab']) {
    const store = stateStore(rec);
    const view = {};
    const handlers = new Map();
    registerChromeHandlers({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store, sync: {}, isSender: s => s === view, send: () => {},
    });
    const result = handlers.get(SET_FRAMELESS_CHANNEL)({ sender: view }, true);
    assert.deepStrictEqual(result, { statusInHeader: true, framelessWindow: true });
    assert.deepStrictEqual(store.data[CHROME_KEY], { framelessWindow: true });
  }
});

// --- the change detector, driven through the watcher ---------------------------------------------------------------

function watched(store) {
  const sent = [];
  let listener = null;
  const stop = watchChromeSettings({
    store, file: 'chrome-global.json', sync: {}, send: (ch, v) => sent.push([ch, v]),
    watchFile: (f, opts, fn) => { listener = fn; }, unwatchFile: () => {},
    setTimer: () => {},
  });
  return { sent, fire: () => listener(), stop };
}

test('S24: a change to framelessWindow ALONE is pushed to the windows', () => {
  const store = stateStore({ statusInHeader: true, framelessWindow: false });
  const w = watched(store);
  store.data[CHROME_KEY] = { statusInHeader: true, framelessWindow: true };
  w.fire();
  assert.deepStrictEqual(w.sent, [[PUSH_CHANNEL, { statusInHeader: true, framelessWindow: true }]]);
});

test('S24: a change to statusInHeader ALONE is pushed too', () => {
  const store = stateStore({ statusInHeader: true, framelessWindow: false });
  const w = watched(store);
  store.data[CHROME_KEY] = { statusInHeader: false, framelessWindow: false };
  w.fire();
  assert.deepStrictEqual(w.sent, [[PUSH_CHANNEL, { statusInHeader: false, framelessWindow: false }]]);
});

test('S24: an unchanged file is not pushed again', () => {
  const store = stateStore({ statusInHeader: false, framelessWindow: true });
  const w = watched(store);
  w.fire();
  w.fire();
  assert.deepStrictEqual(w.sent, []);
});

test('S24: when the first read was unreadable (null), the first good read IS pushed', () => {
  const store = stateStore({ statusInHeader: true, framelessWindow: false }, 'corrupt');
  const w = watched(store);                      // readChromeState -> null: sync.last is null
  store.readState = () => ({ status: 'ok', value: { statusInHeader: true, framelessWindow: false } });
  w.fire();
  assert.deepStrictEqual(w.sent, [[PUSH_CHANNEL, DEFAULTS]]);
});

test('S24: the two setters write their own key only (channels are not swapped)', () => {
  const store = stateStore({ statusInHeader: true, framelessWindow: false });
  const view = {};
  const handlers = new Map();
  registerChromeHandlers({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store, sync: {}, isSender: s => s === view, send: () => {},
  });
  handlers.get(SET_STATUS_CHANNEL)({ sender: view }, false);
  assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: false, framelessWindow: false });
  handlers.get(SET_FRAMELESS_CHANNEL)({ sender: view }, true);
  assert.deepStrictEqual(store.data[CHROME_KEY], { statusInHeader: false, framelessWindow: true });
});
