'use strict';
/**
 * BACKLOG #211: the dock layout is each project's own, not one install-wide record every window follows.
 * app/project-layout-store.js is the store the layout bridge reads and writes: the project's own
 * `<project>\.claude-custom\` first, the install-wide file only as the first-open default.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../host/store');
const { registerLayoutHandlers, watchLayout, LAYOUT_KEY, TREE_NAMES, GET_CHANNEL, SET_CHANNEL } = require('../app/layout-bridge');
const { createProjectLayoutStore } = require('../app/project-layout-store');

const VIEW = {};
const TREE_A = { version: 2, tree: 'A' };
const TREE_B = { version: 2, tree: 'B' };
const GLOBAL_TREE = { version: 2, tree: 'GLOBAL' };

function tmp() { return require('./tmp-dir').tmpDir('plstore-'); }

// One project window: its own ipc, its own pushes, the shared install-wide store under it.
function window_(globalStore, projectDir, opts = {}) {
  const handlers = new Map();
  const sent = [];
  const store = createProjectLayoutStore({
    project: createStore({ dir: projectDir }), fallback: globalStore, prepare: opts.prepare,
  });
  const sync = {};
  registerLayoutHandlers({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store, sync, names: TREE_NAMES,
    isSender: (s) => s === VIEW, send: (ch, v) => sent.push([ch, v]),
  });
  return { store, sent, sync, projectDir, call: (ch, ...a) => handlers.get(ch)({ sender: VIEW }, ...a) };
}

test('a project with no layout of its own starts from the install-wide one', async () => {
  const globalStore = createStore({ dir: tmp() });
  globalStore.write(TREE_NAMES.key, GLOBAL_TREE);
  const a = window_(globalStore, tmp());
  assert.deepStrictEqual(await a.call(TREE_NAMES.get), { status: 'ok', layout: GLOBAL_TREE });
});

test('nothing anywhere still reads as missing, so the page migrates once', async () => {
  const a = window_(createStore({ dir: tmp() }), tmp());
  assert.deepStrictEqual(await a.call(TREE_NAMES.get), { status: 'missing', layout: null });
});

test('a change in one project leaves the other project\'s layout as it was', async () => {
  const globalStore = createStore({ dir: tmp() });
  globalStore.write(TREE_NAMES.key, GLOBAL_TREE);
  const a = window_(globalStore, tmp());
  const b = window_(globalStore, tmp());
  assert.deepStrictEqual(await a.call(TREE_NAMES.set, TREE_A), TREE_A);
  assert.deepStrictEqual(await a.call(TREE_NAMES.get), { status: 'ok', layout: TREE_A });
  assert.deepStrictEqual(await b.call(TREE_NAMES.get), { status: 'ok', layout: GLOBAL_TREE }, 'B never followed A');
  assert.deepStrictEqual(globalStore.read(TREE_NAMES.key, null), GLOBAL_TREE, 'the install-wide file is only a default, never written');
  assert.deepStrictEqual(await b.call(TREE_NAMES.set, TREE_B), TREE_B);
  assert.deepStrictEqual(await a.call(TREE_NAMES.get), { status: 'ok', layout: TREE_A }, 'A kept its own');
});

test('the layout is kept in the project\'s own folder and survives a new window', async () => {
  const globalStore = createStore({ dir: tmp() });
  const dir = tmp();
  await window_(globalStore, dir).call(TREE_NAMES.set, TREE_A);
  assert.ok(fs.existsSync(path.join(dir, `${TREE_NAMES.key}.json`)));
  assert.deepStrictEqual(await window_(globalStore, dir).call(TREE_NAMES.get), { status: 'ok', layout: TREE_A });
});

test('the older global-layout key is per project too', async () => {
  const globalStore = createStore({ dir: tmp() });
  const a = window_(globalStore, tmp());
  const one = { version: 1, zones: { right: ['agents'] } };
  const handlers = new Map();
  registerLayoutHandlers({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store: a.store, sync: {}, isSender: (s) => s === VIEW, send: () => {} });
  await handlers.get(SET_CHANNEL)({ sender: VIEW }, one);
  assert.deepStrictEqual(globalStore.read(LAYOUT_KEY, null), null);
  assert.deepStrictEqual(await handlers.get(GET_CHANNEL)({ sender: VIEW }), { status: 'ok', layout: one });
});

test('a corrupt project file is said so, never papered over by the install-wide default', async () => {
  const globalStore = createStore({ dir: tmp() });
  globalStore.write(TREE_NAMES.key, GLOBAL_TREE);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, `${TREE_NAMES.key}.json`), '{ not json');
  const a = window_(globalStore, dir);
  assert.strictEqual((await a.call(TREE_NAMES.get)).status, 'corrupt');
});

test('the project\'s folder is prepared before a write (the look folder\'s guard), and a refusal saves nothing', async () => {
  const globalStore = createStore({ dir: tmp() });
  const dir = tmp();
  let prepared = 0;
  const a = window_(globalStore, dir, { prepare: () => { prepared += 1; } });
  await a.call(TREE_NAMES.set, TREE_A);
  assert.strictEqual(prepared, 1);
  const refused = window_(globalStore, tmp(), { prepare: () => { throw new Error('link'); } });
  const origError = console.error; console.error = () => {};
  try { assert.strictEqual(await refused.call(TREE_NAMES.set, TREE_A), null); } finally { console.error = origError; }
  assert.strictEqual(refused.store.read(TREE_NAMES.key, null), null);
});

test('the watcher follows the project\'s own file only: another project\'s change is never pushed', () => {
  const globalStore = createStore({ dir: tmp() });
  const dirA = tmp();
  const a = window_(globalStore, dirA);
  const b = window_(globalStore, tmp());
  // A fake file watcher that behaves like fs.watchFile: a change to a file fires only the listeners registered FOR THAT FILE.
  const watched = new Map();
  const watchFile = (f, _o, fn) => { watched.set(f, [...(watched.get(f) || []), fn]); };
  const touch = (f) => { for (const fn of watched.get(f) || []) fn(); };
  const sentToA = [];
  const stop = watchLayout({
    store: a.store, sync: a.sync, names: TREE_NAMES, send: (ch, v) => sentToA.push([ch, v]),
    file: a.store.pathOf(TREE_NAMES.key), watchFile, unwatchFile: (f, fn) => { watched.set(f, (watched.get(f) || []).filter(x => x !== fn)); },
  });
  assert.notStrictEqual(a.store.pathOf(TREE_NAMES.key), b.store.pathOf(TREE_NAMES.key), 'two projects, two files');
  assert.ok(a.store.pathOf(TREE_NAMES.key).startsWith(dirA), "A's watched file is inside A's own folder");
  b.store.write(TREE_NAMES.key, TREE_B);          // another project's window saves its own file, and the OS reports that file
  touch(b.store.pathOf(TREE_NAMES.key));
  assert.deepStrictEqual(sentToA, [], "A's window was not told");
  a.store.write(TREE_NAMES.key, TREE_A);          // another window of THIS project saves
  touch(a.store.pathOf(TREE_NAMES.key));
  assert.deepStrictEqual(sentToA, [[TREE_NAMES.push, TREE_A]]);
  stop();
  assert.deepStrictEqual(watched.get(a.store.pathOf(TREE_NAMES.key)), [], 'stopping takes the listener off');
});

test('a .claude-custom that is a link elsewhere is not read through: the page is told unreadable and the install-wide default does not stand in (Miguel G5)', async () => {
  const globalStore = createStore({ dir: tmp() });
  globalStore.write(TREE_NAMES.key, GLOBAL_TREE);
  const logs = [];
  const store = createProjectLayoutStore({ project: createStore({ dir: tmp() }), fallback: globalStore, usable: () => false, log: (m) => logs.push(m) });
  assert.strictEqual(store.readState(TREE_NAMES.key).status, 'unreadable');
  assert.strictEqual(store.read(TREE_NAMES.key, 'dflt'), 'dflt');
  assert.ok(logs.length > 0 && /link/.test(logs[0]), 'and says why');
  const fine = createProjectLayoutStore({ project: createStore({ dir: tmp() }), fallback: globalStore, usable: () => true });
  assert.strictEqual(fine.readState(TREE_NAMES.key).status, 'ok', 'a usable folder reads as before');
});

test('main.js gives the store the same foreign-folder guard for reading that prepare gives for writing', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  assert.match(MAIN, /createProjectLayoutStore\(\{[\s\S]{0,300}usable: \(\) => lookDirState\(STATE_ROOT, fs\) !== 'foreign'/);
});
