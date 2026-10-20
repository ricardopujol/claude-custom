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

// --- PR #202 review: Dexter 4 + Miguel Y2, Dexter 5 + 6 -------------------------------------------

test('Dexter 4: a gh that hangs does not hold the tree: it arrives with no issue links after the short bound', async () => {
  const d = deps({ issuesTimeoutMs: 20, readIssues: () => new Promise(() => {}) });
  const t0 = Date.now();
  const tree = await createGitTreeService(d).get();
  assert.strictEqual(tree.ok, true);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(tree.branches.every(b => b.issue === null));
});

test('Dexter 4: the issue read starts together with the PR read, not after it', async () => {
  const order = [];
  let releasePrs;
  const d = deps({
    readOpenPrs: () => new Promise((res) => { order.push('prs:start'); releasePrs = () => res(new Map()); }),
    readIssues: async () => { order.push('issues:start'); return [ISSUE]; },
  });
  const pending = createGitTreeService(d).get();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(order.sort(), ['issues:start', 'prs:start'], 'both are under way before the slower PR read answers');
  releasePrs();
  assert.strictEqual((await pending).ok, true);
});

test('Dexter 4: a reader that rejects is no issue, and still does not fail the tree', async () => {
  const tree = await createGitTreeService(deps({ readIssues: async () => { throw new Error('gh broke'); } })).get();
  assert.strictEqual(tree.ok, true);
});

test('Dexter 5: a stored link shows even when the open list lacks the issue (closed, or older than the newest 50)', async () => {
  const asked = [];
  const stored = { number: 99, title: 'Gone but remembered', url: 'https://github.com/o/r/issues/99' };
  const d = deps({
    readIssues: async () => [],
    readLink: (name, folder) => { asked.push([name, folder]); return name === 'feat/99-gone' ? stored : null; },
  });
  const tree = await createGitTreeService(d).get();
  assert.deepStrictEqual(byName(tree, 'feat/99-gone').issue, stored);
  assert.ok(asked.some(([n]) => n === 'feat/99-gone'));
});

test('Dexter 5: a stored link works with no issue reader at all (no gh), and a malformed one is no issue', async () => {
  const tree = await createGitTreeService(deps({ readLink: (n) => (n === 'feat/plain' ? { number: 5, title: 'T', url: null } : null) })).get();
  assert.deepStrictEqual(byName(tree, 'feat/plain').issue, { number: 5, title: 'T', url: null });
  for (const bad of [{ number: '5' }, 'x', 5, [], { title: 'x' }]) {
    const t = await createGitTreeService(deps({ readLink: () => bad })).get();
    assert.ok(t.branches.every(b => b.issue === null), JSON.stringify(bad));
  }
  const throwing = await createGitTreeService(deps({ readLink: () => { throw new Error('disk'); } })).get();
  assert.strictEqual(throwing.ok, true);
});

test('Dexter 6: the store is asked with the branch AND its folder, so another worktree\'s link or a switched branch is not reused', async () => {
  const asked = [];
  const d = deps({
    readHistory: async () => ({ ...HISTORY, worktrees: [{ path: 'C:/p/feat-12', branch: 'feat/12-fix-it' }] }),
    readLink: (name, folder) => { asked.push([name, folder]); return null; },
  });
  await createGitTreeService(d).get();
  assert.ok(asked.some(([n, f]) => n === 'feat/12-fix-it' && f === 'C:/p/feat-12'), JSON.stringify(asked));
});

test('a stored link wins over one derived from the list', async () => {
  const stored = { number: 12, title: 'Renamed since', url: 'https://github.com/o/r/issues/12' };
  const tree = await createGitTreeService(deps({ readIssues: async () => [ISSUE], readLink: (n) => (n === 'feat/12-fix-it' ? stored : null) })).get();
  assert.strictEqual(byName(tree, 'feat/12-fix-it').issue.title, 'Renamed since');
});
