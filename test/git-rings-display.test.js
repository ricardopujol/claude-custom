'use strict';
/**
 * What the Git panel SAYS (documentation/PLAN_GIT_TREE.md Task 10; card cut to Ricardo's ask on
 * 2026-10-01: name, what it was for in 15 words, one summary line, who worked on it). The SVG itself
 * is checked in a real window by verify/probe-git-tree.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { fmtTokens, cardModel, hubCard, footer } = require('../app/git-rings-display');

const b = extra => ({ name: 'feat/a', state: 'merged', place: 'dev', pr: 82, why: 'Dock zones, panels that fill',
  when: '2026-10-01', commits: 12, spend: 1234567, runs: 3, people: [], folder: null, ...extra });

test('tokens read the way the mock showed them, and never as "1000k" or "10.0M" (PR #85 Dexter F4 / Miguel S2)', () => {
  assert.deepStrictEqual([0, 950, 12345, 999499, 999500, 999999, 1234567, 9949999, 9960000, 23000000].map(fmtTokens),
    ['0', '950', '12k', '999k', '1.0M', '1.0M', '1.2M', '9.9M', '10M', '23M']);
});

test('the work days on the card: first to last, or the one day (PR #85 Dexter F6)', () => {
  assert.match(cardModel(b({ first: '2026-09-20', last: '2026-09-23' }), { prsKnown: true }).sum, / · Sep 20 → Sep 23 · merged Oct 1$/);
  assert.match(cardModel(b({ first: '2026-10-01', last: '2026-10-01' }), { prsKnown: true }).sum, / · Oct 1$/);
  assert.match(cardModel(b({ state: 'unmerged', pr: null, first: '2026-09-28', last: '2026-10-01', when: '2026-10-01' }), { prsKnown: true }).sum,
    / · Sep 28 → Oct 1$/);
});

test('a day that is not a real date is left out, never "undefined" (PR #85 Miguel S2)', () => {
  assert.doesNotMatch(cardModel(b({ when: '2026-13-01' }), { prsKnown: true }).sum, /undefined/);
  assert.doesNotMatch(cardModel(b({ when: '2026-00-07' }), { prsKnown: true }).sum, /undefined/);
});

test('the card: name, PR and state, what it was for, one summary line', () => {
  const c = cardModel(b(), { current: 'develop', prsKnown: true });
  assert.deepStrictEqual([c.title, c.kind, c.why, c.sum], ['feat/a', '#82 · merged', 'Dock zones, panels that fill', '1.2M tokens · 12 commits · Oct 1']);
  assert.strictEqual(c.jump, false);
});

test('one commit is "1 commit" (the window probe showed "1 commits")', () => {
  assert.match(cardModel(b({ commits: 1 }), { prsKnown: true }).sum, / · 1 commit · /);
});

test('you are here is marked on the card', () => {
  assert.strictEqual(cardModel(b({ name: 'develop2' }), { current: 'develop2', prsKnown: true }).title, '▶ develop2');
});

test('no token record is said, never shown as 0', () => {
  assert.match(cardModel(b({ spend: null }), { prsKnown: true }).sum, /^no token record · /);
  assert.match(cardModel(b({ spend: 0 }), { prsKnown: true }).sum, /^0 tokens · /);
});

test('where it was worked on is in the summary when it had its own worktree', () => {
  assert.match(cardModel(b({ place: 'worktree', folder: 'C:/p/feat-a' }), { prsKnown: true }).sum, /its own worktree, open now$/);
  assert.match(cardModel(b({ place: 'had-worktree' }), { prsKnown: true }).sum, /its own worktree$/);
  assert.doesNotMatch(cardModel(b(), { prsKnown: true }).sum, /worktree/);
});

test('jump is offered only for a worktree that is open now', () => {
  assert.strictEqual(cardModel(b({ place: 'worktree', folder: 'C:/p/feat-a' }), { prsKnown: true }).jump, true);
  assert.strictEqual(cardModel(b({ place: 'worktree', folder: null }), { prsKnown: true }).jump, false);
  assert.strictEqual(cardModel(b({ place: 'had-worktree' }), { prsKnown: true }).jump, false);
});

test('no why: a deleted branch and a branch with nothing to go on each say so', () => {
  const del = cardModel(b({ state: 'deleted', why: null, pr: null, commits: null }), { prsKnown: true });
  assert.strictEqual(del.kind, 'deleted, never merged');
  assert.strictEqual(del.whyMissing, true);
  assert.match(del.why, /only in the transcripts/);
  assert.strictEqual(cardModel(b({ why: null }), { prsKnown: true }).whyMissing, true);
});

test('an unmerged branch says when its PR status is unknown (gh failed)', () => {
  assert.strictEqual(cardModel(b({ state: 'unmerged', pr: null }), { prsKnown: false }).kind, 'unmerged · PR status unknown');
  assert.strictEqual(cardModel(b({ state: 'unmerged', pr: null }), { prsKnown: true }).kind, 'unmerged, no PR');
  assert.strictEqual(cardModel(b({ state: 'open', pr: 90 }), { prsKnown: true }).kind, '#90 · PR open');
});

test('who worked on it: the top 4, then "+N more"', () => {
  const people = ['Dexter', 'Miguel', 'Mortimer', 'Paris', 'Vera', 'general'].map((name, i) => ({ name, runs: i + 1, spend: 1000 * (6 - i) }));
  const c = cardModel(b({ people }), { prsKnown: true });
  assert.deepStrictEqual(c.people, [
    { name: 'Dexter', runs: 1, spend: '6k' }, { name: 'Miguel', runs: 2, spend: '5k' },
    { name: 'Mortimer', runs: 3, spend: '4k' }, { name: 'Paris', runs: 4, spend: '3k' }]);
  assert.strictEqual(c.more, 2);
});

test('the hub card: the integration branch, its spend and its people', () => {
  const c = hubCard({ integration: 'develop', current: 'develop', mainMerges: 0, hub: { spend: 26877609, people: [] } });
  assert.deepStrictEqual([c.title, c.kind, c.sum], ['▶ develop', 'integration branch', '27M tokens · main has 0 merges']);
  assert.strictEqual(hubCard({ integration: 'develop', mainMerges: null, hub: { spend: null, people: [] } }).sum, 'no token record');
});

test('the hub shows the whole tree\'s total; its card says both numbers, each named (PR #85 Dexter F8)', () => {
  const c = hubCard({ integration: 'develop', mainMerges: 1, totalSpend: 106277454, hub: { spend: 26877609, people: [] } });
  assert.strictEqual(c.sum, '27M on develop itself · 106M across every branch · main has 1 merge');
});

test('the footer counts every state, and a total that is unknown says so', () => {
  const tree = { totalSpend: 106277454, mainMerges: 0, branches: [
    b(), b({ state: 'open' }), b({ state: 'unmerged' }), b({ state: 'unmerged' }), b({ state: 'deleted' })] };
  assert.deepStrictEqual(footer(tree), {
    line1: '5 branches · 106M tokens', line2: '1 merged · 1 open · 2 unmerged · 1 deleted', main: 'main · 0 merges' });
  assert.strictEqual(footer({ ...tree, totalSpend: null, mainMerges: null }).line1, '5 branches · no token record yet');
  assert.strictEqual(footer({ ...tree, mainMerges: null }).main, null);
});

test('one branch and one merge read in the singular (PR #85 Dexter F5)', () => {
  assert.deepStrictEqual(footer({ totalSpend: 5, mainMerges: 1, branches: [b()] }),
    { line1: '1 branch · 5 tokens', line2: '1 merged · 0 open · 0 unmerged · 0 deleted', main: 'main · 1 merge' });
});

test('with open PRs unknown (gh failed) the footer never says "0 open" (PR #85 Dexter F3)', () => {
  const tree = { totalSpend: 5, mainMerges: 0, prsKnown: false,
    branches: [b(), b({ state: 'unmerged' }), b({ state: 'unmerged' }), b({ state: 'deleted' })] };
  assert.strictEqual(footer(tree).line2, '1 merged · 2 not merged, PR status unknown · 1 deleted');
});
