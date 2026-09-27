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
  readFavourites, registerFavouriteHandlers, FAVOURITES_KEY, GET_CHANNEL, TOGGLE_CHANNEL,
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

test('toggle persists through the store and returns the new value', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win });

  const toggle = ipcMain.handlers.get(TOGGLE_CHANNEL);
  const added = await toggle({ sender: win.webContents }, 'openrouter', 'a/b');
  assert.deepStrictEqual(added, { openrouter: ['a/b'], claude: [] });
  assert.deepStrictEqual(store.data[FAVOURITES_KEY], { openrouter: ['a/b'], claude: [] });

  const removed = await toggle({ sender: win.webContents }, 'openrouter', 'a/b');
  assert.deepStrictEqual(removed, { openrouter: [], claude: [] });
});

test('toggle from an unauthorized sender writes nothing and returns null', async () => {
  const ipcMain = fakeIpc();
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win: { webContents: {} } });

  const result = await ipcMain.handlers.get(TOGGLE_CHANNEL)({ sender: {} }, 'openrouter', 'a/b');
  assert.strictEqual(result, null);
  assert.strictEqual(store.data[FAVOURITES_KEY], undefined);
});

test('toggle refuses an unknown kind or a non-string id, and writes nothing', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = fakeStore();
  registerFavouriteHandlers({ ipcMain, store, win });
  const toggle = ipcMain.handlers.get(TOGGLE_CHANNEL);

  assert.strictEqual(await toggle({ sender: win.webContents }, 'ollama', 'a/b'), null);
  assert.strictEqual(await toggle({ sender: win.webContents }, 'openrouter', null), null);
  assert.strictEqual(await toggle({ sender: win.webContents }, 'openrouter', ''), null);
  assert.strictEqual(store.data[FAVOURITES_KEY], undefined);
});

test('a store whose update throws answers null rather than crashing the handler', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const store = { read: () => ({}), update: () => { throw new Error('EPERM'); } };
  registerFavouriteHandlers({ ipcMain, store, win });
  const result = await ipcMain.handlers.get(TOGGLE_CHANNEL)({ sender: win.webContents }, 'openrouter', 'a/b');
  assert.strictEqual(result, null);
});

// --- wiring: the preload invokes these channels, main.js registers them ----------

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const app = (f) => strip(fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8'));

test('the preload invokes both channels this module handles', () => {
  const preload = app('preload.js');
  assert.ok(preload.includes(`ipcRenderer.invoke('${GET_CHANNEL}')`), `preload.js must invoke '${GET_CHANNEL}'`);
  assert.ok(preload.includes(`ipcRenderer.invoke('${TOGGLE_CHANNEL}'`), `preload.js must invoke '${TOGGLE_CHANNEL}'`);
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
