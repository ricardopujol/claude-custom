'use strict';
/**
 * BACKLOG #76: the install-wide Role/Name roster toggle rides the avatar
 * bridge (same record, same boundary, same cross-window watcher).
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  readRosterNames, registerAvatarHandlers, watchImagesEnabled, AVATAR_KEY,
  NAMES_GET_CHANNEL, NAMES_SET_CHANNEL, NAMES_PUSH_CHANNEL, PUSH_CHANNEL,
} = require('../app/avatar-bridge');

function fakeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    update: (name, fallback, fn) => { data[name] = fn(name in data ? data[name] : fallback); return data[name]; },
  };
}
function setup(store = fakeStore()) {
  const handlers = new Map();
  const sent = [];
  const win = { webContents: { send: (ch, v) => sent.push([ch, v]) } };
  registerAvatarHandlers({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store, win, dialog: {} });
  const call = (ch, ...a) => handlers.get(ch)({ sender: win.webContents }, ...a);
  return { handlers, store, sent, call, win };
}

test('the mode is role unless the store holds exactly "name"', () => {
  assert.strictEqual(readRosterNames(fakeStore()), 'role');
  for (const bad of [null, 0, 'NAME', 'both', {}, [], true]) {
    assert.strictEqual(readRosterNames(fakeStore({ [AVATAR_KEY]: { rosterNames: bad } })), 'role', String(bad));
  }
  assert.strictEqual(readRosterNames(fakeStore({ [AVATAR_KEY]: { rosterNames: 'name' } })), 'name');
  assert.strictEqual(readRosterNames({ read: () => { throw new Error('disk'); } }), 'role');
  assert.strictEqual(readRosterNames(fakeStore({ [AVATAR_KEY]: 'garbage' })), 'role');
});

test('get answers the stored mode to the window, role to a stranger', async () => {
  const { call, handlers } = setup(fakeStore({ [AVATAR_KEY]: { rosterNames: 'name' } }));
  assert.strictEqual(await call(NAMES_GET_CHANNEL), 'name');
  assert.strictEqual(await handlers.get(NAMES_GET_CHANNEL)({ sender: {} }), 'role');
});

test('set persists the desired mode beside imagesEnabled, answers it and pushes it', () => {
  const store = fakeStore({ [AVATAR_KEY]: { imagesEnabled: false } });
  const { call, sent } = setup(store);
  assert.strictEqual(call(NAMES_SET_CHANNEL, 'name'), 'name');
  assert.deepStrictEqual(store.data[AVATAR_KEY], { imagesEnabled: false, rosterNames: 'name' });
  assert.deepStrictEqual(sent, [[NAMES_PUSH_CHANNEL, 'name']]);
});

test('set refuses anything but "role" or "name", and a stranger', () => {
  const { call, store, sent, handlers } = setup();
  for (const bad of ['', 'NAME', 'both', 0, null, undefined, true, {}]) assert.strictEqual(call(NAMES_SET_CHANNEL, bad), null);
  assert.strictEqual(handlers.get(NAMES_SET_CHANNEL)({ sender: {} }, 'name'), null);
  assert.strictEqual(AVATAR_KEY in store.data, false);
  assert.deepStrictEqual(sent, []);
});

test('a store that cannot save answers null and pushes nothing', () => {
  const { call, sent } = setup({ read: () => ({}), update: () => { throw new Error('EPERM'); } });
  assert.strictEqual(call(NAMES_SET_CHANNEL, 'name'), null);
  assert.deepStrictEqual(sent, []);
});

test('the images toggle still keeps the mode when it saves', () => {
  const store = fakeStore({ [AVATAR_KEY]: { rosterNames: 'name' } });
  const { call } = setup(store);
  call('avatar:setImagesEnabled', false);
  assert.deepStrictEqual(store.data[AVATAR_KEY], { rosterNames: 'name', imagesEnabled: false });
});

function watchHarness(initial) {
  const store = fakeStore({ [AVATAR_KEY]: initial });
  const sent = [];
  const l = [];
  watchImagesEnabled({
    store, file: 'f', win: { webContents: { send: (ch, v) => sent.push([ch, v]) } },
    watchFile: (f, o, fn) => l.push(fn), unwatchFile: () => {},
  });
  return { store, sent, poke: () => l[0]() };
}

test('the watcher pushes a mode another window wrote, once', () => {
  const h = watchHarness({ imagesEnabled: true });
  h.store.data[AVATAR_KEY] = { imagesEnabled: true, rosterNames: 'name' };
  h.poke(); h.poke();
  assert.deepStrictEqual(h.sent, [[NAMES_PUSH_CHANNEL, 'name']]);
});

test('the watcher pushes images and mode independently', () => {
  const h = watchHarness({});
  h.store.data[AVATAR_KEY] = { imagesEnabled: false, rosterNames: 'name' };
  h.poke();
  assert.deepStrictEqual(h.sent, [[PUSH_CHANNEL, false], [NAMES_PUSH_CHANNEL, 'name']]);
});

test('this window\'s own set is not echoed back by the watcher', () => {
  const store = fakeStore({ [AVATAR_KEY]: {} });
  const sync = {};
  const sent = [];
  const win = { webContents: { send: (ch, v) => sent.push([ch, v]) } };
  const handlers = new Map();
  registerAvatarHandlers({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store, win, dialog: {}, sync });
  const l = [];
  watchImagesEnabled({ store, file: 'f', win, sync, watchFile: (f, o, fn) => l.push(fn), unwatchFile: () => {} });
  handlers.get(NAMES_SET_CHANNEL)({ sender: win.webContents }, 'name');
  sent.length = 0;
  l[0]();
  assert.deepStrictEqual(sent, []);
});
