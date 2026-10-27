'use strict';
/**
 * The Git drawer's *Open issue* (BACKLOG #119 A6): a branch the + form made from a GitHub issue gets a sixth action,
 * right after *Open PR*. A branch with no issue keeps its five (test/git-actions.test.js), so the drawer is never
 * padded with a disabled action that can never apply.
 */
const test = require('node:test');
const assert = require('node:assert');

const A = require('../app/git-actions');

const idle = { open: true, started: true, known: true, working: false, needsInput: false, turn: 'idle', lock: 'held' };
const ctx = (over = {}) => ({ prsKnown: true, repoUrl: 'https://github.com/o/r', tab: idle, ...over });
const base = { name: 'feat/12-fix-it', state: 'open', pr: 91, prUrl: 'https://github.com/o/r/pull/91', place: 'worktree', folder: 'C:/p/feat-12-fix-it' };
const issue = { number: 12, title: 'Fix it', url: 'https://github.com/o/r/issues/12' };
const ids = (l) => l.map(a => a.id);

test('a branch with an issue gets Open issue right after Open PR', () => {
  const l = A.actionsFor({ ...base, issue }, ctx());
  assert.deepStrictEqual(ids(l), ['open-pr', 'open-issue', 'jump', 'open-worktree', 'type-merged', 'copy']);
  const a = l.find(x => x.id === 'open-issue');
  assert.deepStrictEqual([a.label, a.enabled, a.why], ['Open issue #12', true, null]);
});

test('it is there with no PR too (a lane that has not opened one yet), and for a merged branch', () => {
  assert.ok(ids(A.actionsFor({ ...base, pr: null, prUrl: null, state: 'unmerged', issue }, ctx({ tab: null }))).includes('open-issue'));
  assert.ok(ids(A.actionsFor({ ...base, state: 'merged', place: 'had-worktree', folder: null, issue }, ctx({ tab: null }))).includes('open-issue'));
});

test('an issue with no page to open is drawn disabled, with the reason', () => {
  for (const url of [null, '', undefined, 5]) {
    const a = A.actionsFor({ ...base, issue: { ...issue, url } }, ctx()).find(x => x.id === 'open-issue');
    assert.strictEqual(a.enabled, false, String(url));
    assert.match(a.why, /page/);
  }
});

test('no issue, or a malformed one, keeps the five actions', () => {
  for (const bad of [undefined, null, {}, 'x', 5, [], { number: '12', url: 'https://x' }, { number: 0, url: 'https://x' }, { number: 1.5, url: 'https://x' }]) {
    assert.deepStrictEqual(ids(A.actionsFor({ ...base, issue: bad }, ctx())), ['open-pr', 'jump', 'open-worktree', 'type-merged', 'copy'], JSON.stringify(bad));
  }
});

test('firstFocus is unchanged: Jump if it works', () => {
  assert.strictEqual(A.firstFocus(A.actionsFor({ ...base, issue }, ctx())), 'jump');
});

// --- the drawer, through the fake document --------------------------------------------------------

const { makePanel } = require('./fake-dom');
const display = require('../app/git-rings-display');

globalThis.requestAnimationFrame = () => 1;
test.after(() => { delete globalThis.requestAnimationFrame; });

const flush = () => new Promise(res => setImmediate(res));
const TAB = { folder: 'C:/p/feat-12-fix-it', open: true, started: true, known: true, working: false, needsInput: false, turn: 'idle', lock: 'held' };
const wide = (extra) => ({ name: 'feat/12-fix-it', state: 'open', place: 'worktree', folder: 'C:/p/feat-12-fix-it', pr: 91,
  prUrl: 'https://github.com/o/r/pull/91', why: 'Fix it', when: '2026-10-01', first: '2026-09-28', last: '2026-10-01', commits: 3, spend: 1000,
  runs: 1, people: [], reviews: [], issue, ...extra });

function drawer(branchExtra, onOpenPr) {
  const p = makePanel();
  p.dial.clientWidth = 800;
  const opened = [];
  const tree = { ok: true, integration: 'develop', current: 'develop', prsKnown: true, repoUrl: 'https://github.com/o/r', ledgerOk: true,
    totalSpend: 1000, mainMerges: 0, hub: { spend: 0, people: [] }, branches: [wide(branchExtra)] };
  display.render(p.rootEl, tree, {
    onOpenPr: onOpenPr === null ? undefined : (onOpenPr || (async (url) => { opened.push(url); return true; })),
    onCopy() {}, onJump: async () => null, onTypeMerged: async () => ({ kind: 'typed', submitted: true }), tabs: [TAB], now: 1_000_000,
  });
  p.dial.querySelectorAll('.git-spoke').find(g => g.getAttribute('data-name') === 'feat/12-fix-it').dispatch('click');
  const button = (id) => p.dial.querySelector(`.git-act[data-act="${id}"]`);
  const said = () => p.rootEl.querySelector('.git-said').textContent;
  return { button, said, opened, press: async (id) => { button(id).dispatch('click'); await flush(); } };
}

test('the drawer draws Open issue next to Open PR, and pressing it opens the issue\'s page', async () => {
  const d = drawer({});
  assert.ok(d.button('open-issue'), 'the action is drawn');
  assert.match(d.button('open-issue').textContent, /Open issue #12/);
  await d.press('open-issue');
  assert.deepStrictEqual(d.opened, ['https://github.com/o/r/issues/12']);
  assert.strictEqual(d.said(), 'Opened issue #12 in your browser.');
});

test('a refused browser, and no browser handler, are said in words', async () => {
  const refused = drawer({}, async () => false);
  await refused.press('open-issue');
  assert.strictEqual(refused.said(), "Couldn't open the browser.");
  const none = drawer({}, null);
  await none.press('open-issue');
  assert.strictEqual(none.said(), "Can't open a browser from here.");
});

test('a branch with no issue has no Open issue in its drawer', () => {
  const d = drawer({ issue: null });
  assert.strictEqual(d.button('open-issue'), null);
  assert.ok(d.button('open-pr'));
});

test('an issue with no page draws the action off, and pressing it opens nothing', async () => {
  const d = drawer({ issue: { number: 12, title: 'Fix it', url: null } });
  assert.strictEqual(d.button('open-issue').getAttribute('aria-disabled'), 'true');
  await d.press('open-issue');
  assert.deepStrictEqual(d.opened, []);
});
