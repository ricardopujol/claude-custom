'use strict';
/**
 * The probe driver (single-instance PR 2, step 8): one server per process, the token checked first, then a `window` (a project root)
 * picks the window whose api answers; `windows` and `openProject` are the process's own commands.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { routeProbeLine, createAppApi, isInside } = require('../app/probe-driver');
const { createProjectRegistry } = require('../app/project-registry');

const TOKEN = 'a-long-enough-probe-token';

function rig({ probePort = 51000, token = TOKEN } = {}) {
  const calls = [];
  const mkApi = (name) => ({ async state() { calls.push([name, 'state']); return { from: name }; }, async select(label) { calls.push([name, 'select', label]); return { ok: true, from: name }; } });
  const apis = { A: mkApi('A'), B: mkApi('B') };
  const wins = ['A', 'B'].map((n) => ({ root: n, label: n, mode: 'tabs', tabShell: { snapshot: () => ({ selectedKey: `${n}-sel` }) }, isStrip: () => false, isTabView: () => false, canvasViews: { isPanel: () => false } }));
  const registry = createProjectRegistry(); for (const w of wins) registry.add(w);
  const resolved = [];
  const windowApi = (root) => { resolved.push(root); const key = root === undefined ? 'A' : root; return apis[key] || null; };
  const opened = [];
  // PR 3: main's openProject (app/open-project.js) answers { ok, root, existing } | { ok: false, error }
  const openProject = async ({ cwd }) => { opened.push(cwd); return cwd.includes('BAD') ? { ok: false, error: 'start failed' } : { ok: true, root: cwd, existing: cwd.includes('OPEN') }; };
  const appApi = createAppApi({ probePort, token, tempRoot: os.tmpdir(), registry, launchWindow: wins[0], openProject });
  const route = (obj) => routeProbeLine(JSON.stringify(obj), { token, windowApi, appApi });
  return { route, calls, resolved, opened, appApi, wins };
}

test('a bad token is refused BEFORE a window is resolved (an unknown window can\'t be probed for by a stranger)', async () => {
  const t = rig();
  assert.deepStrictEqual(await t.route({ cmd: 'state', token: 'wrong', window: 'no-such' }), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(await t.route({ cmd: 'state', window: 'A' }), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(t.resolved, [], 'no window was looked up');
  assert.deepStrictEqual(t.calls, []);
});

test('a driver with no real token refuses everything', async () => {
  const t = rig({ token: 'short' });
  assert.deepStrictEqual(await t.route({ cmd: 'state', token: 'short' }), { ok: false, error: 'probe driver has no token' });
});

test('an unknown window is { ok: false, error: "no such window" }; a non-string window is refused', async () => {
  const t = rig();
  assert.deepStrictEqual(await t.route({ cmd: 'state', token: TOKEN, window: 'nope' }), { ok: false, error: 'no such window' });
  assert.deepStrictEqual(await t.route({ cmd: 'state', token: TOKEN, window: 42 }), { ok: false, error: 'window must be a project root' });
});

test('a command reaches the named window only; with no window it goes to the launch window', async () => {
  const t = rig();
  assert.deepStrictEqual(await t.route({ cmd: 'select', token: TOKEN, label: 'x', window: 'B' }), { ok: true, from: 'B' });
  assert.deepStrictEqual(await t.route({ cmd: 'select', token: TOKEN, label: 'y' }), { ok: true, from: 'A' });
  assert.deepStrictEqual(t.calls, [['B', 'select', 'x'], ['A', 'select', 'y']]);
});

test('windows lists every window of the process, and the pid', async () => {
  const t = rig();
  const r = await t.route({ cmd: 'windows', token: TOKEN });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pid, process.pid);
  assert.deepStrictEqual(r.windows.map((w) => [w.root, w.launch, w.selectedKey]), [['A', true, 'A-sel'], ['B', false, 'B-sel']]);
  assert.deepStrictEqual(t.resolved, [], 'an app command never picks a window');
});

test('openProject is refused without BOTH the probe port and a real token', async () => {
  const noPort = rig({ probePort: 0 });
  assert.match((await noPort.route({ cmd: 'openProject', token: TOKEN, cwd: path.join(os.tmpdir(), 'cc-x') })).error, /needs the probe driver/);
  assert.deepStrictEqual(noPort.opened, []);
  const noToken = createAppApi({ probePort: 1, token: null, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null, openProject: async () => { throw new Error('must not run'); } });
  assert.match((await noToken.openProject(path.join(os.tmpdir(), 'x'))).error, /needs the probe driver/);
});

test('openProject is refused for a folder outside the temp folder (a probe\'s scratch project only), however it is spelled', async () => {
  const t = rig();
  for (const cwd of ['C:\\Users\\someone\\VibeCode\\real-project\\dev', '/etc', path.join(os.tmpdir(), '..', 'elsewhere'), path.join(os.tmpdir(), '..', '..'), '', os.tmpdir() + '-sibling']) {
    const r = await t.appApi.openProject(cwd);
    assert.strictEqual(r.ok, false, cwd);
  }
  assert.deepStrictEqual(t.opened, [], 'nothing was opened');
  const missing = await t.route({ cmd: 'openProject', token: TOKEN });
  assert.match(missing.error, /openProject needs a cwd/);
});

test('openProject opens a scratch project in this process; on an already-open root it says existing: true', async () => {
  const t = rig();
  const fresh = await t.route({ cmd: 'openProject', token: TOKEN, cwd: path.join(os.tmpdir(), 'cc-probe-two', 'B', 'dev') });
  assert.deepStrictEqual([fresh.ok, fresh.existing, fresh.pid], [true, false, process.pid]);
  const again = await t.route({ cmd: 'openProject', token: TOKEN, cwd: path.join(os.tmpdir(), 'OPEN-cc-probe-two', 'dev') });
  assert.strictEqual(again.existing, true);
  const bad = await t.route({ cmd: 'openProject', token: TOKEN, cwd: path.join(os.tmpdir(), 'BAD-project') });
  assert.deepStrictEqual(bad, { ok: false, error: 'start failed' });
});

test('isInside: the folder itself and anything under it, nothing beside or above', () => {
  assert.strictEqual(isInside('/a/b', '/a/b'), true);
  assert.strictEqual(isInside('/a/b', '/a/b/c/d'), true);
  assert.strictEqual(isInside('/a/b', '/a/bc'), false);
  assert.strictEqual(isInside('/a/b', '/a'), false);
  assert.strictEqual(isInside('/a/b', '/a/b/../x'), false);
  assert.strictEqual(isInside('/a/b', null), false);
});

// (the "listens on loopback only, once" source assertions live in test/source-contracts.test.js: this file is in the mutation command)

test('webContents is the process\'s own command: it answers the count of pages the process holds, picking no window (PR #256 Miguel B1)', async () => {
  const t = rig();
  const api = createAppApi({ probePort: 51000, token: TOKEN, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null, openProject: async () => ({}), countWebContents: () => 7 });
  const r = await routeProbeLine(JSON.stringify({ cmd: 'webContents', token: TOKEN }), { token: TOKEN, windowApi: () => { throw new Error('must not pick a window'); }, appApi: api });
  assert.deepStrictEqual([r.ok, r.count, r.pid], [true, 7, process.pid]);
  assert.deepStrictEqual(await t.route({ cmd: 'webContents', token: 'wrong' }), { ok: false, error: 'bad token' });
});

test('isInside compares real paths: a junction inside the temp folder that points outside it is NOT inside (PR #256 Miguel S1)', () => {
  const fs = require('fs');
  const { tmpDir } = require('./tmp-dir');
  const root = tmpDir('pd-root-');
  const outside = tmpDir('pd-outside-');
  fs.mkdirSync(path.join(outside, 'real-project'));
  const link = path.join(root, 'escape');
  fs.symlinkSync(outside, link, 'junction');
  assert.strictEqual(isInside(root, path.join(link, 'real-project')), false, 'the junction leads out of the folder');
  assert.strictEqual(isInside(root, link), false);
  // a real folder inside stays inside, and a folder not made yet (ENOENT) is judged by its nearest existing parent
  fs.mkdirSync(path.join(root, 'ok'));
  assert.strictEqual(isInside(root, path.join(root, 'ok')), true);
  assert.strictEqual(isInside(root, path.join(root, 'ok', 'not-made-yet', 'dev')), true);
  assert.strictEqual(isInside(root, path.join(link, 'not-made-yet')), false);
});

test('openProject is refused in a process that was launched with a port: its CLAUDE_CUSTOM_TOKEN is the launch window\'s alone (plan risk 6; PR #256 Miguel Y4)', async () => {
  const opened = [];
  const api = createAppApi({ probePort: 51000, token: TOKEN, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null, portNamed: true, openProject: async (o) => { opened.push(o.cwd); return { ok: true, root: o.cwd }; } });
  const r = await api.openProject(path.join(os.tmpdir(), 'cc-probe-two', 'B'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /port/);
  assert.deepStrictEqual(opened, [], 'no second window for a port-named launch');
  const free = createAppApi({ probePort: 51000, token: TOKEN, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null, portNamed: false, openProject: async (o) => { opened.push(o.cwd); return { ok: true, root: o.cwd }; } });
  assert.strictEqual((await free.openProject(path.join(os.tmpdir(), 'cc-probe-two', 'B'))).ok, true);
});

// ---- single-instance PR 3 step 13 ---------------------------------------------------------------------------------------------------

test('PR 3: openProject goes through main\'s openProject (the queue), with the cwd and show: shown', async () => {
  const seen = [];
  const api = createAppApi({ probePort: 51000, token: TOKEN, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null,
    openProject: async (o) => { seen.push(o); return { ok: true, root: 'R', existing: false }; } });
  const r = await api.openProject(path.join(os.tmpdir(), 'cc-probe-si', 'A', 'dev'));
  assert.deepStrictEqual(r, { ok: true, existing: false, root: 'R', pid: process.pid });
  assert.deepStrictEqual(seen, [{ cwd: path.join(os.tmpdir(), 'cc-probe-si', 'A', 'dev'), show: 'shown' }]);
  const failed = createAppApi({ probePort: 51000, token: TOKEN, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null,
    openProject: async () => ({ ok: false, error: 'the folder is gone' }) });
  assert.deepStrictEqual(await failed.openProject(path.join(os.tmpdir(), 'x')), { ok: false, error: 'the folder is gone' });
});

test('PR 3: appLock and openWindows are the process\'s commands (token first, no window picked)', async () => {
  const api = createAppApi({ probePort: 51000, token: TOKEN, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null,
    openProject: async () => ({ ok: true }),
    appLock: () => ({ owns: true, file: 'C:\s\app.json', pid: 4242 }),
    openWindows: () => ({ clean: false, windows: [] }) });
  const resolved = [];
  const route = (obj) => routeProbeLine(JSON.stringify(obj), { token: TOKEN, windowApi: (r) => { resolved.push(r); return null; }, appApi: api });
  assert.deepStrictEqual(await route({ cmd: 'appLock', token: TOKEN }), { ok: true, owns: true, file: 'C:\s\app.json', pid: 4242 });
  assert.deepStrictEqual(await route({ cmd: 'openWindows', token: TOKEN }), { ok: true, record: { clean: false, windows: [] } });
  assert.deepStrictEqual(await route({ cmd: 'appLock', token: 'wrong' }), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(resolved, []);
});

test('PR 3: reader-unsaved is a window command: it reports unsaved text for a tab without a real edit (token-gated like the rest)', async () => {
  const got = [];
  const windowApi = () => ({ async readerUnsaved(key, p) { got.push([key, p]); return { ok: true }; } });
  const route = (obj) => routeProbeLine(JSON.stringify(obj), { token: TOKEN, windowApi, appApi: {} });
  assert.deepStrictEqual(await route({ cmd: 'reader-unsaved', token: TOKEN, key: 'develop', path: 'notes.md' }), { ok: true });
  assert.deepStrictEqual(got, [['develop', 'notes.md']]);
  assert.match((await route({ cmd: 'reader-unsaved', token: TOKEN, key: 'develop' })).error, /needs a key and a path/);
  assert.deepStrictEqual(await route({ cmd: 'reader-unsaved', token: 'nope', key: 'k', path: 'p' }), { ok: false, error: 'bad token' });
});

test('PR 3: window-hide is a window command (a restore\'s hidden window, verify/probe-single-instance.js case 8)', async () => {
  let hidden = 0;
  const route = (obj) => routeProbeLine(JSON.stringify(obj), { token: TOKEN, windowApi: () => ({ async hide() { hidden++; return { ok: true, visible: false }; } }), appApi: {} });
  assert.deepStrictEqual(await route({ cmd: 'window-hide', token: TOKEN, window: 'B' }), { ok: true, visible: false });
  assert.strictEqual(hidden, 1);
});
