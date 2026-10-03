'use strict';
/**
 * The Git drawer's actions (documentation/DESIGN_GIT_TREE.md, "Enhancement #46"). Pure: a branch, what the
 * host knows about the repo, and what the shell knows about the branch's tab -> five actions, each
 * enabled or DISABLED WITH A REASON. Nothing is hidden silently, and unknown is never "fine": a session
 * that hasn't reported its state is not idle.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const A = require('../app/git-actions');

const open = { name: 'feat/b', state: 'open', pr: 91, prUrl: 'https://github.com/o/r/pull/91', place: 'worktree', folder: 'C:/p/feat-b' };
const merged = { name: 'feat/a', state: 'merged', pr: 5, prUrl: 'https://github.com/o/r/pull/5', place: 'had-worktree', folder: null };
const unmerged = { name: 'spike/c', state: 'unmerged', pr: null, prUrl: null, place: 'dev', folder: null };
const idle = { open: true, started: true, known: true, working: false, needsInput: false };
const ctx = (over = {}) => ({ prsKnown: true, repoUrl: 'https://github.com/o/r', tab: idle, ...over });
const by = (list, id) => list.find(a => a.id === id);

test('five actions, always, in this order', () => {
  assert.deepStrictEqual(A.actionsFor(open, ctx()).map(a => a.id), ['open-pr', 'jump', 'open-worktree', 'run-merged', 'copy']);
  assert.deepStrictEqual(A.actionsFor(unmerged, ctx({ tab: null })).map(a => a.id), ['open-pr', 'jump', 'open-worktree', 'run-merged', 'copy']);
});

test('an open PR whose tab is open and idle can do everything but open a worktree', () => {
  const l = A.actionsFor(open, ctx());
  for (const id of ['open-pr', 'jump', 'run-merged', 'copy']) assert.deepStrictEqual([id, by(l, id).enabled, by(l, id).why], [id, true, null]);
  assert.strictEqual(by(l, 'open-pr').label, 'Open PR #91');
});

test('Open a worktree is drawn disabled for an unmerged branch, with the reason Ricardo gave', () => {
  const a = by(A.actionsFor(unmerged, ctx({ tab: null })), 'open-worktree');
  assert.strictEqual(a.enabled, false);
  assert.strictEqual(a.why, 'needs agent-creator to attach an existing branch');
  assert.strictEqual(A.OPEN_WORKTREE_WHY, a.why);
});

test('Open a worktree: where it could never apply, the reason says that instead', () => {
  assert.match(by(A.actionsFor(open, ctx()), 'open-worktree').why, /already open/);
  assert.match(by(A.actionsFor(merged, ctx({ tab: null })), 'open-worktree').why, /merged/);
  assert.match(by(A.actionsFor({ ...unmerged, state: 'deleted' }, ctx({ tab: null })), 'open-worktree').why, /gone/);
});

test('Open PR: a merged branch keeps its PR page; no PR, no remote and unknown PRs each say so', () => {
  assert.strictEqual(by(A.actionsFor(merged, ctx({ tab: null })), 'open-pr').enabled, true);
  assert.strictEqual(by(A.actionsFor(merged, ctx({ tab: null })), 'open-pr').label, 'Open PR #5');
  const none = by(A.actionsFor(unmerged, ctx({ tab: null })), 'open-pr');
  assert.deepStrictEqual([none.enabled, none.label, /no PR/.test(none.why)], [false, 'Open PR', true]);
  const noRemote = by(A.actionsFor({ ...open, prUrl: null }, ctx({ repoUrl: null })), 'open-pr');
  assert.strictEqual(noRemote.enabled, false);
  assert.match(noRemote.why, /remote/);
  const unknown = by(A.actionsFor(unmerged, ctx({ prsKnown: false, tab: null })), 'open-pr');
  assert.match(unknown.why, /unknown/);
});

test('Jump: needs an open worktree whose tab is in this window', () => {
  assert.strictEqual(by(A.actionsFor(open, ctx()), 'jump').enabled, true);
  assert.match(by(A.actionsFor(unmerged, ctx({ tab: null })), 'jump').why, /no open worktree/);
  assert.match(by(A.actionsFor(merged, ctx({ tab: null })), 'jump').why, /removed|no open worktree/);
  assert.match(by(A.actionsFor(open, ctx({ tab: { open: false } })), 'jump').why, /no tab/);
});

test('Jump: a tab whose state could not be read is still tried: main explains if it cannot', () => {
  assert.strictEqual(by(A.actionsFor(open, ctx({ tab: null })), 'jump').enabled, true);
});

test('Run /merged: only for an open PR whose tab is open and idle; every other case says why', () => {
  const why = (b, c) => { const a = by(A.actionsFor(b, c), 'run-merged'); assert.strictEqual(a.enabled, false); return a.why; };
  assert.match(why(merged, ctx({ tab: null })), /already merged/);
  assert.match(why(unmerged, ctx({ tab: null })), /no open PR/);
  assert.match(why({ ...unmerged, state: 'deleted' }, ctx({ tab: null })), /gone/);
  assert.match(why(unmerged, ctx({ prsKnown: false, tab: null })), /PR status is unknown|unknown/);
  assert.match(why({ ...open, place: 'dev', folder: null }, ctx({ tab: null })), /no open worktree/);
  assert.match(why(open, ctx({ tab: { open: false } })), /no tab/);
  assert.match(why(open, ctx({ tab: { open: true, started: false } })), /hasn't started/);
  assert.match(why(open, ctx({ tab: { open: true, started: true, known: false } })), /hasn't reported/);
  assert.match(why(open, ctx({ tab: { ...idle, working: true } })), /working/);
  assert.match(why(open, ctx({ tab: { ...idle, needsInput: true } })), /waiting for you/);
  assert.match(why(open, ctx({ tab: null })), /can't tell/);
});

test('Run /merged: a working tab that also needs input is told as working (the first thing to wait for)', () => {
  assert.match(by(A.actionsFor(open, ctx({ tab: { ...idle, working: true, needsInput: true } })), 'run-merged').why, /working/);
});

test('Copy name is always enabled', () => {
  for (const b of [open, merged, unmerged]) assert.strictEqual(by(A.actionsFor(b, ctx({ tab: null })), 'copy').enabled, true);
});

test('hostile branch names are only data: the labels never include them', () => {
  const l = A.actionsFor({ ...open, name: '<b>x</b>&"q' }, ctx());
  assert.ok(l.every(a => !a.label.includes('<b>')));
});

test('property: an enabled action has no reason, a disabled one always has one', () => {
  const state = fc.constantFrom('merged', 'open', 'unmerged', 'deleted');
  const place = fc.constantFrom('worktree', 'had-worktree', 'dev');
  const tab = fc.oneof(fc.constant(null), fc.constant({ open: false }), fc.record({
    open: fc.constant(true), started: fc.boolean(), known: fc.boolean(), working: fc.boolean(), needsInput: fc.boolean() }));
  fc.assert(fc.property(state, place, fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }), fc.boolean(), fc.boolean(), fc.boolean(), tab,
    (st, pl, pr, hasUrl, prsKnown, hasFolder, t) => {
      const b = { name: 'n', state: st, place: pl, pr, prUrl: pr && hasUrl ? `https://github.com/o/r/pull/${pr}` : null, folder: hasFolder ? 'C:/x' : null };
      for (const a of A.actionsFor(b, { prsKnown, repoUrl: hasUrl ? 'https://github.com/o/r' : null, tab: t })) {
        if (a.enabled) assert.strictEqual(a.why, null, a.id);
        else assert.ok(typeof a.why === 'string' && a.why.length > 8, `${a.id} disabled without a reason`);
      }
    }));
});

test('property: Run /merged is enabled only when every condition holds', () => {
  const state = fc.constantFrom('merged', 'open', 'unmerged', 'deleted');
  const place = fc.constantFrom('worktree', 'had-worktree', 'dev');
  const tab = fc.oneof(fc.constant(null), fc.constant({ open: false }), fc.record({
    open: fc.constant(true), started: fc.boolean(), known: fc.boolean(), working: fc.boolean(), needsInput: fc.boolean() }));
  fc.assert(fc.property(state, place, fc.boolean(), tab, (st, pl, hasFolder, t) => {
    const b = { name: 'n', state: st, place: pl, pr: 3, prUrl: null, folder: hasFolder ? 'C:/x' : null };
    const a = by(A.actionsFor(b, { prsKnown: true, repoUrl: null, tab: t }), 'run-merged');
    const should = st === 'open' && pl === 'worktree' && hasFolder && !!t && t.open === true && t.started === true
      && t.known === true && t.working === false && t.needsInput === false;
    assert.strictEqual(a.enabled, should);
  }));
});

test('which action does the drawer put the keyboard on first: the first enabled one, preferring Jump', () => {
  assert.strictEqual(A.firstFocus(A.actionsFor(open, ctx())), 'jump');
  assert.strictEqual(A.firstFocus(A.actionsFor(unmerged, ctx({ tab: null }))), 'copy', 'jump and open-pr are off: copy is the first enabled');
  assert.strictEqual(A.firstFocus(A.actionsFor(merged, ctx({ tab: null }))), 'open-pr');
});
