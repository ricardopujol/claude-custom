'use strict';
/**
 * What the Git drawer SAYS (documentation/DESIGN_GIT_TREE.md, "Enhancement #46"): the card's facts, who worked
 * on it with bars by tokens, the review verdicts, and the five actions. The DOM itself (beside the dial in
 * a wide zone, under it in a narrow one, the keyboard, the swing that settles under a pin) is checked in a
 * real window by verify/probe-git-tree.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { drawerModel, labelAt } = require('../app/git-rings-display');

const b = extra => ({ name: 'feat/a', state: 'merged', place: 'dev', pr: 82, why: 'Dock zones, panels that fill',
  when: '2026-10-01', commits: 12, spend: 1234567, runs: 3, people: [], folder: null, ...extra });
const TAB_IDLE = { open: true, started: true, known: true, working: false, needsInput: false, turn: 'idle', lock: 'held' };
const openB = (extra) => b({ state: 'open', pr: 91, prUrl: 'https://github.com/o/r/pull/91', place: 'worktree', folder: 'C:/p/feat-a',
  people: [], reviews: [], ...extra });
const tree0 = { integration: 'develop', current: 'develop', prsKnown: true, repoUrl: 'https://github.com/o/r' };

test('the drawer says what the card says, plus reviews and the five actions', () => {
  const d = drawerModel(openB({ people: [{ name: 'Dexter', runs: 2, spend: 1000 }],
    reviews: [{ reviewer: 'Dexter', round: 2, date: '2026-10-02', verdict: 'CLEAN' }] }), { tree: tree0, tab: TAB_IDLE });
  assert.deepStrictEqual([d.title, d.kind], ['feat/a', '#91 · PR open']);
  assert.strictEqual(d.why, 'Dock zones, panels that fill');
  assert.match(d.sum, /1\.2M tokens · 12 commits/);
  assert.deepStrictEqual(d.reviews, [{ who: 'Dexter', round: 2, text: 'CLEAN', none: false }]);
  assert.deepStrictEqual(d.actions.map(a => [a.id, a.enabled]), [['open-pr', true], ['jump', true], ['open-worktree', false], ['type-merged', true], ['copy', true]]);
});

test("the drawer's people are the top four with bars by tokens (the biggest is full width), then +N more", () => {
  const people = [900, 450, 300, 100, 50, 10].map((s, i) => ({ name: `p${i}`, runs: i + 1, spend: s }));
  const d = drawerModel(openB({ people }), { tree: tree0, tab: TAB_IDLE });
  assert.deepStrictEqual(d.people.map(p => p.name), ['p0', 'p1', 'p2', 'p3']);
  assert.deepStrictEqual(d.people.map(p => p.pct), [100, 50, 33, 11]);
  assert.strictEqual(d.more, 2);
});

test('people with no spend figure draw no bar, never a full or zero-width lie', () => {
  const d = drawerModel(openB({ people: [{ name: 'p', runs: 1, spend: null }, { name: 'q', runs: 1, spend: 0 }] }), { tree: tree0, tab: TAB_IDLE });
  assert.deepStrictEqual(d.people.map(p => p.pct), [null, null]);
});

test('reviews: the latest round per reviewer with its verdict; a report with no verdict line says so; none says none', () => {
  const some = drawerModel(openB({ reviews: [{ reviewer: 'Dexter', round: 1, date: '2026-10-02', verdict: null },
    { reviewer: 'Miguel', round: 3, date: '2026-10-02', verdict: 'APROBADO' }] }), { tree: tree0, tab: TAB_IDLE });
  assert.deepStrictEqual(some.reviews, [
    { who: 'Dexter', round: 1, text: 'report, no verdict line', none: true },
    { who: 'Miguel', round: 3, text: 'APROBADO', none: false },
  ]);
  assert.deepStrictEqual(drawerModel(openB({ reviews: [] }), { tree: tree0, tab: TAB_IDLE }).reviews, []);
  assert.deepStrictEqual(drawerModel(openB({ reviews: undefined }), { tree: tree0, tab: TAB_IDLE }).reviews, []);
  assert.strictEqual(drawerModel(openB({ reviews: [] }), { tree: tree0, tab: TAB_IDLE }).noReviews, 'no review reports yet');
});

test('the drawer never invents a tab: no tab info means Type /merged stays off, and Jump is still tried', () => {
  const d = drawerModel(openB(), { tree: tree0, tab: null });
  assert.strictEqual(d.actions.find(a => a.id === 'type-merged').enabled, false);
  assert.strictEqual(d.actions.find(a => a.id === 'jump').enabled, true);
});

test('a hostile branch name is just text in the model', () => {
  const d = drawerModel(openB({ name: '<b>x</b>&"q' }), { tree: tree0, tab: TAB_IDLE });
  assert.strictEqual(d.title, '<b>x</b>&"q');
});

test("the hub's drawer is its card with only Copy name", () => {
  const d = drawerModel(null, { tree: { ...tree0, hub: { spend: 1000, people: [] }, totalSpend: 5000, mainMerges: 3 }, hub: true });
  assert.strictEqual(d.title, '▶ develop');
  assert.deepStrictEqual(d.actions.map(a => [a.id, a.enabled]), [['copy', true]]);
  assert.deepStrictEqual(d.reviews, []);
});

test('labelAt: beside the tip on the side it points to, kept inside the dial, at any turn', () => {
  const right = labelAt({ tipX: 200, tipY: 100, angle: 0, text: 'abc', width: 360 });
  assert.deepStrictEqual([right.anchor, right.x > 200], ['start', true]);
  const left = labelAt({ tipX: 160, tipY: 100, angle: Math.PI, text: 'abc', width: 360 });
  assert.deepStrictEqual([left.anchor, left.x < 160], ['end', true]);
  const edge = labelAt({ tipX: 350, tipY: 100, angle: 0, text: 'a long branch label', width: 360 });
  assert.strictEqual(edge.anchor, 'end', 'would run off the right edge: flipped inward');
  assert.ok(edge.x <= 360 - 4);
  const edgeL = labelAt({ tipX: 10, tipY: 100, angle: Math.PI, text: 'a long branch label', width: 360 });
  assert.strictEqual(edgeL.anchor, 'start');
  assert.ok(edgeL.x >= 4);
});

// ---------- PR #93 review: Miguel S1 (the DOM is checked in a real window by verify/probe-git-tree.js) ----------
// The tests here that read git-rings-display.js as TEXT moved to test/source-contracts.test.js: Stryker rewrites
// that file now, so a code-shape assertion on it is red on the unmutated baseline and aborts the dry run.
const swingLib = require('../app/git-swing');

test('Miguel S1: the 90 s swing clock wraps on a whole number of breaths, so the breath never jumps at the wrap', () => {
  assert.strictEqual(swingLib.PERIOD_S % swingLib.BREATH_PERIOD_S, 0, 'the 90 s clock wraps on a whole number of breaths');
  for (const n of ['feat/a', 'spike/c', '<b>x</b>&"q']) {
    assert.ok(Math.abs(swingLib.breath(n, 0) - swingLib.breath(n, swingLib.PERIOD_S)) < 1e-9, n);
  }
});
