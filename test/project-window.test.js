'use strict';
/**
 * app/project-window.js: the per-project object (single-instance PR 1). The factory needs no Electron to say what a launch folder
 * makes of itself, so this runs under plain node, with stubs for what main hands it. The window's own behaviour (BrowserWindow, IPC,
 * the shell) is pinned as source text in test/*-wiring.test.js and measured by the verify/ probes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createProjectWindow } = require('../app/project-window');
const { tmpDir } = require('./tmp-dir');

const noop = () => {};
// Everything main hands a window, as stubs. canvasProbeResolve is deliberately absent: it is undefined in a normal run.
const stubs = (config = {}) => ({
  electron: { app: {}, BrowserWindow: {}, WebContentsView: {}, Menu: {}, dialog: {}, session: {} },
  config: { EXPLICIT_PORT: null, STRIP_HEIGHT: 34, POLL_MS: 3000, PROBE_PORT: 0, TRAY_ON: false, ONE_WINDOW_ON: false, ...config },
  services: {
    uiStore: {}, readDim: noop, usageCounters: {}, forProbe: (o) => o, openInBrowser: noop, probeConfirms: [], logShellError: noop,
    canvasAsks: new Map(), nextCanvasAskId: noop, previewProbeProxy: noop, stopHostByPid: noop, occupantAt: noop, tokenFileFor: noop,
    ownIdentities: noop, ownStartTime: noop, waitForHost: noop, HARNESS_DIR: 'h', INSTALL_DIR: 'i', listBackground: noop, capture: noop,
    stripFileFor: noop, isQuitting: () => false, setQuitting: noop, onWindowCreated: noop, onClosed: noop,
    getResources: () => null, getTray: () => null, seenChanged: noop,
    windowRouter: { register: async () => ({ close: async () => {} }) }, onProcessExit: noop, onFocused: noop, openProject: noop, quitCancelled: noop, sessionEnded: noop,
  },
});
const make = (launchCwd, config) => createProjectWindow({ launchCwd, ...stubs(config) });

// <tmp>/p is a container: `dev` holds the repo, `feat-a` is a sibling worktree (a `.git` file).
function container() {
  const root = path.join(tmpDir('pw-'), 'p');
  fs.mkdirSync(path.join(root, 'dev', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dev', '.git', 'HEAD'), 'ref: refs/heads/develop\n');
  fs.mkdirSync(path.join(root, 'feat-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'feat-a', '.git'), 'gitdir: x\n');
  return root;
}

test('a launch from a lane of a container project: tabs mode, the container is the root, dev is the state', () => {
  const root = container();
  const pw = make(path.join(root, 'feat-a'));
  assert.strictEqual(pw.mode, 'tabs');
  assert.strictEqual(pw.root, root);
  assert.strictEqual(pw.stateRoot, path.join(root, 'dev'));
  assert.strictEqual(pw.hostProject.kind, 'container');
  assert.strictEqual(pw.launchCwd, path.join(root, 'feat-a'));
  assert.strictEqual(pw.label, path.basename(root));
});

test('the same launch naming a port is single-tab mode', () => {
  const root = container();
  const pw = make(path.join(root, 'feat-a'), { EXPLICIT_PORT: 7742 });
  assert.strictEqual(pw.mode, 'single');
  assert.strictEqual(pw.root, root, 'the project is still the container: only the mode follows the port');
});

test('a folder in no project is its own root and its own state, kind none', () => {
  const dir = tmpDir('pw-none-');
  const pw = make(dir);
  assert.strictEqual(pw.project, null);
  assert.strictEqual(pw.mode, 'single');
  assert.strictEqual(pw.hostProject.kind, 'none');
  assert.strictEqual(pw.root, dir);
  assert.strictEqual(pw.stateRoot, dir);
});

test('a window states its facts once, as flat fields: there is no second "identity" bundle (single-instance PR 2, S3)', () => {
  const root = container();
  const pw = make(path.join(root, 'dev'));
  assert.strictEqual(pw.identity, undefined, 'the bundle repeated the flat fields; main reads the flat ones');
  assert.strictEqual(pw.launchCwd, path.join(root, 'dev'));
  assert.strictEqual(pw.root, root);
  assert.strictEqual(pw.mode, 'tabs');
  assert.ok(typeof pw.stateRoot === 'string' && typeof pw.label === 'string');
  assert.ok(pw.hostProject && pw.hostProject.root === pw.root);
});

test('two windows share no state: their stores are distinct, and a report in one is absent from the other', () => {
  const a = make(container());
  const b = make(container());
  for (const part of ['readerUnsaved', 'stripAccent', 'canvasViews', 'previewViews', 'claim', 'backgroundActions']) {
    assert.notStrictEqual(a[part], b[part], `${part} must be per window, not module-level`);
  }
  a.readerUnsaved.report('tab-key', 'notes.md');
  assert.deepStrictEqual(a.readerUnsaved.all(), [{ key: 'tab-key', path: 'notes.md' }]);
  assert.deepStrictEqual(b.readerUnsaved.all(), [], 'a report made in window A must not show in window B');
  const view = {};
  assert.strictEqual(a.stripAccent.report(view, '#aabbcc'), true);
  assert.strictEqual(a.stripAccent.show(view), '#aabbcc');
  assert.notStrictEqual(b.stripAccent.show(view), '#aabbcc', 'an accent reported to A is not B\'s');
});

test('a missing launch folder, electron member, config value or service throws at construction, naming itself', () => {
  assert.throws(() => createProjectWindow({ ...stubs(), launchCwd: '' }), /missing launchCwd/);
  const base = stubs();
  for (const name of Object.keys(base.electron)) {
    const d = stubs(); delete d.electron[name];
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), new RegExp(`missing electron member "${name}"`));
  }
  for (const name of Object.keys(base.config)) {
    const d = stubs(); delete d.config[name];
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), new RegExp(`missing config value "${name}"`));
  }
  for (const name of Object.keys(base.services)) {
    const d = stubs(); delete d.services[name];
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), new RegExp(`missing service "${name}"`));
  }
  assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-') }), /missing electron member/);
});

test('isQuitting and setQuitting have no silent default: without them the window would hide on a real quit', () => {
  for (const name of ['isQuitting', 'setQuitting']) {
    const d = stubs(); delete d.services[name];
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), new RegExp(name));
  }
});

test('attach takes only the window\'s own two units, and throws on any other key (the Resources service and the tray are read live now)', () => {
  const pw = make(tmpDir('pw-'));
  pw.attach({ leanBridge: null, indexing: null });
  assert.throws(() => pw.attach({ resouces: {} }), /unknown service "resouces"/);
  assert.throws(() => pw.attach({ resources: {} }), /unknown service "resources"/, 'resources is a getResources() service now, not attached');
  assert.throws(() => pw.attach({ trayController: null }), /unknown service "trayController"/, 'so is the tray: getTray()');
});

test('getResources, getTray and seenChanged are required services, and the window reads them live', () => {
  for (const name of ['getResources', 'getTray', 'seenChanged', 'onWindowCreated']) {
    const d = stubs(); delete d.services[name];
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), new RegExp(`missing service "${name}"`));
  }
});

test('PR 3: createProjectWindow takes no launch: nothing inside a window reads it once every window holds its claim', () => {
  assert.doesNotThrow(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...stubs() }));
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'project-window.js'), 'utf8');
  assert.ok(!/launch must be true/.test(src), 'the PR 2 guard on the launch parameter is gone');
  assert.ok(!/function createProjectWindow\(\{[^}]*\blaunch\b[^C]/.test(src), 'the factory does not destructure launch');
});

test('PR 3: every window holds its claim when the rule is on; its listen is the window router\'s register, with this window\'s root', async () => {
  const registered = [];
  const windowRouter = { register: async (entry) => { registered.push(entry); return { close: async () => {} }; } };
  const exitHooks = [];
  const mk = (dir, on) => {
    const d = stubs({ ONE_WINDOW_ON: on });
    d.services.windowRouter = windowRouter;
    d.services.onProcessExit = (pw, fn) => exitHooks.push([pw, fn]);
    d.services.ownStartTime = async () => null;          // no start time: the claim publishes nothing, so no file is written
    return createProjectWindow({ launchCwd: dir, ...d });
  };
  const a = mk(tmpDir('pw-'), true);
  const b = mk(tmpDir('pw-'), true);
  assert.strictEqual(await a.claim.run(), 'proceed');
  assert.strictEqual(await b.claim.run(), 'proceed');
  assert.deepStrictEqual(registered.map((e) => e.root), [a.root, b.root], 'each window registered its own entry');
  assert.strictEqual(typeof registered[0].hasPort, 'function');
  assert.strictEqual(registered[0].hasPort(7001), false, 'a window with no tab shell yet has no port');
  // with the rule off for everyone (a probe), no window registers
  const off = mk(tmpDir('pw-'), false);
  assert.strictEqual(await off.claim.run(), 'proceed');
  assert.strictEqual(registered.length, 2);
});

test('PR 3: windowRouter and onProcessExit are required services', () => {
  for (const name of ['windowRouter', 'onProcessExit']) {
    const d = stubs(); delete d.services[name];
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), new RegExp(`missing service "${name}"`));
  }
});

test('dispose() is idempotent and leaves no poll running (single-instance PR 2, step 7)', () => {
  const pw = make(tmpDir('pw-'));
  assert.strictEqual(pw.pollActive, false);
  assert.doesNotThrow(() => pw.dispose());
  assert.doesNotThrow(() => pw.dispose());
  assert.strictEqual(pw.pollActive, false);
});

test('onClosed is a required service: a closed window must tell main (a silent default would leave a dead window registered)', () => {
  const d = stubs(); delete d.services.onClosed;
  assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), /missing service "onClosed"/);
});

test('a window\'s phases are one start(): its parts are not callable from outside', () => {
  const pw = make(tmpDir('pw-'));
  assert.strictEqual(typeof pw.start, 'function');
  for (const gone of ['startServices', 'startDevServers', 'createWindow', 'syncDevServersSampling', 'open']) {
    assert.strictEqual(pw[gone], undefined, `${gone} is the window's own phase, run by start() in order`);
  }
  assert.strictEqual(pw.isUnseen(), true, 'a window not made yet is unseen');
});

// ---- single-instance PR 3 step 7: who starts hidden ------------------------------------------------------------------------------

test('PR 3: startHiddenFor: "setting" follows Start minimised (with a tray), "shown" ignores it, "hidden" hides only with a tray', () => {
  const { startHiddenFor } = require('../app/project-window');
  const on = { startMinimised: true };
  const off = { startMinimised: false };
  assert.strictEqual(startHiddenFor({ show: 'setting', trayOn: true, settings: on }), true);
  assert.strictEqual(startHiddenFor({ show: 'setting', trayOn: true, settings: off }), false);
  assert.strictEqual(startHiddenFor({ show: 'setting', trayOn: false, settings: on }), false, 'never hidden without the icon');
  assert.strictEqual(startHiddenFor({ show: 'shown', trayOn: true, settings: on }), false, 'a handed-off launch always shows (Q1)');
  assert.strictEqual(startHiddenFor({ show: 'hidden', trayOn: true, settings: off }), true, 'a restored hidden window');
  assert.strictEqual(startHiddenFor({ show: 'hidden', trayOn: false, settings: off }), false, 'otherwise shown');
  assert.strictEqual(startHiddenFor({ show: undefined, trayOn: true, settings: on }), true, 'no word is today\'s ("setting")');
  assert.strictEqual(startHiddenFor({ show: 'bogus', trayOn: true, settings: on }), true);
});

test('PR 3: start({ show }) hands its word to createWindow, which asks startHiddenFor (not the setting alone)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'project-window.js'), 'utf8');
  assert.match(src, /async function start\(\{ seams, openPrsReader, show \}\)/);
  assert.match(src, /createWindow\(\{ show \}\);/);
  assert.match(src, /function createWindow\(\{ show \} = \{\}\)/);
  assert.match(src, /const startHidden = startHiddenFor\(\{ show, trayOn: TRAY_ON, settings: readTraySettings\(uiStore\) \}\);/);
});

test('PR 3 step 9: onFocused is a required service, called with the window on focus (the registry\'s window used last)', () => {
  const d = stubs(); delete d.services.onFocused;
  assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...d }), /missing service "onFocused"/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'project-window.js'), 'utf8');
  const focus = src.slice(src.indexOf("win.on('focus', () => {"), src.indexOf("win.on('blur'"));
  assert.match(focus, /onFocused\(self\);/);
});
