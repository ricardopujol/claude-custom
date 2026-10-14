'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  registerFontHandlers, createFontLister, FONT_NAMES, GET_CHANNEL, SET_CHANNEL, LIST_CHANNEL, PUSH_CHANNEL,
} = require('../app/fonts-bridge');

function fakeIpc() {
  const handlers = new Map();
  return { handle: (ch, fn) => handlers.set(ch, fn), call: (ch, e, ...a) => handlers.get(ch)(e, ...a), handlers };
}
function fakeStore(initial) {
  let value = initial;
  return {
    read: (k, fb) => (value === undefined ? fb : value),
    readState: () => (value === undefined ? { status: 'missing' } : { status: 'ok', value }),
    update: (k, fb, fn) => { value = fn(value === undefined ? fb : value); },
    get value() { return value; },
  };
}
const view = { id: 'view' };
const isSender = (s) => s === view;

test('get answers the stored settings, sanitized, to a view and nothing to a stranger', async () => {
  const ipc = fakeIpc();
  registerFontHandlers({ ipcMain: ipc, store: fakeStore({ terminalFont: 'Fira Code', terminalSize: 99, uiFont: 'a;b' }), isSender, send() {}, lister: { list: async () => [] } });
  assert.deepStrictEqual(ipc.call(GET_CHANNEL, { sender: view }), { status: 'ok', settings: { terminalFont: 'Fira Code', terminalSize: 24, uiFont: null } });
  assert.strictEqual(ipc.call(GET_CHANNEL, { sender: {} }), null);
});

test('get on a missing record answers the unset defaults', () => {
  const ipc = fakeIpc();
  registerFontHandlers({ ipcMain: ipc, store: fakeStore(undefined), isSender, send() {}, lister: { list: async () => [] } });
  assert.deepStrictEqual(ipc.call(GET_CHANNEL, { sender: view }),
    { status: 'missing', settings: { terminalFont: null, terminalSize: null, uiFont: null } });
});

test('set sanitizes before it saves, pushes to every view and remembers what it told them', () => {
  const ipc = fakeIpc();
  const store = fakeStore(undefined);
  const sent = [];
  const sync = {};
  registerFontHandlers({ ipcMain: ipc, store, sync, isSender, send: (ch, v) => sent.push([ch, v]), lister: { list: async () => [] } });
  const saved = ipc.call(SET_CHANNEL, { sender: view }, { terminalFont: 'Fira Code', terminalSize: 3, uiFont: 'x"y', junk: 1 });
  assert.deepStrictEqual(saved, { terminalFont: 'Fira Code', terminalSize: 10, uiFont: null });
  assert.deepStrictEqual(store.value, saved);
  assert.deepStrictEqual(sent, [[PUSH_CHANNEL, saved]]);
  assert.strictEqual(sync.last, JSON.stringify(saved));
});

test('set refuses a stranger, a non-object and a store that throws', () => {
  const ipc = fakeIpc();
  const store = fakeStore(undefined);
  registerFontHandlers({ ipcMain: ipc, store, isSender, send() {}, lister: { list: async () => [] } });
  assert.strictEqual(ipc.call(SET_CHANNEL, { sender: {} }, { uiFont: 'Inter' }), null);
  for (const bad of [null, 'x', 4, [], undefined]) assert.strictEqual(ipc.call(SET_CHANNEL, { sender: view }, bad), null);
  assert.strictEqual(store.value, undefined);
  const boom = { ...fakeStore(undefined), update() { throw new Error('disk'); } };
  const ipc2 = fakeIpc();
  registerFontHandlers({ ipcMain: ipc2, store: boom, isSender, send() {}, lister: { list: async () => [] } });
  assert.strictEqual(ipc2.call(SET_CHANNEL, { sender: view }, { uiFont: 'Inter' }), null);
});

test('list answers the installed families to a view only', async () => {
  const ipc = fakeIpc();
  registerFontHandlers({ ipcMain: ipc, store: fakeStore(undefined), isSender, send() {}, lister: { list: async () => ['Arial', 'Consolas'] } });
  assert.deepStrictEqual(await ipc.call(LIST_CHANNEL, { sender: view }), { ok: true, families: ['Arial', 'Consolas'] });
  assert.strictEqual(await ipc.call(LIST_CHANNEL, { sender: {} }), null);
});

test('list says so when the enumeration fails, instead of answering an empty list as if nothing were installed', async () => {
  const ipc = fakeIpc();
  registerFontHandlers({ ipcMain: ipc, store: fakeStore(undefined), isSender, send() {}, lister: { list: async () => { throw new Error('no powershell'); } } });
  const r = await ipc.call(LIST_CHANNEL, { sender: view });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no powershell/);
});

test('the lister runs the platform command once per window of time and parses its output', async () => {
  let calls = 0;
  let now = 1000;
  const lister = createFontLister({
    platform: 'win32', now: () => now, ttlMs: 30000,
    run: async (cmd, args) => { calls += 1; assert.match(cmd, /powershell/i); assert.ok(args.join(' ').includes('InstalledFontCollection')); return 'Zed\nArial\n@V\nArial\n'; },
  });
  assert.deepStrictEqual(await lister.list(), ['Arial', 'Zed']);
  assert.deepStrictEqual(await lister.list(), ['Arial', 'Zed']);
  assert.strictEqual(calls, 1, 'cached inside the window');
  now += 31000;
  await lister.list();
  assert.strictEqual(calls, 2, 'fonts installed later appear after the window');
});

test('the lister does not cache a failure, and shares one in-flight enumeration', async () => {
  let calls = 0;
  let fail = true;
  const lister = createFontLister({
    platform: 'win32', now: () => 0,
    run: async () => { calls += 1; if (fail) throw new Error('x'); return 'A\n'; },
  });
  await assert.rejects(lister.list(), /x/);
  fail = false;
  const [a, b] = await Promise.all([lister.list(), lister.list()]);
  assert.deepStrictEqual(a, ['A']);
  assert.deepStrictEqual(b, ['A']);
  assert.strictEqual(calls, 2, 'one failed call, then one shared call');
});

test('on other platforms the lister asks fc-list and takes the first name of each line', async () => {
  const lister = createFontLister({
    platform: 'linux', now: () => 0,
    run: async (cmd, args) => { assert.strictEqual(cmd, 'fc-list'); return 'DejaVu Sans,DejaVu Sans Light\nNoto Mono\n'; },
  });
  assert.deepStrictEqual(await lister.list(), ['DejaVu Sans', 'Noto Mono']);
});

test('FONT_NAMES matches the channels the module exports (watchLayout reads key and push from it)', () => {
  assert.strictEqual(FONT_NAMES.key, 'fonts-global');
  assert.strictEqual(FONT_NAMES.push, PUSH_CHANNEL);
});

test('main registers the fonts bridge for the tab views and follows other windows; the preload exposes the same channels', () => {
  const fs = require('fs');
  const path = require('path');
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
  assert.match(MAIN, /registerFontHandlers\(\{ ipcMain, store: uiStore, sync: fontsSync, isSender: isTabView, send: pushToViews \}\)/);
  assert.match(MAIN, /names: FONT_NAMES/);
  assert.match(MAIN, /`\$\{FONT_NAMES\.key\}\.json`/);
  for (const ch of [GET_CHANNEL, SET_CHANNEL, LIST_CHANNEL]) assert.ok(PRELOAD.includes(`invoke('${ch}'`), ch);
  assert.ok(PRELOAD.includes(`on('${PUSH_CHANNEL}'`));
});
