'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { execFileSync } = require('child_process');
const { createDriftGit } = require('../host/drift-git');

// These spawn the real git, a handful of times, on a throwaway repository.
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

function repo() {
  const dir = tmpDir('drift-git-');
  git(dir, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function mergeFeature(dir, name, file, text) {
  git(dir, 'checkout', '-q', '-b', name);
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `work on ${name}`);
  git(dir, 'checkout', '-q', 'develop');
  git(dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #1 from x/${name}`, name);
  return git(dir, 'rev-parse', 'HEAD');
}

test('head is the develop tip; null when there is no develop branch', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  assert.strictEqual(await g.head(), git(dir, 'rev-parse', 'develop'));
  git(dir, 'branch', '-m', 'develop', 'trunk');
  assert.strictEqual(await g.head(), null);
});

test('merges: first-parent merge commits after `from`, oldest first; plain commits and the merged branch commits are not merges', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  const start = await g.head();
  const m1 = mergeFeature(dir, 'f1', 'b.txt', 'b\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); git(dir, 'commit', '-qam', 'direct commit');
  const m2 = mergeFeature(dir, 'f2', 'c.txt', 'c\n');
  const got = await g.merges(start, await g.head());
  assert.deepStrictEqual(got.map(m => m.sha), [m1, m2]);
  assert.match(got[0].subject, /Merge pull request #1 from x\/f1/);
  assert.deepStrictEqual(await g.merges(m2, m2), []);
});

test('merges: the newest `limit` only', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  const start = await g.head();
  mergeFeature(dir, 'f1', 'b.txt', 'b\n');
  const m2 = mergeFeature(dir, 'f2', 'c.txt', 'c\n');
  const m3 = mergeFeature(dir, 'f3', 'd.txt', 'd\n');
  assert.deepStrictEqual((await g.merges(start, m3, { limit: 2 })).map(m => m.sha), [m2, m3]);
});

test('merges: a `from` that is not an ancestor of `to` is null (develop was rewound), not an empty list', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  const first = await g.head();
  const m1 = mergeFeature(dir, 'f1', 'b.txt', 'b\n');
  git(dir, 'reset', '-q', '--hard', first);
  const other = mergeFeature(dir, 'f2', 'c.txt', 'c\n');
  assert.strictEqual(await g.merges(m1, other), null);
});

test('diff: what the merge brought into develop, against its first parent', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  const m = mergeFeature(dir, 'f1', 'b.txt', 'hello drift\n');
  const d = await g.diff(m);
  assert.match(d, /^diff --git a\/b\.txt b\/b\.txt/m);
  assert.match(d, /\+hello drift/);
});

test('anything that is not a commit id is refused before git is spawned', async () => {
  const calls = [];
  const g = createDriftGit({ cwd: '.', run: async (args) => { calls.push(args); return ''; } });
  for (const bad of ['--output=x', 'HEAD; rm -rf', '', null, 'xyz', 'abc']) {
    await assert.rejects(() => g.diff(bad), /not a commit id/);
    await assert.rejects(() => g.merges(bad, 'a'.repeat(40)), /not a commit id/);
  }
  assert.deepStrictEqual(calls, []);
});

test('a folder that is not a repository has no develop to watch: null, not an error', async () => {
  const g = createDriftGit({ cwd: '.', run: async () => { throw new Error('fatal: not a git repository (or any of the parent directories): .git'); } });
  assert.strictEqual(await g.head(), null);
});

test('a git that fails is a rejection with its message, never a silent empty diff', async () => {
  const g = createDriftGit({ cwd: '.', run: async () => { throw new Error('git is not installed'); } });
  await assert.rejects(() => g.diff('a'.repeat(40)), /git is not installed/);
  await assert.rejects(() => g.head(), /git is not installed/);
});
