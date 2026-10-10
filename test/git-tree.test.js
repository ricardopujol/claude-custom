'use strict';
/**
 * The git tree's model (documentation/PLAN_GIT_TREE.md Task 7, G4-G7): git facts + the ledger's
 * totals + open PRs -> one entry per branch, with what happened to it (state), where it was worked
 * on (place), what it was for (why), and what it cost (spend: null when nothing was recorded).
 */
const test = require('node:test');
const assert = require('node:assert');

const { buildTree, purpose, personOf } = require('../host/git-tree');

const ROOT = 'C:\\p';
const total = (spend, extra = {}) => ({ spend, loose: 0, first: '2026-09-20', last: '2026-09-21', cwds: ['C:\\p\\dev'], runs: [], ...extra });
const history = (over = {}) => ({
  ok: true, integration: 'develop', mainMerges: 0,
  merges: [{ branch: 'feat/a', pr: 3, date: '2026-09-20', title: 'feat(a): the first thing', commits: 4 }],
  lanes: [],
  worktrees: [{ path: 'C:/p/dev', branch: 'develop' }],
  ...over,
});
const build = (h, totals = {}, openPrs = new Map(), current = 'develop') => buildTree({ history: h, totals, openPrs, projectRoot: ROOT, current });
const byName = (tree, n) => tree.branches.find(b => b.name === n);

test('a merged PR: state, PR number, why from its title, merge day, commits', () => {
  const t = build(history(), { 'feat/a': total(100) });
  assert.deepStrictEqual(byName(t, 'feat/a'), { name: 'feat/a', state: 'merged', place: 'dev', pr: 3, remote: false,
    why: 'The first thing', when: '2026-09-20', commits: 4, spend: 100, runs: 0, people: [], folder: null,
    first: '2026-09-20', last: '2026-09-21' });
});

test('no token record is spend null, never 0', () => {
  assert.strictEqual(byName(build(history(), {}), 'feat/a').spend, null);
});

test('an unmerged branch with an open PR is open, with the PR title as why', () => {
  const h = history({ lanes: [{ name: 'feat/b', remote: false, date: '2026-09-30', ahead: 2, first: 'wip: x', worktree: null }] });
  const b = byName(build(h, {}, new Map([['feat/b', { pr: 9, title: 'feat(b): open thing' }]])), 'feat/b');
  assert.strictEqual(b.state, 'open');
  assert.strictEqual(b.pr, 9);
  assert.strictEqual(b.why, 'Open thing');
});

test('ahead of develop with no PR is unmerged, why from its first commit; 0 ahead is merged (contained)', () => {
  const h = history({ lanes: [
    { name: 'spike/c', remote: false, date: '2026-09-15', ahead: 2, first: 'spike: measure a thing', worktree: null },
    { name: 'rebase/d', remote: false, date: '2026-09-16', ahead: 0, first: null, worktree: null },
  ] });
  const t = build(h);
  assert.strictEqual(byName(t, 'spike/c').state, 'unmerged');
  assert.strictEqual(byName(t, 'spike/c').why, 'Measure a thing');
  assert.strictEqual(byName(t, 'rebase/d').state, 'merged');
  assert.strictEqual(byName(t, 'rebase/d').pr, null);
});

test('open PRs unknown (gh failed) leaves an ahead branch unmerged, not open', () => {
  const h = history({ lanes: [{ name: 'feat/b', remote: false, date: '2026-09-30', ahead: 2, first: 'x', worktree: null }] });
  assert.strictEqual(byName(build(h, {}, null), 'feat/b').state, 'unmerged');
});

test('deleted: spend tagged with a branch git does not know', () => {
  const b = byName(build(history(), { 'try/drag-drop': total(2000, { last: '2026-09-18' }) }), 'try/drag-drop');
  assert.deepStrictEqual([b.state, b.spend, b.why, b.when, b.commits, b.pr], ['deleted', 2000, null, '2026-09-18', null, null]);
});

test('a branch git does not know with only LOOSE spend is not ours: not drawn', () => {
  assert.strictEqual(byName(build(history(), { 'feat/other': total(0, { loose: 50 }) }), 'feat/other'), undefined);
});

test('loose spend counts for a branch git knows, never for the integration branch', () => {
  const t = build(history(), { 'feat/a': total(100, { loose: 7 }), develop: total(10, { loose: 99 }) });
  assert.strictEqual(byName(t, 'feat/a').spend, 107);
  assert.strictEqual(t.hub.spend, 10);
});

test('the integration branch, main, HEAD and worktree-agent-* are never spokes; their spend is the hub\'s', () => {
  const t = build(history(), { develop: total(10), HEAD: total(5), main: total(1), 'worktree-agent-abc': total(3) });
  assert.deepStrictEqual(t.branches.map(b => b.name), ['feat/a']);
  assert.strictEqual(t.hub.spend, 19);
});

