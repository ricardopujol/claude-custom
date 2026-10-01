'use strict';
/**
 * Main's side of the global layout (layout pass L1, S6): install-wide, like
 * the unfocused dim and the agent-images toggle, so it lives in main's store
 * and a change reaches every tab view -- and, through the store file, every
 * other project window. Same boundary shape as app/avatar-bridge.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  readLayout, registerLayoutHandlers, watchLayout, LAYOUT_KEY, GET_CHANNEL, SET_CHANNEL, PUSH_CHANNEL,
  MAX_LAYOUT_BYTES,
} = require('../app/layout-bridge');

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}
function fakeStore(seed = {}, states = {}) {
  const data = { ...seed };
  return {
    data,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    update: (name, fallback, fn) => { data[name] = fn(name in data ? data[name] : fallback); return data[name]; },
    readState: name => states[name] || { status: name in data ? 'ok' : 'missing' },
  };
}
const VIEW = {};
function setup(store = fakeStore()) {
  const sent = [];
  const ipcMain = fakeIpc();
  const sync = {};
  registerLayoutHandlers({
    ipcMain, store, sync, isSender: s => s === VIEW, send: (ch, v) => sent.push([ch, v]),
  });
  const call = (ch, ...args) => ipcMain.handlers.get(ch)({ sender: VIEW }, ...args);
  return { ipcMain, store, sent, call, sync };
}
const LAYOUT = { version: 1, zones: { right: ['agents'] } };

test('nothing saved reads as null: the page migrates, main never invents a default', () => {
  assert.strictEqual(readLayout(fakeStore()), null);
});

test('a stored value that is not a layout object reads as null', () => {
  for (const bad of [[], 'x', 7, true, null]) {
    assert.strictEqual(readLayout(fakeStore({ [LAYOUT_KEY]: bad })), null, JSON.stringify(bad));
  }
  assert.strictEqual(readLayout({ read: () => { throw new Error('disk'); } }), null);
});

test('get answers the stored layout to a tab view', async () => {
  const { call } = setup(fakeStore({ [LAYOUT_KEY]: LAYOUT }));
  assert.deepStrictEqual(await call(GET_CHANNEL), LAYOUT);
});

test('a sender that is not one of this window\'s tab views gets nothing and changes nothing', async () => {
  const { ipcMain, store, sent } = setup(fakeStore({ [LAYOUT_KEY]: LAYOUT }));
  const stranger = { sender: {} };
  assert.strictEqual(await ipcMain.handlers.get(GET_CHANNEL)(stranger), null);
  assert.strictEqual(await ipcMain.handlers.get(SET_CHANNEL)(stranger, { version: 1 }), null);
  assert.deepStrictEqual(store.data[LAYOUT_KEY], LAYOUT);
  assert.deepStrictEqual(sent, []);
});

test('set stores the layout and pushes it to every view', async () => {
  const { call, store, sent, sync } = setup();
  assert.deepStrictEqual(await call(SET_CHANNEL, LAYOUT), LAYOUT);
  assert.deepStrictEqual(store.data[LAYOUT_KEY], LAYOUT);
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, LAYOUT]]);
  assert.strictEqual(sync.last, JSON.stringify(LAYOUT));
});

test('set refuses anything that is not a plain object, or is bigger than the cap', async () => {
  const { call, store, sent } = setup();
  for (const bad of [null, [], 'x', 7, undefined]) assert.strictEqual(await call(SET_CHANNEL, bad), null);
  assert.strictEqual(MAX_LAYOUT_BYTES, 8192);
  assert.strictEqual(await call(SET_CHANNEL, { pad: 'x'.repeat(MAX_LAYOUT_BYTES) }), null);
  assert.ok(!(LAYOUT_KEY in store.data));
  assert.deepStrictEqual(sent, []);
});

test('a store that fails to write answers null and pushes nothing', async () => {
  const store = fakeStore();
  store.update = () => { throw new Error('EBUSY'); };
  const { call, sent } = setup(store);
  assert.strictEqual(await call(SET_CHANNEL, LAYOUT), null);
  assert.deepStrictEqual(sent, []);
});

// --- another project window changed it ---------------------------------------

function watchSetup(store) {
  const sent = [];
  let listener = null;
  const sync = {};
  const stop = watchLayout({
    store, file: 'layout-global.json', sync, send: (ch, v) => sent.push([ch, v]),
    watchFile: (_f, _o, fn) => { listener = fn; }, unwatchFile: () => { listener = null; },
  });
  return { sent, fire: () => listener(), stop, sync, isWatching: () => listener !== null };
}

test('a change another main wrote is pushed once', () => {
  const store = fakeStore({ [LAYOUT_KEY]: LAYOUT });
  const w = watchSetup(store);
  const next = { version: 1, zones: { left: ['agents'] } };
  store.data[LAYOUT_KEY] = next;
  w.fire();
  w.fire();
  assert.deepStrictEqual(w.sent, [[PUSH_CHANNEL, next]]);
});

test('no change, or a read that failed, pushes nothing', () => {
  const states = {};
  const store = fakeStore({ [LAYOUT_KEY]: LAYOUT }, states);
  const w = watchSetup(store);
  w.fire();
  states[LAYOUT_KEY] = { status: 'error' };
  store.data[LAYOUT_KEY] = { version: 1, zones: {} };
  w.fire();
  assert.deepStrictEqual(w.sent, []);
});

test('a change this window just made is not pushed back to it', async () => {
  const store = fakeStore();
  const sync = {};
  const sent = [];
  let listener = null;
  watchLayout({ store, file: 'f', sync, send: (ch, v) => sent.push([ch, v]),
    watchFile: (_f, _o, fn) => { listener = fn; }, unwatchFile: () => {} });
  const ipcMain = fakeIpc();
  registerLayoutHandlers({ ipcMain, store, sync, isSender: () => true, send: (ch, v) => sent.push([ch, v]) });
  await ipcMain.handlers.get(SET_CHANNEL)({ sender: VIEW }, LAYOUT);
  listener();
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, LAYOUT]]);   // once, from set; not again from the watcher
});

test('stop() stops watching', () => {
  const w = watchSetup(fakeStore());
  assert.ok(w.isWatching());
  w.stop();
  assert.ok(!w.isWatching());
});
