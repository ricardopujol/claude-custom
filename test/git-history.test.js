'use strict';
/**
 * The git facts behind the git tree (documentation/PLAN_GIT_TREE.md Tasks 1-2): merges into the
 * integration branch, every ref, the worktrees. Parsers are pure; readHistory runs git through an
 * injected runner, so these tests never touch a real repo.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseMerges, parseRefs, parseWorktrees, integrationOf } = require('../host/git-history');

const US = '\x1f', RS = '\x1e';
const rec = (h, d, s, p, b) => [h, d, s, p, b].join(US) + RS;

test('a PR merge gives its number, branch and the title from the body', () => {
  const out = parseMerges(rec('aaa', '2026-10-01', 'Merge pull request #82 from ricardopujol/feat/layout-dock-zones',
    'p1 p2', 'feat(layout): dock zones\n\nmore'));
  assert.deepStrictEqual(out, [{ hash: 'aaa', date: '2026-10-01', pr: 82, branch: 'feat/layout-dock-zones',
    title: 'feat(layout): dock zones', parents: ['p1', 'p2'] }]);
});

test("a local merge (Merge branch 'x') has no PR and no title", () => {
  const [m] = parseMerges(rec('b', '2026-09-01', "Merge branch 'spike/x' into develop", 'p1 p2', ''));
  assert.strictEqual(m.pr, null);
  assert.strictEqual(m.branch, 'spike/x');
  assert.strictEqual(m.title, null);
});

test('records after a newline (CRLF too) parse; junk and single-parent records are dropped', () => {
  const t = '\r\n' + rec('c', '2026-09-02', 'Merge pull request #1 from o/feat/a', 'p1 p2', '') + '\n' +
    rec('d', '2026-09-02', 'not a merge subject', 'p1 p2', '') +
    rec('e', '2026-09-02', 'Merge pull request #2 from o/b', 'p1', '');
  assert.deepStrictEqual(parseMerges(t).map(m => m.hash), ['c']);
});

test('not a string is no merges, no refs, no worktrees', () => {
  assert.deepStrictEqual(parseMerges(undefined), []);
  assert.deepStrictEqual(parseRefs(null), []);
  assert.deepStrictEqual(parseWorktrees(42), []);
});

test('refs: heads and remotes, remote HEAD skipped, the full ref kept for git', () => {
  const t = ['refs/heads/develop\x1f2026-10-01', 'refs/heads/feat/x\x1f2026-09-30',
    'refs/remotes/origin/HEAD\x1f2026-10-01', 'refs/remotes/origin/feat/y\x1f2026-09-29', ''].join('\n');
  assert.deepStrictEqual(parseRefs(t), [
    { name: 'develop', ref: 'refs/heads/develop', remote: false, date: '2026-10-01' },
    { name: 'feat/x', ref: 'refs/heads/feat/x', remote: false, date: '2026-09-30' },
    { name: 'feat/y', ref: 'refs/remotes/origin/feat/y', remote: true, date: '2026-09-29' }]);
});

test('worktree porcelain: path and branch; a detached worktree has branch null', () => {
  const t = 'worktree C:/p/dev\nHEAD 1\nbranch refs/heads/develop\n\nworktree C:/p/feat-x\nHEAD 2\ndetached\n';
  assert.deepStrictEqual(parseWorktrees(t),
    [{ path: 'C:/p/dev', branch: 'develop' }, { path: 'C:/p/feat-x', branch: null }]);
});

test('worktree porcelain with CRLF line ends', () => {
  const t = 'worktree C:/p/dev\r\nbranch refs/heads/develop\r\n\r\nworktree C:/p/feat-x\r\nbranch refs/heads/feat/x\r\n';
  assert.deepStrictEqual(parseWorktrees(t),
    [{ path: 'C:/p/dev', branch: 'develop' }, { path: 'C:/p/feat-x', branch: 'feat/x' }]);
});

test('integration: develop, else main, else master, else null; remote refs do not count', () => {
  const r = n => ({ name: n, remote: false });
  assert.strictEqual(integrationOf([r('main'), r('develop')]), 'develop');
  assert.strictEqual(integrationOf([r('master'), r('main')]), 'main');
  assert.strictEqual(integrationOf([r('master')]), 'master');
  assert.strictEqual(integrationOf([{ name: 'develop', remote: true }]), null);
});
