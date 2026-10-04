'use strict';
/**
 * The merged marker (contract B): `<git-dir>/claude-merged.json` =
 * `{"branch","pr","mergedAt"}`, written when a worktree's PR merges. Seeing
 * it starts the path to REMOVING A FOLDER, so anything short of a fully valid
 * marker for the expected branch reads as "not merged" (design:
 * documentation/PLAN_WORKTREE_TABS.md, "Unreadable marker = not merged").
 *
 * Fixtures hand-build a worktree's `.git` FILE and its git-dir, as
 * git-branch.test.js does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { readMergedMarker } = require('../host/merged-marker');
const { tmpDir } = require('./tmp-dir');

const VALID = { branch: 'feat/x', pr: 71, mergedAt: '2026-09-29T10:00:00Z' };

// <base>/dev/.git/worktrees/feat-x is the git-dir; <base>/feat-x is the
// worktree, whose `.git` file points at it.
function makeWorktree({ relative = false } = {}) {
  const base = tmpDir('merged-marker-test-');
  const gitDir = path.join(base, 'dev', '.git', 'worktrees', 'feat-x');
  fs.mkdirSync(gitDir, { recursive: true });
  const wt = path.join(base, 'feat-x');
  fs.mkdirSync(wt);
  const pointer = relative ? path.relative(wt, gitDir) : gitDir;
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${pointer}\n`);
  return { wt, gitDir };
}

function writeMarker(gitDir, value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  fs.writeFileSync(path.join(gitDir, 'claude-merged.json'), raw);
}

test('a valid marker for the expected branch is read back', () => {
  const { wt, gitDir } = makeWorktree();
  writeMarker(gitDir, VALID);
  assert.deepStrictEqual(readMergedMarker(wt, 'feat/x'), VALID);
});

test('only the three contract fields come back', () => {
  const { wt, gitDir } = makeWorktree();
  writeMarker(gitDir, { ...VALID, extra: 'ignored', force: true });
  assert.deepStrictEqual(readMergedMarker(wt, 'feat/x'), VALID);
});

test('a relative gitdir: pointer resolves against the worktree, not the cwd', () => {
  const { wt, gitDir } = makeWorktree({ relative: true });
  writeMarker(gitDir, VALID);
  assert.deepStrictEqual(readMergedMarker(wt, 'feat/x'), VALID);
});

// Dexter F5: PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, and
// JSON.parse rejects it -- a valid marker would silently never fire W4.
test('a valid marker written with a UTF-8 BOM is read', () => {
  const { wt, gitDir } = makeWorktree();
  fs.writeFileSync(path.join(gitDir, 'claude-merged.json'), String.fromCharCode(0xfeff) + JSON.stringify(VALID));
  assert.deepStrictEqual(readMergedMarker(wt, 'feat/x'), VALID);
});

test('no marker is not merged', () => {
  const { wt } = makeWorktree();
  assert.strictEqual(readMergedMarker(wt, 'feat/x'), null);
});

test('an unreadable, empty or non-JSON marker is not merged', () => {
  for (const raw of ['', '   \n', '{', 'merged', '{"branch":"feat/x",}']) {
    const { wt, gitDir } = makeWorktree();
    writeMarker(gitDir, raw);
    assert.strictEqual(readMergedMarker(wt, 'feat/x'), null, JSON.stringify(raw));
  }
  const { wt, gitDir } = makeWorktree();
  fs.mkdirSync(path.join(gitDir, 'claude-merged.json'));      // a directory can't be read as a file
  assert.strictEqual(readMergedMarker(wt, 'feat/x'), null);
});

test('JSON that is not an object is not merged', () => {
  for (const v of [null, [], [VALID], 'feat/x', 71, true]) {
    const { wt, gitDir } = makeWorktree();
    writeMarker(gitDir, JSON.stringify(v));
    assert.strictEqual(readMergedMarker(wt, 'feat/x'), null, JSON.stringify(v));
  }
});

test('a marker for another branch, or a bad branch field, is not merged', () => {
  for (const branch of ['feat/y', '', undefined, null, 7, ['feat/x']]) {
    const { wt, gitDir } = makeWorktree();
    writeMarker(gitDir, { ...VALID, branch });
    assert.strictEqual(readMergedMarker(wt, 'feat/x'), null, JSON.stringify(branch));
  }
});

test('without a usable expected branch nothing is merged', () => {
  for (const expected of [null, undefined, '', 7]) {
    const { wt, gitDir } = makeWorktree();
    writeMarker(gitDir, VALID);
    assert.strictEqual(readMergedMarker(wt, expected), null, String(expected));
  }
});

// Strict integer check: Number(null) is 0 and Number('12') is 12, and this
// project has paid for coercing checks before (CLAUDE.md traps).
test('pr must be a positive integer, never coerced', () => {
  for (const pr of [0, -1, 1.5, '12', '', null, true, undefined, [7]]) {
    const { wt, gitDir } = makeWorktree();
    writeMarker(gitDir, { ...VALID, pr });
    assert.strictEqual(readMergedMarker(wt, 'feat/x'), null, JSON.stringify(pr));
  }
});

test('mergedAt must be a date string', () => {
  for (const mergedAt of ['not a date', '', 1759140000000, null, undefined]) {
    const { wt, gitDir } = makeWorktree();
    writeMarker(gitDir, { ...VALID, mergedAt });
    assert.strictEqual(readMergedMarker(wt, 'feat/x'), null, String(mergedAt));
  }
});

// `dev` is the main checkout: its `.git` is a DIRECTORY. It is never merged
// away, even with a marker sitting in its git-dir.
test('dev (a .git directory) is never merged', () => {
  const base = tmpDir('merged-marker-test-');
  fs.mkdirSync(path.join(base, '.git'));
  fs.writeFileSync(path.join(base, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  writeMarker(path.join(base, '.git'), VALID);
  assert.strictEqual(readMergedMarker(base, 'feat/x'), null);
});

test('no .git, a .git file with no gitdir line, or a gitdir that does not exist: not merged', () => {
  assert.strictEqual(readMergedMarker(tmpDir('merged-marker-test-'), 'feat/x'), null);

  const junk = tmpDir('merged-marker-test-');
  fs.writeFileSync(path.join(junk, '.git'), 'not a pointer\n');
  assert.strictEqual(readMergedMarker(junk, 'feat/x'), null);

  const dangling = tmpDir('merged-marker-test-');
  fs.writeFileSync(path.join(dangling, '.git'), `gitdir: ${path.join(dangling, 'nowhere')}\n`);
  assert.strictEqual(readMergedMarker(dangling, 'feat/x'), null);
});

test('a non-string worktree path is not merged', () => {
  for (const v of [null, undefined, '', 42]) assert.strictEqual(readMergedMarker(v, 'feat/x'), null);
});

// For any JSON written as the marker, the result is null or a fully valid
// marker -- never half-valid -- and it is non-null exactly when every rule
// holds. Field values are drawn to hit each rule's edges.
test('PROPERTY: the result is null or a fully valid marker, and valid exactly when every rule holds', () => {
  const { wt, gitDir } = makeWorktree();
  const fieldArb = (good) => fc.oneof(good, fc.jsonValue(), fc.constant(undefined));
  const markerArb = fc.oneof(
    fc.jsonValue(),
    fc.record({
      branch: fieldArb(fc.constantFrom('feat/x', 'feat/y', '')),
      pr: fieldArb(fc.oneof(fc.integer({ min: -3, max: 500 }), fc.double(), fc.constantFrom('7', null))),
      mergedAt: fieldArb(fc.oneof(fc.date({ noInvalidDate: true }).map(d => d.toISOString()), fc.string())),
    }, { requiredKeys: [] }),
  );
  fc.assert(fc.property(markerArb, (value) => {
    writeMarker(gitDir, JSON.stringify(value) ?? '');
    const got = readMergedMarker(wt, 'feat/x');
    const stored = JSON.parse(JSON.stringify(value) ?? 'null');
    const valid = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      && stored.branch === 'feat/x'
      && Number.isInteger(stored.pr) && stored.pr > 0
      && typeof stored.mergedAt === 'string' && !Number.isNaN(Date.parse(stored.mergedAt));
    if (!valid) return got === null;
    assert.deepStrictEqual(got, { branch: stored.branch, pr: stored.pr, mergedAt: stored.mergedAt });
    return true;
  }));
});
