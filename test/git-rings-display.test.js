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

test('tokens read the way the mock showed them', () => {
  assert.deepStrictEqual([0, 950, 12345, 999999, 1234567, 23000000].map(fmtTokens), ['0', '950', '12k', '1000k', '1.2M', '23M']);
});

test('the card: name, PR and state, what it was for, one summary line', () => {
  const c = cardModel(b(), { current: 'develop', prsKnown: true });
  assert.deepStrictEqual([c.title, c.kind, c.why, c.sum], ['feat/a', '#82 · merged', 'Dock zones, panels that fill', '1.2M tokens · 12 commits · Oct 1']);
  assert.strictEqual(c.jump, false);
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

test('the footer counts every state, and a total that is unknown says so', () => {
  const tree = { totalSpend: 106277454, mainMerges: 0, branches: [
    b(), b({ state: 'open' }), b({ state: 'unmerged' }), b({ state: 'unmerged' }), b({ state: 'deleted' })] };
  assert.deepStrictEqual(footer(tree), {
    line1: '5 branches · 106M tokens', line2: '1 merged · 1 open · 2 unmerged · 1 deleted', main: 'main · 0 merges' });
  assert.strictEqual(footer({ ...tree, totalSpend: null, mainMerges: null }).line1, '5 branches · no token record yet');
  assert.strictEqual(footer({ ...tree, mainMerges: null }).main, null);
});
