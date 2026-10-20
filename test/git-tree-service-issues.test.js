'use strict';
/**
 * The Git drawer and the GitHub issue a branch was started from (BACKLOG #119 A6): the tree service attaches `issue`
 * to a branch the + form made from an issue, when the open-issue list has it. Optional, like the PR's page: a reader
 * that fails or answers oddly is "none", never a failed tree, and no reader means gh isn't asked at all.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createGitTreeService } = require('../host/git-tree-service');

const HISTORY = { ok: true, integration: 'develop', mainMerges: 0, worktrees: [], lanes: [], merges: [
  { branch: 'feat/12-fix-it', pr: 1, date: '2026-09-20', title: 'feat: a', commits: 2 },
  { branch: 'feat/plain', pr: 2, date: '2026-09-21', title: 'feat: b', commits: 1 },
  { branch: 'feat/99-gone', pr: 3, date: '2026-09-22', title: 'feat: c', commits: 1 },
] };
const ISSUE = { number: 12, title: 'Fix it', labels: [], assignees: [], updatedAt: null, url: 'https://github.com/o/r/issues/12' };

function deps(over = {}) {
  const calls = { issues: 0 };
  return {
    calls,
    cwd: 'C:\p\dev', projectRoot: 'C:\p', projectsDir: 'X', ledgerFile: () => 'L',
    readHistory: async () => HISTORY,
    loadLedger: async () => ({ ledger: { version: 1, files: {} }, state: 'missing', corrupt: false }),
    updateLedger: async (l) => ({ ledger: l, read: 0, errors: 0 }),
    saveLedger: async (f, l) => l,
    readOpenPrs: async () => new Map(),
    currentBranch: () => 'develop',
    now: () => 0,
    ...over,
  };
}
const byName = (tree, name) => tree.branches.find(b => b.name === name);

test('a branch made from an open issue carries {number, title, url}; others carry null', async () => {
  const d = deps({ readIssues: async () => { d.calls.issues++; return [ISSUE]; } });
  const tree = await createGitTreeService(d).get();
  assert.strictEqual(tree.ok, true);
  assert.deepStrictEqual(byName(tree, 'feat/12-fix-it').issue, { number: 12, title: 'Fix it', url: 'https://github.com/o/r/issues/12' });
  assert.strictEqual(byName(tree, 'feat/plain').issue, null);
  assert.strictEqual(byName(tree, 'feat/99-gone').issue, null, 'a number the open list lacks is no issue');
});

test('no reader: no issue on any branch, and nothing was asked', async () => {
  const tree = await createGitTreeService(deps()).get();
  assert.ok(tree.branches.every(b => b.issue === null));
});

test('the reader is not asked when no branch is named like an issue branch', async () => {
  const d = deps({
    readHistory: async () => ({ ...HISTORY, merges: [HISTORY.merges[1]] }),
    readIssues: async () => { d.calls.issues++; return [ISSUE]; },
  });
  await createGitTreeService(d).get();
  assert.strictEqual(d.calls.issues, 0);
});

test('a reader that fails, rejects or answers oddly is no issue, not a failed tree', async () => {
  for (const readIssues of [async () => null, async () => { throw new Error('gh broke'); }, async () => 'x', async () => ({}), async () => [null, 5, { number: 'x' }]]) {
    const tree = await createGitTreeService(deps({ readIssues })).get();
    assert.strictEqual(tree.ok, true);
    assert.ok(tree.branches.every(b => b.issue === null));
  }
});

test('an issue record of the wrong shape is cut down to the three fields, or dropped', async () => {
  const tree = await createGitTreeService(deps({
    readIssues: async () => [{ ...ISSUE, labels: ['bug'], assignees: ['x'], body: 'secret' }],
  })).get();
  assert.deepStrictEqual(Object.keys(byName(tree, 'feat/12-fix-it').issue).sort(), ['number', 'title', 'url']);
});
