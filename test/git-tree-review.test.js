'use strict';
/**
 * PR #84 review of the git tree's model (Dexter + Miguel, 2026-10-01): each test is a finding's
 * counterexample. Reports: C:\Users\ricar\.claude\reviews\claude-custom\2026-10-01-feat-git-tree-*.md
 */
const test = require('node:test');
const assert = require('node:assert');

const { buildTree } = require('../host/git-tree');

const ROOT = 'C:\\p';
const total = (spend, extra = {}) => ({ spend, loose: 0, first: '2026-09-20', last: '2026-09-21', cwds: ['C:\\p\\dev'], runs: [], ...extra });
const merge = (branch, pr, date, extra = {}) => ({ branch, pr, date, title: `feat: ${branch} ${pr}`, commits: 1, ...extra });
const lane = (name, ahead, extra = {}) => ({ name, remote: false, date: '2026-09-30', ahead, first: `feat: ${name}`, worktree: null, ...extra });
const history = (over = {}) => ({ ok: true, integration: 'develop', mainMerges: 0, merges: [], lanes: [],
  worktrees: [{ path: 'C:/p/dev', branch: 'develop' }], ...over });
const build = (h, totals = {}, openPrs = new Map()) => buildTree({ history: h, totals, openPrs, projectRoot: ROOT, current: 'develop' });
const named = (t, n) => t.branches.filter(b => b.name === n);

test('Dexter F2: a name merged twice is ONE spoke, its spend counted once', () => {
  const t = build(history({ merges: [merge('feat/x', 10, '2026-09-20', { commits: 2 }), merge('feat/x', 20, '2026-09-25', { commits: 3 })] }),
    { 'feat/x': total(100) });
  assert.strictEqual(named(t, 'feat/x').length, 1);
  const b = named(t, 'feat/x')[0];
  assert.deepStrictEqual([b.pr, b.when, b.commits, b.spend, b.why], [20, '2026-09-25', 5, 100, 'Feat/x 20']);
  assert.strictEqual(t.totalSpend, 100);
});

test('Dexter F2: a merged name whose ref moved on again is live again: one spoke, in its live state', () => {
  const t = build(history({ merges: [merge('feat/x', 10, '2026-09-20')], lanes: [lane('feat/x', 2)] }),
    { 'feat/x': total(50) }, new Map([['feat/x', { pr: 30, title: 'feat: round two' }]]));
  assert.strictEqual(named(t, 'feat/x').length, 1);
  assert.deepStrictEqual(['state', 'pr', 'commits', 'why'].map(k => named(t, 'feat/x')[0][k]), ['open', 30, 2, 'Round two']);
});

test('a merged branch whose ref is still around (0 ahead) stays one merged spoke', () => {
  const t = build(history({ merges: [merge('feat/x', 10, '2026-09-20')], lanes: [lane('feat/x', 0)] }));
  assert.deepStrictEqual(named(t, 'feat/x').map(b => [b.state, b.pr]), [['merged', 10]]);
});

test('Dexter F9: a fresh worktree lane with nothing committed yet is unmerged, not merged', () => {
  const t = build(history({ lanes: [lane('feat/new', 0, { worktree: 'C:/p/feat-new' })], worktrees: [{ path: 'C:/p/feat-new', branch: 'feat/new' }] }),
    { 'feat/new': total(300000) });
  assert.deepStrictEqual(['state', 'place', 'commits'].map(k => named(t, 'feat/new')[0][k]), ['unmerged', 'worktree', 0]);
});

test('Dexter F9, its limit: a MERGED branch whose worktree is still around stays merged, with its PR and why', () => {
  // the probe caught this one: feat/layout-dock-zones (PR #82) kept its worktree after the merge
  const t = build(history({ merges: [merge('feat/x', 82, '2026-10-01')], lanes: [lane('feat/x', 0, { worktree: 'C:/p/feat-x', first: null })],
    worktrees: [{ path: 'C:/p/feat-x', branch: 'feat/x' }] }));
  assert.deepStrictEqual(['state', 'pr', 'why', 'place'].map(k => named(t, 'feat/x')[0][k]), ['merged', 82, 'Feat/x 82', 'worktree']);
});

