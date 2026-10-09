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

// --- PR #141 review fixes (F3, F4) ----------------------------------------------

function stateStore(record, status = 'ok') {
  const data = { [AVATAR_KEY]: record };
  const writes = [];
  return {
    data, writes, status,
    read: (n, f) => (n in data && status === 'ok' ? data[n] : f),   // an unreadable file reads as the fallback
    readState: () => ({ status, value: status === 'ok' ? data[AVATAR_KEY] : undefined }),
    update: (n, f, fn) => { writes.push(n); data[n] = fn(status === 'ok' ? data[n] : f); },
  };
}

// The real store's shape: read() folds a bad file into the fallback, readState() says why, write() is atomic.
function seqStore(seq, initial) {
  const state = { calls: 0, writes: [], record: initial };
  const next = () => seq[Math.min(state.calls++, seq.length - 1)];
  const st = () => { const status = next(); return { status, value: status === 'ok' ? state.record : null }; };
  return Object.assign(state, {
    readState: st,
    read: (n, f) => { const r = st(); return r.status === 'ok' ? r.value : f; },
    write: (n, v) => { state.writes.push(v); state.record = v; },
    update: () => { throw new Error('update would read the file a second time'); },
  });
}

test('F3 residual: the new record is built from the ONE read that passed the gate', async () => {
  const store = seqStore(['ok', 'unreadable'], { imagesEnabled: false });
  const { call } = setup(store);
  assert.strictEqual(await call(NAMES_SET_CHANNEL, 'name'), 'name');
  assert.deepStrictEqual(store.writes, [{ imagesEnabled: false, rosterNames: 'name' }]);
  const store2 = seqStore(['ok', 'unreadable'], { rosterNames: 'name' });
  assert.strictEqual(await setup(store2).call('avatar:setImagesEnabled', false), false);
  assert.deepStrictEqual(store2.writes, [{ rosterNames: 'name', imagesEnabled: false }]);
});

test('#2: a CORRUPT record is repaired by the click, and both toggles work after', async () => {
  const store = seqStore(['corrupt', 'ok', 'ok'], null);
  const { call, sent } = setup(store);
  assert.strictEqual(await call(NAMES_SET_CHANNEL, 'name'), 'name');
  assert.deepStrictEqual(store.writes, [{ rosterNames: 'name' }]);
  assert.strictEqual(await call('avatar:setImagesEnabled', false), false);
  assert.deepStrictEqual(store.writes[1], { rosterNames: 'name', imagesEnabled: false });
  assert.deepStrictEqual(sent, [[NAMES_PUSH_CHANNEL, 'name'], [PUSH_CHANNEL, false]]);
});

test('#2: an UNREADABLE record is retried once, and saved if the lock has gone', async () => {
  const store = seqStore(['unreadable', 'ok'], { imagesEnabled: false });
  const { call } = setup(store);
  assert.strictEqual(await call(NAMES_SET_CHANNEL, 'name'), 'name');
  assert.deepStrictEqual(store.writes, [{ imagesEnabled: false, rosterNames: 'name' }]);
});

test('#2: unreadable twice is refused: nothing written, nothing pushed, answered null', async () => {
  const store = seqStore(['unreadable'], { imagesEnabled: false });
  const { call, sent } = setup(store);
  assert.strictEqual(await call(NAMES_SET_CHANNEL, 'name'), null);
  assert.strictEqual(await call('avatar:setImagesEnabled', true), null);
  assert.deepStrictEqual(store.writes, []);
  assert.deepStrictEqual(sent, []);
});

test('F3: a missing record is fine to write, and a good one keeps the other field', () => {
  const missing = { read: (n, f) => f, readState: () => ({ status: 'missing' }), update: (n, f, fn) => { missing.out = fn(f); } };
  assert.strictEqual(setup(missing).call(NAMES_SET_CHANNEL, 'name'), 'name');
  assert.deepStrictEqual(missing.out, { rosterNames: 'name' });
  const ok = stateStore({ imagesEnabled: false });
  assert.strictEqual(setup(ok).call(NAMES_SET_CHANNEL, 'name'), 'name');
  assert.deepStrictEqual(ok.data[AVATAR_KEY], { imagesEnabled: false, rosterNames: 'name' });
  assert.strictEqual(setup(ok).call('avatar:setImagesEnabled', true), true);
  assert.deepStrictEqual(ok.data[AVATAR_KEY], { imagesEnabled: true, rosterNames: 'name' });
});

test('F4: the watcher takes both values from ONE read, so a failed names read cannot revert the mode', () => {
  let reads = 0;
  const store = {
    readState: () => ({ status: 'ok', value: { imagesEnabled: false, rosterNames: 'name' } }),
    // a second, separate read would fail like an EBUSY and answer the fallback
    read: () => { reads++; return {}; },
  };
  const sent = [];
  const l = [];
  const sync = { last: false, lastNames: 'name' };
  watchImagesEnabled({
    store, file: 'f', win: { webContents: { send: (ch, v) => sent.push([ch, v]) } }, sync,
    watchFile: (f, o, fn) => l.push(fn), unwatchFile: () => {},
  });
  sync.last = false; sync.lastNames = 'name';
  l[0]();
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(sync.lastNames, 'name');
});

test('F4: an unreadable poll pushes nothing for either value', () => {
  const store = { readState: () => ({ status: 'unreadable' }), read: () => ({}) };
  const sent = [];
  const l = [];
  watchImagesEnabled({
    store, file: 'f', win: { webContents: { send: (ch, v) => sent.push([ch, v]) } }, sync: { last: false, lastNames: 'name' },
    watchFile: (f, o, fn) => l.push(fn), unwatchFile: () => {},
  });
  l[0]();
  assert.deepStrictEqual(sent, []);
});
