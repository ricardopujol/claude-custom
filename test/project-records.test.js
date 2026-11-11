'use strict';
/**
 * The per-project records main keeps (single-instance PR 2, step 4): secrets and layout are each project window's own (Q1 default: one
 * vault per window), and the layout IPC, registered once, reaches the right window's store by the asking page.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRecords } = require('../app/project-records');
const { registerLayoutHandlers, LAYOUT_KEY, TREE_NAMES } = require('../app/layout-bridge');
const { createSecretService } = require('../app/secret-service');
const { createProjectRegistry } = require('../app/project-registry');

function fakeStore() {
  const data = {};
  const store = {
    data, writes: [],
    read: (n, f) => (n in data ? data[n] : f),
    update: (n, f, fn) => { data[n] = fn(n in data ? data[n] : f); store.writes.push(n); return data[n]; },
    write: (n, v) => { data[n] = v; store.writes.push(n); return v; },
    withLock: (n, fn) => fn(),
    readState: (n) => (n in data ? { status: 'ok', value: data[n] } : { status: 'missing', value: null }),
  };
  return store;
}

/** A vault the secret service can sit on: scoped entries, and a lock that is its own per instance. */
function fakeVault() {
  const entries = []; let locked = true;
  return {
    available: () => true,
    list: ({ project } = {}) => entries.filter((e) => [].concat(project).includes(e.scope)).map(({ id, label }) => ({ id, label, note: '', createdAt: 0 })),
    add: ({ label, project }) => { const e = { id: `id${entries.length}`, label, scope: project }; entries.push(e); return { id: e.id, label, note: '', createdAt: 0 }; },
    get: () => null, remove: () => true,
    lockState: () => ({ hasKey: true, locked, count: entries.length }),
    setKey: () => ({ ok: true, failed: [] }),
    unlock: () => { locked = false; return { ok: true }; },
    lock: () => { locked = true; return { ok: true }; },
    removeKey: () => ({ ok: true }), melt: () => ({ ok: true }),
  };
}

function windowWith(root) {
  const strip = { id: `strip-${root}` }; const view = { id: `view-${root}` };
  return { root, stateRoot: `${root}/state`, launchCwd: `${root}/dev`, strip, view,
    isStrip: (s) => s === strip, isTabView: (s) => s === view, canvasViews: { isPanel: () => false }, dispose() {} };
}

function rig() {
  const sends = [];
  const stopped = [];
  const stores = new Map();
  const records = createProjectRecords({
    makeSecrets: (pw) => createSecretService({ project: pw.stateRoot, scopes: [pw.root, pw.launchCwd], vault: fakeVault(), clipboard: { writeText() {}, readText: () => '', clear() {} } }),
    makeLayoutStore: (pw) => { const s = fakeStore(); stores.set(pw.root, s); return s; },
    watch: ({ pw }) => [() => stopped.push(pw.root)],
    pushToProject: (pw) => (ch, v) => sends.push([pw.root, ch, v]),
  });
  const registry = createProjectRegistry();
  const a = windowWith('A'); const b = windowWith('B');
  registry.add(a); registry.add(b);
  records.make(a); records.make(b);
  return { records, registry, a, b, sends, stopped, stores };
}

test('each window has its own secret service: unlocking in A leaves B locked (Q1 default)', () => {
  const { records, a, b } = rig();
  const sa = records.secretsOf(a); const sb = records.secretsOf(b);
  assert.notStrictEqual(sa, sb);
  assert.strictEqual(sa.lockState().locked, true);
  sa.unlock('k');
  assert.strictEqual(sa.lockState().locked, false);
  assert.strictEqual(sb.lockState().locked, true, 'B is untouched');
});

test('each window\'s secret service lists only the entries of its own project', () => {
  const { records, a, b } = rig();
  records.secretsOf(a).add({ label: 'a-key', secret: 'x' });
  records.secretsOf(b).add({ label: 'b-key', secret: 'y' });
  assert.deepStrictEqual(records.secretsOf(a).list().map((e) => e.label), ['a-key']);
  assert.deepStrictEqual(records.secretsOf(b).list().map((e) => e.label), ['b-key']);
});

