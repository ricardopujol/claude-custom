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
const idle = { open: true, started: true, known: true, working: false, needsInput: false, turn: 'idle', lock: 'held' };
const ctx = (over = {}) => ({ prsKnown: true, repoUrl: 'https://github.com/o/r', tab: idle, ...over });
const by = (list, id) => list.find(a => a.id === id);

test('five actions, always, in this order', () => {
  assert.deepStrictEqual(A.actionsFor(open, ctx()).map(a => a.id), ['open-pr', 'jump', 'open-worktree', 'type-merged', 'copy']);
  assert.deepStrictEqual(A.actionsFor(unmerged, ctx({ tab: null })).map(a => a.id), ['open-pr', 'jump', 'open-worktree', 'type-merged', 'copy']);
});

test('an open PR whose tab is open and idle can do everything but open a worktree', () => {
  const l = A.actionsFor(open, ctx());
  for (const id of ['open-pr', 'jump', 'type-merged', 'copy']) assert.deepStrictEqual([id, by(l, id).enabled, by(l, id).why], [id, true, null]);
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

test('Type /merged: only for an open PR whose tab is open and idle; every other case says why', () => {
  const why = (b, c) => { const a = by(A.actionsFor(b, c), 'type-merged'); assert.strictEqual(a.enabled, false); return a.why; };
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

// PR #93 Dexter F1 / F2: the gate reads the host's measure of the MAIN session, not the subagent roster
// and not "looked at yet".
test('Dexter F1: a main-session turn with no subagent is working, though the roster says nothing is', () => {
  const a = by(A.actionsFor(open, ctx({ tab: { ...idle, working: false, turn: 'turn' } })), 'type-merged');
  assert.strictEqual(a.enabled, false);
  assert.match(a.why, /working/);
});

test('Dexter F2: an open dialog the tab was already looked at is still waiting for you', () => {
  const a = by(A.actionsFor(open, ctx({ tab: { ...idle, needsInput: false, turn: 'prompt' } })), 'type-merged');
  assert.strictEqual(a.enabled, false);
  assert.match(a.why, /waiting for you/);
});

test('a session whose host has not said whether a turn is running is not idle', () => {
  for (const turn of [null, undefined, 'weird']) {
    const a = by(A.actionsFor(open, ctx({ tab: { ...idle, turn } })), 'type-merged');
    assert.strictEqual(a.enabled, false, String(turn));
    assert.match(a.why, /can't tell whether/);
  }
});

test('Type /merged: a working tab that also needs input is told as working (the first thing to wait for)', () => {
  assert.match(by(A.actionsFor(open, ctx({ tab: { ...idle, working: true, needsInput: true } })), 'type-merged').why, /working/);
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

test('property: Type /merged is enabled only when every condition holds', () => {
  const state = fc.constantFrom('merged', 'open', 'unmerged', 'deleted');
  const place = fc.constantFrom('worktree', 'had-worktree', 'dev');
  const tab = fc.oneof(fc.constant(null), fc.constant({ open: false }), fc.record({
    open: fc.constant(true), started: fc.boolean(), known: fc.boolean(), working: fc.boolean(), needsInput: fc.boolean(),
    // PR #93: the host's turn (F1/F2) and the lock (F5) are conditions too. Without them here the oracle
    // said "enabled" for a tab the rule rightly keeps off, and the property failed whenever fast-check
    // happened to draw that tab (seen once in a full run after the develop merge).
    turn: fc.constantFrom(null, 'idle', 'turn', 'prompt'), lock: fc.constantFrom(null, 'held', 'unlocked', 'override', 'blocked', 'pending') }));
  fc.assert(fc.property(state, place, fc.boolean(), tab, (st, pl, hasFolder, t) => {
    const b = { name: 'n', state: st, place: pl, pr: 3, prUrl: null, folder: hasFolder ? 'C:/x' : null };
    const a = by(A.actionsFor(b, { prsKnown: true, repoUrl: null, tab: t }), 'type-merged');
    const should = st === 'open' && pl === 'worktree' && hasFolder && !!t && t.open === true && t.started === true
      && t.known === true && t.working === false && t.needsInput === false
      && t.turn === 'idle' && ['held', 'unlocked', 'override'].includes(t.lock);
    assert.strictEqual(a.enabled, should);
  }), { numRuns: 1000 });
});

test('which action does the drawer put the keyboard on first: the first enabled one, preferring Jump', () => {
  assert.strictEqual(A.firstFocus(A.actionsFor(open, ctx())), 'jump');
  assert.strictEqual(A.firstFocus(A.actionsFor(unmerged, ctx({ tab: null }))), 'copy', 'jump and open-pr are off: copy is the first enabled');
  assert.strictEqual(A.firstFocus(A.actionsFor(merged, ctx({ tab: null }))), 'open-pr');
});

// PR #93 Dexter F5: a tab whose worktree is held by another session has no terminal: nothing would be typed.
test('Dexter F5: Type /merged is off for a blocked or not-yet-locked tab, and for one whose lock is unknown', () => {
  for (const [lock, re] of [['blocked', /another session holds/], ['pending', /hasn't taken/], [null, /can't tell whether it holds/]]) {
    const a = by(A.actionsFor(open, ctx({ tab: { ...idle, lock } })), 'type-merged');
    assert.strictEqual(a.enabled, false, String(lock));
    assert.match(a.why, re);
  }
  for (const lock of ['held', 'unlocked', 'override']) {
    assert.strictEqual(by(A.actionsFor(open, ctx({ tab: { ...idle, lock } })), 'type-merged').enabled, true, lock);
  }
});

test('Dexter F9: an origin that exists but isn\'t a github.com URL says so and names its host, never "no remote"', () => {
  const noPage = { ...open, prUrl: null };
  const a = by(A.actionsFor(noPage, ctx({ repoUrl: null, originHost: 'github-work' })), 'open-pr');
  assert.strictEqual(a.enabled, false);
  assert.match(a.why, /github-work/);
  assert.match(a.why, /github\.com/);
  assert.doesNotMatch(a.why, /no GitHub remote/);
  assert.match(by(A.actionsFor(noPage, ctx({ repoUrl: null, originHost: null })), 'open-pr').why, /no GitHub remote/);
});

// PR #93 Dexter R2-1 (Ricardo's decision): the action TYPES /merged; the person presses Enter. It says so.
test('Type /merged is named for what it does, and when enabled says the Enter is yours', () => {
  const a = by(A.actionsFor(open, ctx()), 'type-merged');
  assert.strictEqual(a.label, 'Type /merged');
  assert.strictEqual(a.enabled, true);
  assert.strictEqual(a.hint, 'press Enter in its tab to run it');
  assert.ok(A.actionsFor(open, ctx()).filter(x => x.id !== 'type-merged').every(x => x.hint === null || x.hint === undefined));
  assert.strictEqual(by(A.actionsFor(merged, ctx()), 'type-merged').hint, null, 'a disabled one says why instead');
});
