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
  config: { EXPLICIT_PORT: null, STRIP_HEIGHT: 34, POLL_MS: 3000, PROBE_PORT: 0, PROBE_TOKEN: null, PROBE_LINE_MAX: 65536, TRAY_ON: false, ONE_WINDOW_ON: false, ...config },
  services: {
    uiStore: {}, readDim: noop, usageCounters: {}, forProbe: (o) => o, openInBrowser: noop, probeConfirms: [], logShellError: noop,
    canvasAsks: new Map(), nextCanvasAskId: noop, previewProbeProxy: noop, stopHostByPid: noop, occupantAt: noop, tokenFileFor: noop,
    ownIdentities: noop, ownStartTime: noop, waitForHost: noop, HARNESS_DIR: 'h', INSTALL_DIR: 'i', listBackground: noop, capture: noop,
    stripFileFor: noop, isQuitting: () => false, setQuitting: noop, onWindowCreated: noop,
    getResources: () => null, getTray: () => null, seenChanged: noop,
  },
});
const make = (launchCwd, config, launch = true) => createProjectWindow({ launchCwd, launch, ...stubs(config) });

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
    assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), launch: true, ...d }), new RegExp(`missing service "${name}"`));
  }
});

test('launch is required, with no default: it decides who holds the one-window claim', () => {
  assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), ...stubs() }), /launch must be true/);
  assert.throws(() => createProjectWindow({ launchCwd: tmpDir('pw-'), launch: 'yes', ...stubs() }), /launch must be true/);
});

test('only the launch window holds the claim: a window made for another project has it disabled (the pipe is per pid)', async () => {
  const dir = tmpDir('pw-');
  const launched = make(dir, { ONE_WINDOW_ON: true }, true);
  const other = make(tmpDir('pw-'), { ONE_WINDOW_ON: true }, false);
  assert.strictEqual(await other.claim.run(), 'proceed', 'a disabled claim lets the window proceed and listens on nothing');
  assert.notStrictEqual(launched.claim, other.claim);
  // with the rule off for everyone (a probe), the launch window's claim is off too
  const off = make(tmpDir('pw-'), { ONE_WINDOW_ON: false }, true);
  assert.strictEqual(await off.claim.run(), 'proceed');
});

test('a window\'s phases are one start(): its parts are not callable from outside', () => {
  const pw = make(tmpDir('pw-'));
  assert.strictEqual(typeof pw.start, 'function');
  for (const gone of ['startServices', 'startDevServers', 'createWindow', 'syncDevServersSampling', 'open']) {
    assert.strictEqual(pw[gone], undefined, `${gone} is the window's own phase, run by start() in order`);
  }
  assert.strictEqual(pw.isUnseen(), true, 'a window not made yet is unseen');
});