test('Dexter F9: an open PR that is 0 ahead is open, not merged', () => {
  const t = build(history({ lanes: [lane('feat/pr', 0)] }), {}, new Map([['feat/pr', { pr: 9, title: 'x' }]]));
  assert.strictEqual(named(t, 'feat/pr')[0].state, 'open');
});

test('Dexter F5: open PRs unknown is said, not passed off as "no PR"', () => {
  assert.strictEqual(build(history(), {}, null).prsKnown, false);
  assert.strictEqual(build(history(), {}, new Map()).prsKnown, true);
});

test('Dexter F10: no token record anywhere is a total of null, not 0', () => {
  const t = build(history({ merges: [merge('feat/x', 1, '2026-09-20')] }), {});
  assert.strictEqual(t.totalSpend, null);
  assert.strictEqual(t.hub.spend, null);
});

test('a lone unknown branch with no spend inside the project is not ours: the total stays null', () => {
  // the property "totalSpend is EXACTLY every token that is ours" shrank to this (seed -1386998037)
  assert.strictEqual(build(history(), { 'feat/a': total(0) }).totalSpend, null);
});

test('Dexter F13: spend on main, master, HEAD and worktree-agent-* goes to the hub, so the total is every token that is ours', () => {
  const t = build(history({ merges: [merge('feat/x', 1, '2026-09-20')] }),
    { develop: total(10), HEAD: total(1), main: total(2), master: total(3), 'worktree-agent-ab12': total(4), 'feat/x': total(5) });
  assert.strictEqual(t.hub.spend, 20);
  assert.strictEqual(t.totalSpend, 25);
});

test('Dexter F7: a run of only loose spend on the hub is not one of the hub\'s people', () => {
  const t = build(history(), { develop: total(10, { runs: [
    { agentType: 'logic-reviewer', spend: 0, loose: 500000 },
    { agentType: 'code-reviewer', spend: 7, loose: 0 },
  ] }) });
  assert.deepStrictEqual(t.hub.people, [{ name: 'Miguel', runs: 1, spend: 7 }]);
});

test("Dexter F7: a lane git knows counts its people's loose spend too", () => {
  const t = build(history({ merges: [merge('feat/x', 1, '2026-09-20')] }),
    { 'feat/x': total(10, { loose: 5, runs: [{ agentType: 'logic-reviewer', spend: 3, loose: 5 }] }) });
  assert.deepStrictEqual(named(t, 'feat/x')[0].people, [{ name: 'Dexter', runs: 1, spend: 8 }]);
});

test('Miguel B2 / Dexter F12: branches named like Object\'s own members are drawn, and the tree is ok', () => {
  const names = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];
  const totals = {};
  names.forEach((n, i) => Object.defineProperty(totals, n, { value: total(i + 1), enumerable: true }));
  const t = build(history({ lanes: names.map(n => lane(n, 1)) }), totals);
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(names.map(n => named(t, n)[0].spend), [1, 2, 3, 4, 5]);
  // and with NO totals for them, they're unknown -- never Object.prototype's members
  const bare = build(history({ lanes: names.map(n => lane(n, 1)) }), {});
  assert.deepStrictEqual(names.map(n => named(bare, n)[0].spend), [null, null, null, null, null]);
});

test('Miguel S: a branch with no known day sorts last, not as the string "null"', () => {
  const t = build(history({ merges: [merge('feat/a', 1, '2026-09-20')], lanes: [lane('feat/z', 1, { date: '' })] }));
  assert.deepStrictEqual(t.branches.map(b => b.name), ['feat/a', 'feat/z']);
});
