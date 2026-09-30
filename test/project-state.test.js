'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { projectRoots } = require('../host/project-roots');

const BOX = { kind: 'container', root: 'C:\box', dev: 'C:\box\dev' };
const stateRoot = p => (p ? p.dev : null);
const inject = project => ({ projectOf: () => project, stateRoot });

test('the environment wins over anything derived from the folder', () => {
  const r = projectRoots(
    { CLAUDE_CUSTOM_PROJECT_ROOT: 'C:\env', CLAUDE_CUSTOM_PROJECT_STATE: 'C:\env\dev' },
    'C:\box\feat', inject(BOX),
  );
  assert.deepStrictEqual(r, { projectRoot: 'C:\env', stateRoot: 'C:\env\dev' });
});

test('a container folds a sibling worktree to the container and its dev folder', () => {
  assert.deepStrictEqual(projectRoots({}, 'C:\box\feat', inject(BOX)),
    { projectRoot: 'C:\box', stateRoot: 'C:\box\dev' });
});

test('a flat repo is its own root and state', () => {
  const flat = { kind: 'flat', root: 'C:\repo', dev: 'C:\repo' };
  assert.deepStrictEqual(projectRoots({}, 'C:\repo', inject(flat)),
    { projectRoot: 'C:\repo', stateRoot: 'C:\repo' });
});

test('a folder that is in no project is its own root and state', () => {
  assert.deepStrictEqual(projectRoots({}, 'C:\loose', inject(null)),
    { projectRoot: 'C:\loose', stateRoot: 'C:\loose' });
});

test('empty-string environment values count as unset', () => {
  assert.deepStrictEqual(
    projectRoots({ CLAUDE_CUSTOM_PROJECT_ROOT: '', CLAUDE_CUSTOM_PROJECT_STATE: '' }, 'C:\box\feat', inject(BOX)),
    { projectRoot: 'C:\box', stateRoot: 'C:\box\dev' });
});

test('each variable is honoured on its own', () => {
  assert.deepStrictEqual(
    projectRoots({ CLAUDE_CUSTOM_PROJECT_ROOT: 'C:\r' }, 'C:\box\feat', inject(BOX)),
    { projectRoot: 'C:\r', stateRoot: 'C:\box\dev' });
  assert.deepStrictEqual(
    projectRoots({ CLAUDE_CUSTOM_PROJECT_STATE: 'C:\s' }, 'C:\box\feat', inject(BOX)),
    { projectRoot: 'C:\box', stateRoot: 'C:\s' });
});

test('the default resolvers work on a real folder (no project = the folder itself)', () => {
  const os = require('os');
  const dir = os.tmpdir();
  const r = projectRoots({}, dir);
  assert.strictEqual(typeof r.projectRoot, 'string');
  assert.strictEqual(typeof r.stateRoot, 'string');
});

test('an environment that names both never asks the filesystem', () => {
  let asked = 0;
  projectRoots(
    { CLAUDE_CUSTOM_PROJECT_ROOT: 'C:\r', CLAUDE_CUSTOM_PROJECT_STATE: 'C:\s' },
    'C:\\x', { projectOf: () => { asked++; return null; }, stateRoot },
  );
  assert.strictEqual(asked, 0);
});

// --- host.js wiring: which root each call gets --------------------------------
const fs = require('fs');
const path = require('path');
const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('host.js derives both roots from the environment and its own folder', () => {
  assert.match(HOST, /const \{ projectRoot: PROJECT_ROOT, stateRoot: STATE_ROOT \} = projectRoots\(process\.env, CWD\)/);
});

test('look and style calls use STATE_ROOT; theme, background and label use PROJECT_ROOT', () => {
  for (const re of [
    /seedLookIfNew\(\{ cwd: STATE_ROOT, hasHistory: \(\) => hasClaudeHistory\(STATE_ROOT\)/,
    /resolveStyle\(STATE_ROOT,/,
    /setBackground\(\{ source: asked, cwd: STATE_ROOT \}\)/,
    /resetBackground\(\{ cwd: STATE_ROOT \}\)/,
    /rerollLook\(\{ cwd: STATE_ROOT,/,
    /setLook\(\{ cwd: STATE_ROOT,/,
    /resolveTheme\(PROJECT_ROOT,/,
    /backgroundFor\(PROJECT_ROOT,/,
    /projectLabel\(PROJECT_ROOT\)/,
  ]) assert.match(HOST, re);
});

test('no look or style call is left on the worktree folder', () => {
  assert.doesNotMatch(HOST, /(seedLookIfNew|setBackground|resetBackground|rerollLook|setLook|readLook)\(\{[^}]*cwd: CWD/);
  assert.doesNotMatch(HOST, /resolveStyle\(CWD|resolveTheme\(CWD|projectLabel\(CWD/);
});
