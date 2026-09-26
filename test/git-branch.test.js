'use strict';
/**
 * The current branch of a working tree, read off git's own files rather than
 * shelling out to the `git` binary -- same convention as project-path.js and
 * project-dir.js.
 *
 * Fixtures build synthetic `.git` layouts by hand rather than running real git,
 * so these pass on a machine with no git installed. The final test cross-checks
 * against real git on THIS checkout when it is available, the same "trust but
 * verify against the real thing" shape as project-dir.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fc = require('fast-check');

const { currentBranch } = require('../host/git-branch');
const { tmpDir } = require('./tmp-dir');

function tempDir() {
  return tmpDir('git-branch-test-');
}

test('a normal repo on a branch reports that branch', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.strictEqual(currentBranch(dir), 'main');
});

// The invariant worth stating: whatever git legally put after "refs/heads/"
// on the HEAD line comes back out unchanged. Built from char/segment
// arbitraries rather than fc.stringMatching, matching the hexArb style in
// test/look.test.js -- and it is what caught "a branch name containing a
// slash survives whole" needing its own fixed example above in the first
// place, before this generalised it.
const SEGMENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('');
const segmentArb = fc.array(fc.constantFrom(...SEGMENT_CHARS), { minLength: 1, maxLength: 12 })
  .map(chars => chars.join(''));
const branchNameArb = fc.array(segmentArb, { minLength: 1, maxLength: 3 })
  .map(parts => parts.join('/'));

test('property: any ref: refs/heads/<name> line reports exactly <name>', () => {
  fc.assert(fc.property(branchNameArb, (name) => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${name}\n`);
    return currentBranch(dir) === name;
  }));
});

test('a branch name containing a slash survives whole', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/header-project-branch\n');
  assert.strictEqual(currentBranch(dir), 'feat/header-project-branch');
});

test('detached HEAD reports a short SHA, not a branch name', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.git'));
  const sha = 'a'.repeat(40);
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), sha + '\n');
  assert.strictEqual(currentBranch(dir), 'a'.repeat(7));
});

test('a worktree resolves its gitdir pointer before reading HEAD', () => {
  // Real layout: <main>/.git/worktrees/<name>/HEAD holds the worktree's own
  // branch; <worktree>/.git is a FILE containing "gitdir: <path to that dir>".
  const main = tempDir();
  const worktreeGitDir = path.join(main, '.git', 'worktrees', 'frosty-banzai');
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/spike/probe\n');

  const worktree = tempDir();
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);

  assert.strictEqual(currentBranch(worktree), 'spike/probe');
});

test('a relative gitdir pointer resolves against the worktree, not cwd', () => {
  const main = tempDir();
  const worktreeGitDir = path.join(main, '.git', 'worktrees', 'frosty-banzai');
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/spike/probe\n');

  const worktree = tempDir();
  const relative = path.relative(worktree, worktreeGitDir);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${relative}\n`);

  assert.strictEqual(currentBranch(worktree), 'spike/probe');
});

test('not a git repo at all reports no branch', () => {
  const dir = tempDir();
  assert.strictEqual(currentBranch(dir), null);
});

test('a .git file with no gitdir line reports no branch, not a throw', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '.git'), 'not a real pointer file\n');
  assert.strictEqual(currentBranch(dir), null);
});

test('a HEAD file that is neither a symbolic ref nor a full SHA reports no branch', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'garbage\n');
  assert.strictEqual(currentBranch(dir), null);
});

test('absence is not a path -- non-string and empty cwd both report no branch', () => {
  assert.strictEqual(currentBranch(null), null);
  assert.strictEqual(currentBranch(undefined), null);
  assert.strictEqual(currentBranch(''), null);
  assert.strictEqual(currentBranch('   '), null);
});

// NOTE FOR MUTATION RUNS: like project-dir.test.js's real-directory check, this
// asserts about the real checkout, so it must be deselected inside a sandboxed
// mutant copy of the tree (.stryker-tmp / mutmut's mutants/) where it would
// compare against the wrong repo. It kills no mutant; its subject is this
// machine.
test('AGREES WITH REAL GIT on this checkout', () => {
  let real;
  try {
    real = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return;                       // no git on this machine: nothing to cross-check
  }
  if (real === 'HEAD') return;    // detached in the real checkout: SHA vs SHA below
  assert.strictEqual(currentBranch(__dirname), real);
});
