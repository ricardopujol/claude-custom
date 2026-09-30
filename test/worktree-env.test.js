'use strict';
/**
 * Per-worktree environment (Extension X3): every tab's `claude` -- and every
 * tool it runs -- can tell which worktree it is in and stay out of the others'
 * way.
 *   WORKTREE_NAME         the worktree's folder: `dev`, `feat-sound`
 *   COMPOSE_PROJECT_NAME  `<project>` for dev, `<project>-<folder>` otherwise,
 *                         normalised the way Compose normalises a directory
 *                         name -- or dev's value wouldn't equal the default its
 *                         containers and volumes were created under, and they
 *                         would orphan
 *   WORKTREE_PORT_BASE    the worktree's block of 100 ports (host/port-blocks.js)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { composeName, worktreeEnv } = require('../host/worktree-env');
const { tmpDir } = require('./tmp-dir');

function makeContainer(name = 'claude-custom') {
  const base = path.join(tmpDir('worktree-env-'), name);
  const devGit = path.join(base, 'dev', '.git');
  fs.mkdirSync(devGit, { recursive: true });
  fs.writeFileSync(path.join(devGit, 'HEAD'), 'ref: refs/heads/develop\n');
  const sibling = folder => {
    const gitDir = path.join(devGit, 'worktrees', folder);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/x\n');
    const wt = path.join(base, folder);
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    return wt;
  };
  return { base, dev: path.join(base, 'dev'), sibling };
}

test('dev keeps the project\'s own Compose name, so its old containers survive', () => {
  const { dev } = makeContainer();
  assert.deepStrictEqual(worktreeEnv(dev), { WORKTREE_NAME: 'dev', COMPOSE_PROJECT_NAME: 'claude-custom' });
});

test('a sibling worktree gets <project>-<folder>', () => {
  const { sibling } = makeContainer();
  assert.deepStrictEqual(worktreeEnv(sibling('feat-sound')),
    { WORKTREE_NAME: 'feat-sound', COMPOSE_PROJECT_NAME: 'claude-custom-feat-sound' });
});

test('a subfolder gets its worktree\'s values', () => {
  const { dev, sibling } = makeContainer();
  fs.mkdirSync(path.join(dev, 'app'));
  assert.strictEqual(worktreeEnv(path.join(dev, 'app')).WORKTREE_NAME, 'dev');
  assert.strictEqual(worktreeEnv(path.join(sibling('feat-x'), 'sub')).COMPOSE_PROJECT_NAME, 'claude-custom-feat-x');
});

test('names Compose would normalise are normalised the same way', () => {
  const { dev, sibling } = makeContainer('My Project.v2');
  assert.strictEqual(worktreeEnv(dev).COMPOSE_PROJECT_NAME, 'myprojectv2');
  const wt = sibling('Feat_X');
  assert.deepStrictEqual(worktreeEnv(wt), { WORKTREE_NAME: 'Feat_X', COMPOSE_PROJECT_NAME: 'myprojectv2-feat_x' });
});

test('a flat repo is its own folder', () => {
  const repo = path.join(tmpDir('worktree-env-'), 'Some_Repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.deepStrictEqual(worktreeEnv(repo), { WORKTREE_NAME: 'Some_Repo', COMPOSE_PROJECT_NAME: 'some_repo' });
});

test('a folder in no repo, and a container itself, get nothing', () => {
  assert.deepStrictEqual(worktreeEnv(tmpDir('worktree-env-plain-')), {});
  assert.deepStrictEqual(worktreeEnv(makeContainer().base), {});
  assert.deepStrictEqual(worktreeEnv(null), {});
});

test('a name that normalises to nothing leaves COMPOSE_PROJECT_NAME unset, for Compose to default', () => {
  const { dev } = makeContainer('ÉÀ');
  assert.deepStrictEqual(worktreeEnv(dev), { WORKTREE_NAME: 'dev' });
});

test('the port base is passed as a string when there is one, and only then', () => {
  const { dev } = makeContainer();
  assert.strictEqual(worktreeEnv(dev, { portBase: 20100 }).WORKTREE_PORT_BASE, '20100');
  for (const portBase of [null, undefined, NaN, '20100', 20100.5]) {
    assert.ok(!('WORKTREE_PORT_BASE' in worktreeEnv(dev, { portBase })), String(portBase));
  }
});

test('composeName: lowercase, only [a-z0-9_-], no leading _ or -', () => {
  assert.strictEqual(composeName('Claude-Custom'), 'claude-custom');
  assert.strictEqual(composeName('__-Abc'), 'abc');
  assert.strictEqual(composeName('a b.c/d'), 'abcd');
  assert.strictEqual(composeName('ÉÀ'), '');
  assert.strictEqual(composeName('123_x-'), '123_x-');
  assert.strictEqual(composeName(''), '');
  assert.strictEqual(composeName(null), '');
});

test('PROPERTY: composeName is a valid Compose project name (or empty) and idempotent', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 40 }), s => {
    const n = composeName(s);
    assert.match(n, /^([a-z0-9][a-z0-9_-]*)?$/);
    assert.strictEqual(composeName(n), n);
  }), { numRuns: 500 });
});
