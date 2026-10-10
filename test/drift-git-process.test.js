'use strict';
// The real-process half of host/drift-git.js: it spawns the real git on a throwaway repository, and a real child that outlives a timeout.
// Out of Stryker's command (a hung child counts as a kill); run by hand: node --test test/drift-git-process.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { execFileSync, execFile } = require('child_process');
const { createDriftGit, isInfraError, MAX_DIFF_BYTES } = require('../host/drift-git');

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

test('head: a folder that is not a repository has nothing to watch', async () => {
  assert.strictEqual(await createDriftGit({ cwd: tmpDir('drift-norepo-') }).head(), null);
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

test('merges: a feature branch that merged develop into itself, fast-forwarded into develop, is not read as a merge into develop (Dexter 11)', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(dir, 'x1.txt'), '1\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'c1');
  git(dir, 'checkout', '-q', 'develop');
  const other = mergeFeature(dir, 'other', 'o.txt', 'o\n');          // develop moves on: a real merge
  const from = other;
  git(dir, 'checkout', '-q', 'feat/x');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge origin/develop into feat/x', 'develop');
  fs.writeFileSync(path.join(dir, 'x2.txt'), '2\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'c2');
  git(dir, 'checkout', '-q', 'develop');
  git(dir, 'merge', '-q', '--ff-only', 'feat/x');
  const got = await g.merges(from, await g.head());
  assert.deepStrictEqual(got, []);
});

test('diff: what the merge brought into develop, against its first parent', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  const m = mergeFeature(dir, 'f1', 'b.txt', 'hello drift\n');
  const d = await g.diff(m);
  assert.match(d, /^diff --git a\/b\.txt b\/b\.txt/m);
  assert.match(d, /\+hello drift/);
});

test('diff: a merge that adds a 9 MB file is cut at the cap, not failed (PR #153 Dexter 1)', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  const lines = Array.from({ length: 170_000 }, (_, i) => `row ${i} ${'x'.repeat(50)}`).join('\n');
  assert.ok(lines.length > 9 * 1024 * 1024);
  const m = mergeFeature(dir, 'big', 'fixture.json', lines);
  const d = await g.diff(m);
  assert.ok(d.length > 0 && d.length <= MAX_DIFF_BYTES, String(d.length));
  assert.match(d, /^diff --git a\/fixture\.json/m);
});

test('a real timeout (a child that outlives it, killed by Node) is an infrastructure error with what Node says, never "no develop"', async () => {
  const slow = (cmd, args, opts, done) => execFile(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { ...opts, timeout: 200 }, done);
  const g = createDriftGit({ cwd: '.', execFileImpl: slow });
  const err = await g.head().then(() => null, e => e);
  assert.ok(err, 'a timeout must be thrown');
  assert.strictEqual(err.killed, true);
  assert.strictEqual(isInfraError(err), true);
  assert.match(err.message, /Command failed/);
  assert.doesNotMatch(err.message, /timed out/, 'Node\'s message names no timeout: the old regex could never have matched it');
  const m = await g.merges('a'.repeat(40), 'b'.repeat(40)).then(() => null, e => e);
  assert.ok(m && m.killed === true, 'is-ancestor timing out is not a rewind');
});

// ---- PR #153 round 2 ---------------------------------------------------------------------------------------------
const { trimDiff } = require('../host/drift-text');

test('a 3 MB source map sorted before the code does not eat the cap: the code change reaches trimDiff (R2-3)', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  git(dir, 'checkout', '-q', '-b', 'maps');
  fs.mkdirSync(path.join(dir, 'aaa'));
  fs.mkdirSync(path.join(dir, 'host'));
  fs.writeFileSync(path.join(dir, 'aaa', 'big.map'), Array.from({ length: 50_000 }, (_, i) => `mapping ${i} ${'y'.repeat(50)}`).join('\n'));
  fs.writeFileSync(path.join(dir, 'host', 'x.js'), 'const changed = 1;\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'maps');
  git(dir, 'checkout', '-q', 'develop');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #2 from x/maps', 'maps');
  const d = await g.diff(git(dir, 'rev-parse', 'HEAD'));
  assert.doesNotMatch(d, /big\.map/);
  const shown = trimDiff(d);
  assert.match(shown, /host\/x\.js/);
  assert.match(shown, /\+const changed = 1;/);
});

test('a mark that is not in the repository (pruned, or a re-clone) is followed, not an error on every tick (R2-6)', async () => {
  const dir = repo();
  const g = createDriftGit({ cwd: dir });
  assert.strictEqual(await g.merges('1'.repeat(40), await g.head()), null);
});
