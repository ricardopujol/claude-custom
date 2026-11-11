'use strict';
/**
 * app/project-window.js: the per-project object (single-instance PR 1). The factory needs no Electron to say what a launch folder
 * makes of itself, so this runs under plain node. The window's own behaviour (BrowserWindow, IPC, the shell) is pinned as source
 * text in test/*-wiring.test.js and measured by the verify/ probes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createProjectWindow } = require('../app/project-window');
const { tmpDir } = require('./tmp-dir');

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
  const pw = createProjectWindow({ launchCwd: path.join(root, 'feat-a'), config: { EXPLICIT_PORT: null } });
  assert.strictEqual(pw.mode, 'tabs');
  assert.strictEqual(pw.root, root);
  assert.strictEqual(pw.stateRoot, path.join(root, 'dev'));
  assert.strictEqual(pw.hostProject.kind, 'container');
  assert.strictEqual(pw.launchCwd, path.join(root, 'feat-a'));
  assert.strictEqual(pw.label, path.basename(root));
});

test('the same launch naming a port is single-tab mode', () => {
  const root = container();
  const pw = createProjectWindow({ launchCwd: path.join(root, 'feat-a'), config: { EXPLICIT_PORT: 7742 } });
  assert.strictEqual(pw.mode, 'single');
  assert.strictEqual(pw.root, root, 'the project is still the container: only the mode follows the port');
});

test('a folder in no project is its own root and its own state, kind none', () => {
  const dir = tmpDir('pw-none-');
  const pw = createProjectWindow({ launchCwd: dir, config: { EXPLICIT_PORT: null } });
  assert.strictEqual(pw.project, null);
  assert.strictEqual(pw.mode, 'single');
  assert.strictEqual(pw.hostProject.kind, 'none');
  assert.strictEqual(pw.root, dir);
  assert.strictEqual(pw.stateRoot, dir);
});

test('the identity bundle is the same facts the getters give', () => {
  const root = container();
  const pw = createProjectWindow({ launchCwd: path.join(root, 'dev'), config: {} });
  const { PROJECT_ROOT, STATE_ROOT, MODE, WINDOW_LABEL, HOST_PROJECT, PROJECT, LAUNCH_CWD } = pw.identity;
  assert.deepStrictEqual([PROJECT_ROOT, STATE_ROOT, MODE, WINDOW_LABEL, LAUNCH_CWD],
    [pw.root, pw.stateRoot, pw.mode, pw.label, pw.launchCwd]);
  assert.strictEqual(HOST_PROJECT, pw.hostProject);
  assert.strictEqual(PROJECT, pw.project);
});

test('two windows share no state', () => {
  const a = createProjectWindow({ launchCwd: container(), config: {} });
  const b = createProjectWindow({ launchCwd: container(), config: {} });
  assert.notStrictEqual(a.root, b.root);
  assert.notStrictEqual(a.identity, b.identity);
  assert.notStrictEqual(a.stateRoot, b.stateRoot);
});