test('layout handlers registered ONCE route a set from A\'s page to A\'s store, A\'s send and A\'s sync only', async () => {
  const { records, registry, a, b, sends, stores } = rig();
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f) };
  const owner = (s) => registry.viewOwner(s);
  registerLayoutHandlers({ ipcMain, scopeFor: records.scopeFor(owner, 'layoutSync') });
  registerLayoutHandlers({ ipcMain, names: TREE_NAMES, scopeFor: records.scopeFor(owner, 'treeSync') });
  const layout = { zones: [] };
  assert.deepStrictEqual(await handlers.get('layout:set')({ sender: a.view }, layout), layout);
  assert.deepStrictEqual(stores.get('A').writes, [LAYOUT_KEY]);
  assert.deepStrictEqual(stores.get('B').writes, [], 'B\'s store is not written');
  assert.deepStrictEqual(sends.map((s) => s[0]), ['A'], 'only A\'s views are pushed to');
  assert.strictEqual(records.get(a).layoutSync.last, JSON.stringify(layout));
  assert.strictEqual(records.get(b).layoutSync.last, undefined, 'only A\'s sync moved');
  // the tree layout is the same, under its own key and its own sync
  const tree = { tree: 1 };
  await handlers.get(TREE_NAMES.set)({ sender: b.view }, tree);
  assert.deepStrictEqual(stores.get('B').writes, [TREE_NAMES.key]);
  assert.strictEqual(records.get(b).treeSync.last, JSON.stringify(tree));
  assert.strictEqual(records.get(a).treeSync.last, undefined);
});

test('a page no window owns reaches no store: the gate is scopeFor(sender) !== null', async () => {
  const { records, registry, stores } = rig();
  const handlers = new Map();
  registerLayoutHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, scopeFor: records.scopeFor((s) => registry.viewOwner(s), 'layoutSync') });
  assert.strictEqual(await handlers.get('layout:get')({ sender: { id: 'x' } }), null);
  assert.strictEqual(await handlers.get('layout:set')({ sender: { id: 'x' } }, { zones: [] }), null);
  assert.strictEqual(await handlers.get('layout:get')(null), null);
  for (const s of stores.values()) assert.deepStrictEqual(s.writes, []);
  // and a window's STRIP is not a tab view, so it is not served either
  const { a } = rig();
  assert.strictEqual(a.isTabView(a.strip), false);
});

test('stopping a window\'s record stops its watchers once and forgets it; the others keep theirs', () => {
  const { records, a, b, stopped } = rig();
  records.stop(a);
  records.stop(a);
  assert.deepStrictEqual(stopped, ['A']);
  assert.strictEqual(records.get(a), null);
  assert.strictEqual(records.secretsOf(a), null);
  assert.notStrictEqual(records.get(b), null);
  assert.strictEqual(records.size(), 1);
});

test('making a record twice for one window gives the same record (no second vault)', () => {
  const { records, a } = rig();
  const first = records.get(a);
  assert.strictEqual(records.make(a), first);
});

test('every factory is required', () => {
  assert.throws(() => createProjectRecords({ makeSecrets() {}, makeLayoutStore() {}, watch() {} }), /missing pushToProject/);
});

test('seam: the secret service and the layout store are no longer built inside registerIpc', () => {
  const { mainOnly, bodyAt } = require('./main-source');
  const main = mainOnly({ strip: true });
  const body = bodyAt(main, main.indexOf('function registerIpc('));
  assert.doesNotMatch(body, /createSecretService\(/);
  assert.doesNotMatch(body, /createProjectLayoutStore\(/);
  assert.match(main, /createSecretService\(\{/);
  assert.match(main, /createProjectLayoutStore\(\{/);
});