test('place: open worktree; had its own worktree (a cwd in <root>\\<branch-dashes>); else built in dev', () => {
  const h = history({
    merges: [
      { branch: 'feat/a', pr: 1, date: '2026-09-20', title: 'a', commits: 1 },
      { branch: 'feat/b', pr: 2, date: '2026-09-21', title: 'b', commits: 1 },
    ],
    lanes: [{ name: 'feat/c', remote: false, date: '2026-09-30', ahead: 1, first: 'c', worktree: 'C:/p/feat-c' }],
    worktrees: [{ path: 'C:/p/dev', branch: 'develop' }, { path: 'C:/p/feat-c', branch: 'feat/c' }],
  });
  const t = build(h, { 'feat/a': total(1, { cwds: ['c:\\P\\feat-a\\sub'] }), 'feat/b': total(1) });
  assert.deepStrictEqual(['feat/a', 'feat/b', 'feat/c'].map(n => byName(t, n).place), ['had-worktree', 'dev', 'worktree']);
  // the open worktree's folder rides along, for the panel's *Jump to its tab*; only an open one
  assert.deepStrictEqual(['feat/a', 'feat/b', 'feat/c'].map(n => byName(t, n).folder), [null, null, 'C:/p/feat-c']);
});

test('people: runs folded per person, by spend; named teammates fold into the person', () => {
  const runs = [{ agentType: 'logic-reviewer', spend: 5 }, { agentType: 'dexter-pr69', spend: 7 },
    { agentType: 'code-reviewer', spend: 20 }, { agentType: 'electron-pro', spend: 1 }];
  const b = byName(build(history(), { 'feat/a': total(100, { runs }) }), 'feat/a');
  assert.strictEqual(b.runs, 4);
  assert.deepStrictEqual(b.people, [{ name: 'Miguel', runs: 1, spend: 20 }, { name: 'Dexter', runs: 2, spend: 12 },
    { name: 'electron-pro', runs: 1, spend: 1 }]);
});

test('sorted by when, then PR number', () => {
  const h = history({ merges: [
    { branch: 'b', pr: 5, date: '2026-09-21', title: null, commits: 1 },
    { branch: 'a', pr: 7, date: '2026-09-20', title: null, commits: 1 },
    { branch: 'c', pr: 4, date: '2026-09-21', title: null, commits: 1 },
  ] });
  assert.deepStrictEqual(build(h).branches.map(b => b.name), ['a', 'c', 'b']);
});

test('totals for the whole tree: hub + every spoke (nulls as nothing)', () => {
  const t = build(history(), { develop: total(10), 'feat/a': total(5), 'gone/x': total(3) });
  assert.strictEqual(t.totalSpend, 18);
});

test('history not ok passes its error through; there is no tree', () => {
  assert.deepStrictEqual(build({ ok: false, error: 'not a git repository' }), { ok: false, error: 'not a git repository' });
});

test('the current branch and the integration facts ride along', () => {
  const t = build(history(), {}, new Map(), 'feat/a');
  assert.deepStrictEqual([t.ok, t.current, t.integration, t.mainMerges], [true, 'feat/a', 'develop', 0]);
});

// ---------- purpose: what it was for, 15 words at most ----------
test('purpose strips a conventional prefix and capitalises', () => {
  assert.strictEqual(purpose('feat(layout): dock zones, panels that fill'), 'Dock zones, panels that fill');
  assert.strictEqual(purpose('fix!: a thing'), 'A thing');
  assert.strictEqual(purpose('Plain title'), 'Plain title');
});
test('purpose turns " -- " into ": " and cuts to 15 words with an ellipsis', () => {
  assert.strictEqual(purpose('feat(strip): the menu -- every session'), 'The menu: every session');
  const long = purpose('feat: ' + Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '));
  assert.strictEqual(long, 'W0 ' + Array.from({ length: 14 }, (_, i) => `w${i + 1}`).join(' ') + '…');
});
test('purpose of nothing is null', () => {
  assert.strictEqual(purpose(null), null);
  assert.strictEqual(purpose('   '), null);
  assert.strictEqual(purpose('feat:'), null);
});

test('personOf: roles and named teammates fold to the person; anything else is itself', () => {
  assert.deepStrictEqual(['logic-reviewer', 'Dexter-pr42', 'code-reviewer', 'miguel2-pr30', 'mutation-tester',
    'agent-organizer', 'paris-wave2', 'vera-pr34', 'display-integrity-auditor', 'naomi-pr33', 'doc-auditor',
    'general-purpose', 'Explore'].map(personOf),
  ['Dexter', 'Dexter', 'Miguel', 'Miguel', 'Mortimer', 'Paris', 'Paris', 'Vera', 'Vera', 'Naomi', 'Dewey', 'general', 'Explore']);
});

test('personOf: El Gordo and Vladimir, by role and by one-job name', () => {
  assert.deepStrictEqual(['el-gordo', 'gordo-pr42', 'Gordo', 'vladimir', 'vladimir-pr42'].map(personOf),
    ['El Gordo', 'El Gordo', 'El Gordo', 'Vladimir', 'Vladimir']);
});
