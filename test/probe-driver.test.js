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
  const startProject = async (cwd) => { opened.push(cwd); return cwd.includes('BAD') ? { pw: null, error: 'start failed' } : { pw: { root: cwd }, existing: cwd.includes('OPEN'), first: null }; };
  const appApi = createAppApi({ probePort, token, tempRoot: os.tmpdir(), registry, launchWindow: wins[0], startProject });
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
  const noToken = createAppApi({ probePort: 1, token: null, tempRoot: os.tmpdir(), registry: createProjectRegistry(), launchWindow: null, startProject: async () => { throw new Error('must not run'); } });
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

test('the server is the process\'s: it listens on loopback only, once, and the window no longer opens a port of its own', () => {
  const fs = require('fs');
  const driver = fs.readFileSync(path.join(__dirname, '..', 'app', 'probe-driver.js'), 'utf8');
  assert.match(driver, /server\.listen\(port, '127\.0\.0\.1'/);
  const win = fs.readFileSync(path.join(__dirname, '..', 'app', 'project-window.js'), 'utf8');
  assert.doesNotMatch(win, /net\.createServer|\.listen\(port/, 'a second window would collide on PROBE_PORT');
});
