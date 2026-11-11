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
    stripFileFor: noop, isQuitting: () => false, setQuitting: noop,
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

test('the identity bundle is the same facts the getters give', () => {
  const root = container();
  const pw = make(path.join(root, 'dev'));
  const { PROJECT_ROOT, STATE_ROOT, MODE, WINDOW_LABEL, HOST_PROJECT, PROJECT, LAUNCH_CWD } = pw.identity;
  assert.deepStrictEqual([PROJECT_ROOT, STATE_ROOT, MODE, WINDOW_LABEL, LAUNCH_CWD],
    [pw.root, pw.stateRoot, pw.mode, pw.label, pw.launchCwd]);
  assert.strictEqual(HOST_PROJECT, pw.hostProject);
  assert.strictEqual(PROJECT, pw.project);
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

test('attach takes the four late services and throws on any other key', () => {
  const pw = make(tmpDir('pw-'));
  pw.attach({ resources: {}, trayController: null, leanBridge: null, indexing: null });
  assert.throws(() => pw.attach({ resouces: {} }), /unknown service "resouces"/);
});
