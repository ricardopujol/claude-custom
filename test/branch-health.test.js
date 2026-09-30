'use strict';
/**
 * Branch health markers (Extension X4). A worktree tab shows how far its
 * branch is behind develop; the dev tab shows how far develop is ahead of
 * main. Counted against the remote-tracking refs (origin/develop,
 * origin/main), which any fetch updates -- local `main` is almost never
 * updated in this layout. NEVER a fetch of its own.
 *
 * A count that can't be had -- a missing ref, a git error, output that isn't a
 * count -- is null, never 0: "unknown" drawn as "up to date" is the
 * absence-as-zero bug this project keeps catching.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { branchHealth } = require('../host/branch-health');
const { tmpDir } = require('./tmp-dir');

function makeContainer() {
  const base = tmpDir('branch-health-');
  const devGit = path.join(base, 'dev', '.git');
  fs.mkdirSync(devGit, { recursive: true });
  fs.writeFileSync(path.join(devGit, 'HEAD'), 'ref: refs/heads/develop\n');
  const gitDir = path.join(devGit, 'worktrees', 'feat-x');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feat/x\n');
  const wt = path.join(base, 'feat-x');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  fs.mkdirSync(path.join(base, 'dev', 'app'));
  return { dev: path.join(base, 'dev'), wt };
}

function flatRepo(branch) {
  const repo = tmpDir('branch-health-flat-');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return repo;
}

// A git double: answers `out` (or throws) and records every call.
function fakeGit(out) {
  const calls = [];
  const run = async (args, cwd) => {
    calls.push({ args, cwd });
    if (out instanceof Error) throw out;
    return out;
  };
  return { run, calls };
}

test('the dev tab counts develop ahead of main, on the remote-tracking refs', async () => {
  const { dev } = makeContainer();
  const git = fakeGit('12\n');
  assert.deepStrictEqual(await branchHealth(dev, git), { kind: 'dev', developAheadOfMain: 12 });
  assert.deepStrictEqual(git.calls, [{ args: ['rev-list', '--count', 'origin/main..origin/develop'], cwd: dev }]);
});

test('a folder inside dev is the dev tab too', async () => {
  const { dev } = makeContainer();
  assert.strictEqual((await branchHealth(path.join(dev, 'app'), fakeGit('1'))).kind, 'dev');
});

test('a worktree tab counts its HEAD behind origin/develop, in its own folder', async () => {
  const { wt } = makeContainer();
  const git = fakeGit('3\r\n');
  assert.deepStrictEqual(await branchHealth(wt, git), { kind: 'tab', behindDevelop: 3 });
  assert.deepStrictEqual(git.calls, [{ args: ['rev-list', '--count', 'HEAD..origin/develop'], cwd: wt }]);
});

test('a flat repo on develop is judged like dev; on any other branch like a tab', async () => {
  assert.strictEqual((await branchHealth(flatRepo('develop'), fakeGit('1'))).kind, 'dev');
  assert.strictEqual((await branchHealth(flatRepo('feat/y'), fakeGit('1'))).kind, 'tab');
});

test('zero is a real count', async () => {
  const { wt } = makeContainer();
  assert.deepStrictEqual(await branchHealth(wt, fakeGit('0\n')), { kind: 'tab', behindDevelop: 0 });
});

test('a git error (a missing origin/develop, say) is null, never 0', async () => {
  const { wt, dev } = makeContainer();
  const err = Object.assign(new Error("fatal: ambiguous argument 'HEAD..origin/develop'"), { code: 128 });
  assert.deepStrictEqual(await branchHealth(wt, fakeGit(err)), { kind: 'tab', behindDevelop: null });
  assert.deepStrictEqual(await branchHealth(dev, fakeGit(err)), { kind: 'dev', developAheadOfMain: null });
});

test('output that is not a single count is null', async () => {
  const { wt } = makeContainer();
  for (const out of ['', '\n', '-1', '3 4', 'x', '1.5', null, undefined]) {
    assert.strictEqual((await branchHealth(wt, fakeGit(out))).behindDevelop, null, JSON.stringify(out));
  }
});

test('a folder in no repo has no health, and git is not run', async () => {
  const git = fakeGit('1');
  assert.strictEqual(await branchHealth(tmpDir('branch-health-plain-'), git), null);
  assert.strictEqual(await branchHealth(null, git), null);
  assert.strictEqual(await branchHealth(path.dirname(makeContainer().dev), git), null, 'the container itself');
  assert.strictEqual(git.calls.length, 0);
});

// --- against real git ------------------------------------------------------------

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('real git: the ranges count what they say', { skip: !hasGit() }, async () => {
  const repo = tmpDir('branch-health-real-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'develop');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  const commit = msg => { git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };
  const a = commit('a');
  git('update-ref', 'refs/remotes/origin/main', a);
  commit('b');
  const c = commit('c');
  git('update-ref', 'refs/remotes/origin/develop', c);

  assert.deepStrictEqual(await branchHealth(repo), { kind: 'dev', developAheadOfMain: 2 });
  git('checkout', '-q', '-b', 'feat/y', a);
  assert.deepStrictEqual(await branchHealth(repo), { kind: 'tab', behindDevelop: 2 });
  git('update-ref', '-d', 'refs/remotes/origin/develop');
  assert.deepStrictEqual(await branchHealth(repo), { kind: 'tab', behindDevelop: null });
});
