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
  MAX_LAYOUT_BYTES, TREE_NAMES,
} = require('../app/layout-bridge');

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}
function fakeStore(seed = {}, states = {}) {
  const data = { ...seed };
  const store = {
    data,
    writes: 0,
    locked: 0,                         // how deep inside withLock we are: a write outside it is a lost-update risk
    wroteUnlocked: 0,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    update: (name, fallback, fn) => { data[name] = fn(name in data ? data[name] : fallback); return data[name]; },
    write: (name, value) => { store.writes += 1; if (!store.locked) store.wroteUnlocked += 1; data[name] = JSON.parse(JSON.stringify(value)); return value; },
    withLock: (name, fn) => { store.locked += 1; try { return fn(); } finally { store.locked -= 1; } },
    // Shaped like host/store.js readState: the value comes with `ok`.
    readState: name => states[name] || (name in data ? { status: 'ok', value: data[name] } : { status: 'missing', value: null }),
  };
  return store;
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

test('get answers the stored layout to a tab view, with the store\'s status', async () => {
  const { call } = setup(fakeStore({ [LAYOUT_KEY]: LAYOUT }));
  assert.deepStrictEqual(await call(GET_CHANNEL), { status: 'ok', layout: LAYOUT });
});

test('get says MISSING only when there is no file -- the one answer that lets the page migrate', async () => {
  const { call } = setup(fakeStore());
  assert.deepStrictEqual(await call(GET_CHANNEL), { status: 'missing', layout: null });
});

test('PR #82 Dexter F3 / Miguel I1: an unreadable or corrupt file is NOT missing', async () => {
  // Antivirus holding the file (EBUSY) at launch read as "nothing saved", and
  // the page's migration then overwrote the user's real global layout.
  for (const status of ['unreadable', 'corrupt']) {
    const { call } = setup(fakeStore({ [LAYOUT_KEY]: LAYOUT }, { [LAYOUT_KEY]: { status, value: null } }));
    assert.deepStrictEqual(await call(GET_CHANNEL), { status, layout: null }, status);
  }
  const { call } = setup(fakeStore({ [LAYOUT_KEY]: [1, 2] }));
  assert.deepStrictEqual(await call(GET_CHANNEL), { status: 'corrupt', layout: null }, 'ok JSON that is not a layout');
  const throwing = setup({ readState: () => { throw new Error('disk'); }, read: () => { throw new Error('disk'); } });
  assert.deepStrictEqual(await throwing.call(GET_CHANNEL), { status: 'unreadable', layout: null });
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

// --- the tree layout: the same bridge under its own names (dockable panels D1) ----

test('TREE_NAMES is its own key and its own channels, none of them the L1 ones', () => {
  assert.deepStrictEqual(TREE_NAMES, { key: 'layout-tree', get: 'layout-tree:get', set: 'layout-tree:set', push: 'layout-tree' });
  assert.notStrictEqual(TREE_NAMES.key, LAYOUT_KEY);
  assert.notStrictEqual(TREE_NAMES.get, GET_CHANNEL);
  assert.notStrictEqual(TREE_NAMES.set, SET_CHANNEL);
  assert.notStrictEqual(TREE_NAMES.push, PUSH_CHANNEL);
});

function treeSetup(store = fakeStore()) {
  const sent = [];
  const ipcMain = fakeIpc();
  const sync = {};
  registerLayoutHandlers({
    ipcMain, store, sync, names: TREE_NAMES, isSender: s => s === VIEW, send: (ch, v) => sent.push([ch, v]),
  });
  const call = (ch, ...args) => ipcMain.handlers.get(ch)({ sender: VIEW }, ...args);
  return { ipcMain, store, sent, call, sync };
}
const TREE = { version: 2, root: { type: 'term' }, floats: [], hidden: [], seat: {} };

test('named for the tree, the handlers sit on the tree channels and not on the L1 ones', () => {
  const { ipcMain } = treeSetup();
  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [TREE_NAMES.get, TREE_NAMES.set].sort());
});

test('a set on the tree channel stores under the tree key, pushes on the tree channel, and never touches layout-global', async () => {
  const { call, store, sent, sync } = treeSetup(fakeStore({ [LAYOUT_KEY]: LAYOUT }));
  assert.deepStrictEqual(await call(TREE_NAMES.set, TREE), TREE);
  assert.deepStrictEqual(store.data[TREE_NAMES.key], TREE);
  assert.deepStrictEqual(store.data[LAYOUT_KEY], LAYOUT, 'the L1 record is byte-for-byte what it was');
  assert.deepStrictEqual(sent, [[TREE_NAMES.push, TREE]]);
  assert.strictEqual(sync.last, JSON.stringify(TREE));
});

test('a get on the tree channel reads the tree key, with the store\'s status', async () => {
  const { call } = treeSetup(fakeStore({ [LAYOUT_KEY]: LAYOUT }));
  assert.deepStrictEqual(await call(TREE_NAMES.get), { status: 'missing', layout: null }, 'the L1 record is not the tree');
  const both = treeSetup(fakeStore({ [LAYOUT_KEY]: LAYOUT, [TREE_NAMES.key]: TREE }));
  assert.deepStrictEqual(await both.call(TREE_NAMES.get), { status: 'ok', layout: TREE });
});

test('a corrupt tree file is corrupt, never missing (it must not be migrated over)', async () => {
  const { call } = treeSetup(fakeStore({ [TREE_NAMES.key]: LAYOUT }, { [TREE_NAMES.key]: { status: 'corrupt', value: null } }));
  assert.deepStrictEqual(await call(TREE_NAMES.get), { status: 'corrupt', layout: null });
});

test('a tree watcher follows the tree key and pushes on the tree channel; a change to layout-global says nothing to it', () => {
  const store = fakeStore({ [TREE_NAMES.key]: TREE, [LAYOUT_KEY]: LAYOUT });
  const sent = [];
  let listener = null;
  watchLayout({
    store, file: 'layout-tree.json', sync: {}, names: TREE_NAMES, send: (ch, v) => sent.push([ch, v]),
    watchFile: (_f, _o, fn) => { listener = fn; }, unwatchFile: () => {},
  });
  store.data[LAYOUT_KEY] = { version: 1, zones: { left: ['agents'] } };
  listener();
  assert.deepStrictEqual(sent, []);
  const next = { ...TREE, hidden: ['fog'] };
  store.data[TREE_NAMES.key] = next;
  listener();
  assert.deepStrictEqual(sent, [[TREE_NAMES.push, next]]);
});

// --- the preset list: the same bridge, an ARRAY under its own key (dockable panels D3) ----

const { PRESET_NAMES } = require('../app/layout-bridge');
const DOCK_PRESETS = require('../app/dock-presets');

function presetSetup(store = fakeStore()) {
  const sent = [];
  const ipcMain = fakeIpc();
  const sync = {};
  let n = 0;
  registerLayoutHandlers({
    ipcMain, store, sync, names: PRESET_NAMES, isSender: s => s === VIEW, send: (ch, v) => sent.push([ch, v]),
    newId: () => `n${++n}`,
  });
  const call = (ch, ...args) => ipcMain.handlers.get(ch)({ sender: VIEW }, ...args);
  return { ipcMain, store, sent, call, sync };
}
// Every preset carries an id (BACKLOG #59, test/dock-presets-identity.test.js); a new one gets n1, n2... here.
const PRESETS = [{ name: 'Reviewing', layout: TREE, id: 'r1' }, { name: 'Writing', layout: { ...TREE, hidden: ['fog'] }, id: 'w1' }];

test('PRESET_NAMES is its own key and channels, none of them the layout ones: a list read by `get`, changed only by `op`', () => {
  assert.deepStrictEqual(PRESET_NAMES, {
    key: 'layout-presets', get: 'layout-presets:get', op: 'layout-presets:op', push: 'layout-presets',
    shape: 'array',
  });
  for (const other of [{ key: LAYOUT_KEY, get: GET_CHANNEL, set: SET_CHANNEL, push: PUSH_CHANNEL }, TREE_NAMES]) {
    for (const f of ['key', 'get', 'push']) assert.notStrictEqual(PRESET_NAMES[f], other[f], f);
  }
});

test('the layout names keep their one-object rule and their 8192-byte cap: the shape is opt-in', () => {
  assert.strictEqual(TREE_NAMES.shape, undefined);
  assert.strictEqual(TREE_NAMES.maxBytes, undefined);
  assert.strictEqual(TREE_NAMES.op, undefined);
});

test('the presets register no whole-list `set`: the page can only say what the user did', () => {
  const { ipcMain } = presetSetup();
  assert.ok(ipcMain.handlers.has(PRESET_NAMES.get));
  assert.ok(ipcMain.handlers.has(PRESET_NAMES.op));
  assert.ok(!ipcMain.handlers.has('layout-presets:set'));
  assert.ok(setup().ipcMain.handlers.has(SET_CHANNEL), 'the layout keeps its own set');
});

const SAVE = (name, layout = TREE, extra = {}) => ({ op: 'save', name, layout, ...extra });

test('an op saves into the fresh list, pushes the new list to every view, and answers { ok, list }', async () => {
  const { call, store, sent, sync } = presetSetup(fakeStore({ [TREE_NAMES.key]: TREE, [PRESET_NAMES.key]: PRESETS }));
  const answer = await call(PRESET_NAMES.op, SAVE('Plan'));
  const want = [...PRESETS, { name: 'Plan', layout: TREE, id: 'n1' }];
  assert.deepStrictEqual(answer, { ok: true, list: want });
  assert.deepStrictEqual(store.data[PRESET_NAMES.key], want);
  assert.deepStrictEqual(store.data[TREE_NAMES.key], TREE, 'the tree record is untouched');
  assert.deepStrictEqual(sent, [[PRESET_NAMES.push, want]]);
  assert.strictEqual(sync.last, JSON.stringify(want), 'the watcher is told, so it doesn\'t push this window its own write');
});

test('rename and delete go through the same op channel', async () => {
  const { call, store } = presetSetup(fakeStore({ [PRESET_NAMES.key]: PRESETS }));
  assert.strictEqual((await call(PRESET_NAMES.op, { op: 'rename', name: 'reviewing', to: 'Docs' })).ok, true);
  assert.deepStrictEqual(store.data[PRESET_NAMES.key].map(p => p.name), ['Docs', 'Writing']);
  assert.strictEqual((await call(PRESET_NAMES.op, { op: 'delete', name: 'Writing' })).ok, true);
  assert.deepStrictEqual(store.data[PRESET_NAMES.key].map(p => p.name), ['Docs']);
  assert.deepStrictEqual((await call(PRESET_NAMES.op, { op: 'delete', name: 'Docs' })).list, [], 'deleting the last one is stored, not refused');
});

test('PR #103 Dexter 1: two windows, one store: a save in B does not erase what A saved, however stale B\'s copy is', async () => {
  const store = fakeStore({ [PRESET_NAMES.key]: [PRESETS[0]] });
  const A = {}; const B = {};
  const sentA = []; const sentB = [];
  const ipcMain = fakeIpc();
  // Two mains (two windows) share the one store file: each has its own handlers, sync and views.
  const mk = (view, sent) => {
    const ipc = fakeIpc();
    registerLayoutHandlers({ ipcMain: ipc, store, sync: {}, names: PRESET_NAMES, isSender: s => s === view, send: (ch, v) => sent.push([ch, v]) });
    return (...args) => ipc.handlers.get(PRESET_NAMES.op)({ sender: view }, ...args);
  };
  void ipcMain;
  const opA = mk(A, sentA);
  const opB = mk(B, sentB);
  assert.strictEqual((await opA(SAVE('Focus'))).ok, true);
  // B's poll was skipped (EBUSY), so B still believes the list is [Reviewing]; it saves Debug anyway.
  assert.strictEqual((await opB(SAVE('Debug'))).ok, true);
  assert.deepStrictEqual(store.data[PRESET_NAMES.key].map(p => p.name), ['Reviewing', 'Focus', 'Debug']);
  // and a delete in B of something A has since renamed away is a refusal, not a silent write
  assert.strictEqual((await opA({ op: 'rename', name: 'Focus', to: 'Focused' })).ok, true);
  assert.deepStrictEqual(await opB({ op: 'delete', name: 'Focus' }), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(store.data[PRESET_NAMES.key].map(p => p.name), ['Reviewing', 'Focused', 'Debug']);
});

test('every write is one read-modify-write inside the store\'s lock, on a fresh read', async () => {
  const store = fakeStore({ [PRESET_NAMES.key]: PRESETS });
  const reads = [];
  const readState = store.readState;
  store.readState = (name) => { reads.push(store.locked); return readState(name); };
  const { call } = presetSetup(store);
  await call(PRESET_NAMES.op, SAVE('One'));
  await call(PRESET_NAMES.op, SAVE('Two'));
  assert.strictEqual(store.writes, 2);
  assert.strictEqual(store.wroteUnlocked, 0, 'no write outside the lock');
  assert.deepStrictEqual(reads, [1, 1], 'each op read the file itself, inside the lock');
});

test('PR #103 Dexter 2: an unreadable, corrupt or non-list file is never written over, whatever this window thought', async () => {
  const cases = [
    { [PRESET_NAMES.key]: { status: 'unreadable', value: null } },
    { [PRESET_NAMES.key]: { status: 'corrupt', value: null } },
    { [PRESET_NAMES.key]: { status: 'error', value: null } },
    { [PRESET_NAMES.key]: { status: 'ok', value: { version: 2, presets: [] } } },
    { [PRESET_NAMES.key]: { status: 'ok', value: 'text' } },
  ];
  for (const states of cases) {
    const store = fakeStore({ [PRESET_NAMES.key]: PRESETS }, states);
    const { call, sent } = presetSetup(store);
    for (const req of [SAVE('Focus'), { op: 'rename', name: 'Reviewing', to: 'X' }, { op: 'delete', name: 'Reviewing' }]) {
      assert.deepStrictEqual(await call(PRESET_NAMES.op, req), { ok: false, reason: 'unreadable' }, JSON.stringify(states));
    }
    assert.strictEqual(store.writes, 0, 'the file is untouched');
    assert.deepStrictEqual(store.data[PRESET_NAMES.key], PRESETS);
    assert.deepStrictEqual(sent, []);
  }
});

test('with no file yet the first save starts the list; a read that throws is unreadable, not empty', async () => {
  const fresh = presetSetup();
  assert.deepStrictEqual((await fresh.call(PRESET_NAMES.op, SAVE('First'))).list.map(p => p.name), ['First']);
  const throwing = fakeStore({ [PRESET_NAMES.key]: PRESETS });
  throwing.readState = () => { throw new Error('disk'); };
  const t = presetSetup(throwing);
  assert.deepStrictEqual(await t.call(PRESET_NAMES.op, SAVE('X')), { ok: false, reason: 'unreadable' });
  assert.strictEqual(throwing.writes, 0);
});

test('a refused op answers its reason, writes nothing and pushes nothing', async () => {
  const { call, store, sent } = presetSetup(fakeStore({ [PRESET_NAMES.key]: PRESETS }));
  assert.deepStrictEqual(await call(PRESET_NAMES.op, SAVE('reviewing')), { ok: false, reason: 'taken' });
  assert.deepStrictEqual(await call(PRESET_NAMES.op, SAVE('')), { ok: false, reason: 'name' });
  assert.deepStrictEqual(await call(PRESET_NAMES.op, { op: 'delete', name: 'Nope' }), { ok: false, reason: 'missing' });
  for (const bad of [null, undefined, 'x', 7, [], {}, { op: 'set', list: [] }]) assert.deepStrictEqual(await call(PRESET_NAMES.op, bad), { ok: false, reason: 'op' }, JSON.stringify(bad));
  assert.strictEqual(store.writes, 0);
  assert.deepStrictEqual(sent, []);
});

test('nothing this build cannot use is erased: foreign entries and fields ride through an op', async () => {
  const stored = [{ name: 'Reviewing', layout: TREE, pinned: true }, 'junk', { name: 'x'.repeat(45), layout: TREE }, { shape: 'later' }];
  const { call, store } = presetSetup(fakeStore({ [PRESET_NAMES.key]: stored }));
  await call(PRESET_NAMES.op, SAVE('Plan'));
  // the stored preset with no id gets one beside its unknown field; what this build can't use gets none
  assert.deepStrictEqual(store.data[PRESET_NAMES.key], [{ ...stored[0], id: 'n1' }, ...stored.slice(1), { name: 'Plan', layout: TREE, id: 'n2' }]);
  await call(PRESET_NAMES.op, { op: 'rename', name: 'Reviewing', to: 'Looked at' });
  assert.deepStrictEqual(store.data[PRESET_NAMES.key][0], { name: 'Looked at', layout: TREE, pinned: true, id: 'n1' });
});

test('32 maximal presets, which the page\'s own rules allow, are stored: main\'s cap is the page\'s', async () => {
  const pad = 'x'.repeat(DOCK_PRESETS.MAX_PRESET_BYTES - '{"pad":""}'.length);
  const name = i => [...'\u{1F600}'.repeat(38)].join('') + String(10 + i);
  const stored = Array.from({ length: 31 }, (_, i) => ({ name: name(i), layout: { pad } }));
  const { call, store } = presetSetup(fakeStore({ [PRESET_NAMES.key]: stored }));
  const answer = await call(PRESET_NAMES.op, SAVE(name(31), { pad }));
  assert.strictEqual(answer.ok, true);
  assert.strictEqual(store.data[PRESET_NAMES.key].length, 32);
  assert.deepStrictEqual(await call(PRESET_NAMES.op, SAVE('one more')), { ok: false, reason: 'full' });
});

test('a lock that cannot be taken, or a write that fails, is said as `failed`: nothing is pushed', async () => {
  const stuck = fakeStore({ [PRESET_NAMES.key]: PRESETS });
  stuck.withLock = () => { throw new Error('lock timeout'); };
  const a = presetSetup(stuck);
  assert.deepStrictEqual(await a.call(PRESET_NAMES.op, SAVE('X')), { ok: false, reason: 'failed' });
  assert.deepStrictEqual(a.sent, []);
  const broken = fakeStore({ [PRESET_NAMES.key]: PRESETS });
  broken.write = () => { throw new Error('EPERM'); };
  const b = presetSetup(broken);
  assert.deepStrictEqual(await b.call(PRESET_NAMES.op, SAVE('X')), { ok: false, reason: 'failed' });
  assert.deepStrictEqual(b.sent, []);
  assert.deepStrictEqual(broken.data[PRESET_NAMES.key], PRESETS);
});

test('a sender that is not a tab view gets nothing and changes nothing on the presets channels', async () => {
  const { ipcMain, store, sent } = presetSetup(fakeStore({ [PRESET_NAMES.key]: PRESETS }));
  const stranger = { sender: {} };
  assert.strictEqual(await ipcMain.handlers.get(PRESET_NAMES.get)(stranger), null);
  assert.strictEqual(await ipcMain.handlers.get(PRESET_NAMES.op)(stranger, SAVE('X')), null);
  assert.deepStrictEqual(store.data[PRESET_NAMES.key], PRESETS);
  assert.strictEqual(store.writes, 0);
  assert.deepStrictEqual(sent, []);
});

test('a get of the presets key answers ok with the list, MISSING when there is no file, and never "missing" for a damaged one', async () => {
  assert.deepStrictEqual(await presetSetup(fakeStore({ [PRESET_NAMES.key]: PRESETS })).call(PRESET_NAMES.get), { status: 'ok', layout: PRESETS });
  assert.deepStrictEqual(await presetSetup(fakeStore({ [PRESET_NAMES.key]: [] })).call(PRESET_NAMES.get), { status: 'ok', layout: [] });
  assert.deepStrictEqual(await presetSetup().call(PRESET_NAMES.get), { status: 'missing', layout: null });
  for (const status of ['unreadable', 'corrupt']) {
    const { call } = presetSetup(fakeStore({ [PRESET_NAMES.key]: PRESETS }, { [PRESET_NAMES.key]: { status, value: null } }));
    assert.deepStrictEqual(await call(PRESET_NAMES.get), { status, layout: null }, status);
  }
  // ok JSON of the wrong shape (an object where the list should be) is corrupt, and the tree's answer is unchanged
  assert.deepStrictEqual(await presetSetup(fakeStore({ [PRESET_NAMES.key]: { a: 1 } })).call(PRESET_NAMES.get), { status: 'corrupt', layout: null });
  assert.deepStrictEqual(await treeSetup(fakeStore({ [TREE_NAMES.key]: [] })).call(TREE_NAMES.get), { status: 'corrupt', layout: null });
});

test('a presets watcher pushes a list another window wrote once, including an empty one, and says nothing for a failed read', () => {
  const states = {};
  const store = fakeStore({ [PRESET_NAMES.key]: PRESETS }, states);
  const sent = [];
  let listener = null;
  watchLayout({
    store, file: 'layout-presets.json', sync: {}, names: PRESET_NAMES, send: (ch, v) => sent.push([ch, v]),
    watchFile: (_f, _o, fn) => { listener = fn; }, unwatchFile: () => {},
  });
  listener();
  assert.deepStrictEqual(sent, [], 'no change');
  store.data[PRESET_NAMES.key] = [];
  listener();
  listener();
  assert.deepStrictEqual(sent, [[PRESET_NAMES.push, []]]);
  states[PRESET_NAMES.key] = { status: 'error' };
  store.data[PRESET_NAMES.key] = PRESETS;
  listener();
  assert.strictEqual(sent.length, 1);
  store.data[PRESET_NAMES.key] = { not: 'a list' };
  delete states[PRESET_NAMES.key];
  listener();
  assert.strictEqual(sent.length, 1, 'a value of the wrong shape is skipped, not pushed');
});
