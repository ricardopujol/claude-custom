'use strict';
/**
 * Main's side of model favourites: a star persisted GLOBALLY, gated to the
 * one window it was registered for, same boundary shape as every other
 * main-process handler.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  readFavourites, registerFavouriteHandlers, FAVOURITES_KEY, GET_CHANNEL, SET_CHANNEL,
} = require('../app/favourites-bridge');

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}

// A minimal stand-in for host/store.js's createStore() shape: read/update
// backed by an in-memory object, so these tests exercise the bridge's LOGIC
// without touching a real file.
function fakeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    update: (name, fallback, fn) => { data[name] = fn(name in data ? data[name] : fallback); return data[name]; },
  };
}

// --- readFavourites -------------------------------------------------------------

test('readFavourites answers the empty shape when nothing has been saved', () => {
  assert.deepStrictEqual(readFavourites(fakeStore()), { openrouter: [], claude: [] });
});

test('readFavourites normalizes whatever the store handed back', () => {
  const store = fakeStore({ [FAVOURITES_KEY]: { openrouter: ['a/b', 'a/b'], claude: 'not-an-array' } });
  assert.deepStrictEqual(readFavourites(store), { openrouter: ['a/b'], claude: [] });
});

test('readFavourites degrades to empty rather than throwing when the store itself throws', () => {
  const store = { read: () => { throw new Error('disk gone'); } };
  assert.deepStrictEqual(readFavourites(store), { openrouter: [], claude: [] });
});

// --- registerFavouriteHandlers ----------------------------------------------------

test('the handler answers the window it was registered for', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore({ [FAVOURITES_KEY]: { openrouter: ['a/b'], claude: [] } });
  registerFavouriteHandlers({ ipcMain, store, win });

  const get = ipcMain.handlers.get(GET_CHANNEL);
  assert.strictEqual(typeof get, 'function');
  assert.deepStrictEqual(await get({ sender: win.webContents }), { openrouter: ['a/b'], claude: [] });
});

test('any other sender gets the empty shape, never the real favourites', () => {
  // Same fromWindow gate as clipboard-bridge.js / secrets:* in main.js: a
  // handler that answers anyone is not a boundary.
  const ipcMain = fakeIpc();
  const store = fakeStore({ [FAVOURITES_KEY]: { openrouter: ['a/b'], claude: [] } });
  registerFavouriteHandlers({ ipcMain, store, win: { webContents: {} } });
  const r = ipcMain.handlers.get(GET_CHANNEL)({ sender: {} });
  assert.deepStrictEqual(r, { openrouter: [], claude: [] });
});

test('set persists through the store and returns the new value', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win });

  const set = ipcMain.handlers.get(SET_CHANNEL);
  const added = await set({ sender: win.webContents }, 'openrouter', 'a/b', true);
  assert.deepStrictEqual(added, { openrouter: ['a/b'], claude: [] });
  assert.deepStrictEqual(store.data[FAVOURITES_KEY], { openrouter: ['a/b'], claude: [] });

  const removed = await set({ sender: win.webContents }, 'openrouter', 'a/b', false);
  assert.deepStrictEqual(removed, { openrouter: [], claude: [] });
});

// Dexter, PR #60 review, Finding 6 -- THE regression this channel exists to
// fix. A toggle computed against the store's CURRENT value inverts the
// user's intent the moment a second window's view is stale; sending the
// desired state must not.
test('F6: setting "on" a SECOND time (another window already starred it) is a no-op, never an un-star', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore({ [FAVOURITES_KEY]: { openrouter: ['google/gemini-2.5-pro'], claude: [] } });
  registerFavouriteHandlers({ ipcMain, store, win });

  // Window B's click intends "star this model" (on=true), even though it has
  // no idea window A already starred it -- the store already holds it.
  const set = ipcMain.handlers.get(SET_CHANNEL);
  const result = await set({ sender: win.webContents }, 'openrouter', 'google/gemini-2.5-pro', true);
  assert.deepStrictEqual(result, { openrouter: ['google/gemini-2.5-pro'], claude: [] },
    'the favourite must survive -- a toggle here would have removed it');
  assert.deepStrictEqual(store.data[FAVOURITES_KEY], { openrouter: ['google/gemini-2.5-pro'], claude: [] });
});

test('set from an unauthorized sender writes nothing and returns null', async () => {
  const ipcMain = fakeIpc();
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win: { webContents: {} } });

  const result = await ipcMain.handlers.get(SET_CHANNEL)({ sender: {} }, 'openrouter', 'a/b', true);
  assert.strictEqual(result, null);
  assert.strictEqual(store.data[FAVOURITES_KEY], undefined);
});

test('set refuses an unknown kind or a non-string id, and writes nothing', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win });
  const set = ipcMain.handlers.get(SET_CHANNEL);

  assert.strictEqual(await set({ sender: win.webContents }, 'ollama', 'a/b', true), null);
  assert.strictEqual(await set({ sender: win.webContents }, 'openrouter', null, true), null);
  assert.strictEqual(await set({ sender: win.webContents }, 'openrouter', '', true), null);
  assert.strictEqual(store.data[FAVOURITES_KEY], undefined);
});

// Dexter, PR #60 round 2, N5: `on` was truth-coerced, so the STRING 'false'
// (truthy) starred the model -- the exact opposite of the literal value sent.
test('N5: set refuses a non-boolean `on`, and writes nothing', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win });
  const set = ipcMain.handlers.get(SET_CHANNEL);

  assert.strictEqual(await set({ sender: win.webContents }, 'openrouter', 'a/b', 'false'), null,
    'the string "false" must not be coerced into true');
  assert.strictEqual(await set({ sender: win.webContents }, 'openrouter', 'a/b', 1), null);
  assert.strictEqual(await set({ sender: win.webContents }, 'openrouter', 'a/b', null), null);
  assert.strictEqual(await set({ sender: win.webContents }, 'openrouter', 'a/b', undefined), null);
  assert.strictEqual(store.data[FAVOURITES_KEY], undefined, 'nothing must have been written');
});

test('a store whose update throws answers null rather than crashing the handler', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = { read: () => ({}), update: () => { throw new Error('EPERM'); } };
  registerFavouriteHandlers({ ipcMain, store, win });
  const result = await ipcMain.handlers.get(SET_CHANNEL)({ sender: win.webContents }, 'openrouter', 'a/b', true);
  assert.strictEqual(result, null);
});

// --- wiring: the preload invokes these channels, main.js registers them ----------

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const app = (f) => strip(fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8'));

test('the preload invokes both channels this module handles', () => {
  const preload = app('preload.js');
  assert.ok(preload.includes(`ipcRenderer.invoke('${GET_CHANNEL}')`), `preload.js must invoke '${GET_CHANNEL}'`);
  assert.ok(preload.includes(`ipcRenderer.invoke('${SET_CHANNEL}'`), `preload.js must invoke '${SET_CHANNEL}'`);
});

test('the preload sends the desired state, not a bare toggle -- no favourites:toggle channel remains', () => {
  const preload = app('preload.js');
  assert.ok(!preload.includes("'favourites:toggle'"), 'the toggle channel must be fully retired, not left dangling');
});

test('main.js actually registers the handlers, against its own uiStore and window', () => {
  const main = app('main.js');
  assert.match(main, /require\(['"]\.\/favourites-bridge['"]\)/);
  assert.match(main, /registerFavouriteHandlers\(\s*\{[^}]*ipcMain[^}]*store[^}]*win[^}]*\}\s*\)/);
});

test('main.js does not widen look:setDim into a generic store-key setter', () => {
  // BACKLOG E #5's own instruction: a generic "set arbitrary key" handler
  // reachable from the page could overwrite look-global itself. Favourites
  // gets its OWN channel (favourites:*) instead of widening this one.
  const main = app('main.js');
  const start = main.indexOf("ipcMain.handle('look:setDim'");
  assert.ok(start !== -1, 'precondition: look:setDim must still exist');
  const body = main.slice(start, main.indexOf('\n  });', start));
  assert.match(body, /uiStore\.update\(UI_KEY,/,
    'look:setDim must still write its own fixed UI_KEY literal, not a caller-supplied key');
});

// --- a window made of tab views (worktree tabs): the gate is a predicate -----

test('with isSender, both channels answer any of the window\'s views and nobody else', async () => {
  const ipcMain = fakeIpc();
  const store = fakeStore();
  const view = { id: 'v' };
  registerFavouriteHandlers({ ipcMain, store, win: { webContents: { id: 'strip' } }, isSender: (s) => s === view });
  const set = await ipcMain.handlers.get(SET_CHANNEL)({ sender: view }, 'openrouter', 'a/b', true);
  assert.deepStrictEqual(set.openrouter, ['a/b']);
  assert.deepStrictEqual((await ipcMain.handlers.get(GET_CHANNEL)({ sender: view })).openrouter, ['a/b']);
  assert.strictEqual(await ipcMain.handlers.get(SET_CHANNEL)({ sender: { id: 'strip' } }, 'openrouter', 'c/d', true), null);
  assert.deepStrictEqual(await ipcMain.handlers.get(GET_CHANNEL)({ sender: {} }), { openrouter: [], claude: [] });
});
