'use strict';
/**
 * Main's side of the avatar settings (BACKLOG C #13, #18): the file picker for
 * a portrait, and the install-wide "show agent images" toggle. Same boundary
 * shape as favourites-bridge: gated to the one window, strict on input.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  readImagesEnabled, registerAvatarHandlers, AVATAR_KEY, GET_CHANNEL, SET_CHANNEL, PICK_CHANNEL, PUSH_CHANNEL,
  pickerOptions,
} = require('../app/avatar-bridge');
const { MEDIA_EXTENSIONS } = require('../host/portraits');

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
function setup({ store = fakeStore(), dialog } = {}) {
  const sent = [];
  const win = { webContents: { send: (ch, v) => sent.push([ch, v]) } };
  const ipcMain = fakeIpc();
  registerAvatarHandlers({ ipcMain, store, win, dialog });
  const call = (ch, ...args) => ipcMain.handlers.get(ch)({ sender: win.webContents }, ...args);
  return { ipcMain, store, win, sent, call };
}

test('images default to ON when nothing has been saved', () => {
  assert.strictEqual(readImagesEnabled(fakeStore()), true);
});

test('only a real boolean false turns images off; garbage in the store means ON', () => {
  for (const bad of [null, 0, 'false', undefined, {}, []]) {
    assert.strictEqual(readImagesEnabled(fakeStore({ [AVATAR_KEY]: { imagesEnabled: bad } })), true, String(bad));
  }
  assert.strictEqual(readImagesEnabled(fakeStore({ [AVATAR_KEY]: { imagesEnabled: false } })), false);
});

test('a store that throws reads as ON, not as a crash', () => {
  assert.strictEqual(readImagesEnabled({ read: () => { throw new Error('disk'); } }), true);
});

test('get answers the stored value to the registered window', async () => {
  const { call } = setup({ store: fakeStore({ [AVATAR_KEY]: { imagesEnabled: false } }) });
  assert.strictEqual(await call(GET_CHANNEL), false);
});

test('any other sender is told ON and cannot change anything', async () => {
  const { ipcMain, store } = setup();
  const stranger = { sender: {} };
  assert.strictEqual(await ipcMain.handlers.get(GET_CHANNEL)(stranger), true);
  assert.strictEqual(ipcMain.handlers.get(SET_CHANNEL)(stranger, false), null);
  assert.strictEqual(await ipcMain.handlers.get(PICK_CHANNEL)(stranger), null);
  assert.strictEqual(AVATAR_KEY in store.data, false);
});

test('set persists the desired state, returns it, and pushes it to the window', () => {
  const { call, store, sent } = setup();
  assert.strictEqual(call(SET_CHANNEL, false), false);
  assert.strictEqual(store.data[AVATAR_KEY].imagesEnabled, false);
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, false]]);
  assert.strictEqual(call(SET_CHANNEL, true), true);
  assert.strictEqual(store.data[AVATAR_KEY].imagesEnabled, true);
});

test('set refuses anything that is not a boolean (the string "false" is truthy)', () => {
  const { call, store, sent } = setup();
  for (const bad of ['false', 0, null, undefined, 1, {}]) assert.strictEqual(call(SET_CHANNEL, bad), null);
  assert.strictEqual(AVATAR_KEY in store.data, false);
  assert.deepStrictEqual(sent, []);
});

test('set keeps other keys in the avatar record', () => {
  const store = fakeStore({ [AVATAR_KEY]: { imagesEnabled: true, other: 1 } });
  const { call } = setup({ store });
  call(SET_CHANNEL, false);
  assert.deepStrictEqual(store.data[AVATAR_KEY], { imagesEnabled: false, other: 1 });
});

test('a store that cannot save answers null instead of claiming success', () => {
  const store = { read: () => ({}), update: () => { throw new Error('EPERM'); } };
  const { call, sent } = setup({ store });
  assert.strictEqual(call(SET_CHANNEL, false), null);
  assert.deepStrictEqual(sent, []);
});

test('pick filters the dialog to exactly the media the uploader accepts', () => {
  assert.deepStrictEqual(pickerOptions().filters[0].extensions, MEDIA_EXTENSIONS);
  assert.deepStrictEqual(pickerOptions().properties, ['openFile']);
});

test('pick answers the chosen path, or null when cancelled', async () => {
  const chosen = setup({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\a\\b.webm'] }) } });
  assert.strictEqual(await chosen.call(PICK_CHANNEL), 'C:\\a\\b.webm');
  const cancelled = setup({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.strictEqual(await cancelled.call(PICK_CHANNEL), null);
});

test('pick answers null when the dialog itself throws', async () => {
  const { call } = setup({ dialog: { showOpenDialog: async () => { throw new Error('boom'); } } });
  assert.strictEqual(await call(PICK_CHANNEL), null);
});
