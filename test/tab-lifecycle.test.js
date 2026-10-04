'use strict';
/**
 * The tab lifecycle reducer: (state, observation) -> { state, actions }. The
 * shell (PR 2) polls, calls reconcile, and executes the actions. Design:
 * documentation/PLAN_WORKTREE_TABS.md (W3 live pickup, W4 merged tabs).
 *
 * The one rule that matters most (acceptance 9): a worktree's folder is
 * removed only after its host has stopped listening -- and "stopped" means
 * seen running, then seen not running. A host that simply hasn't come up yet
 * is not a finished session.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fc = require('fast-check');

const { initial, reconcile, closeByHand, removeResult, reopen } = require('../host/tab-lifecycle');
const { normPath, samePath } = require('../host/project-layout');

const C = path.resolve('/fake/proj');
const DEV = path.join(C, 'dev');
const A = path.join(C, 'feat-a');
const B = path.join(C, 'feat-b');

const wt = (p, branch, isDev = false, openable = true) => ({ path: p, branch, isDev, openable });
const DEV_WT = wt(DEV, 'develop', true);
const A_WT = wt(A, 'feat/a');
const B_WT = wt(B, 'feat/b');

function obs(worktrees, { merged = [], listening = {} } = {}) {
  const m = {};
  for (const p of merged) m[normPath(p)] = true;
  const l = {};
  for (const [p, v] of Object.entries(listening)) l[normPath(p)] = v;
  return { worktrees, merged: m, listening: l };
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// Run observations in order, returning the final state and every action.
function run(steps, state = initial()) {
  const all = [];
  for (const o of steps) {
    const r = reconcile(state, o);
    state = r.state;
    all.push(...r.actions);
  }
  return { state, actions: all };
}

const types = (actions) => actions.map(a => a.type);

// ---------------------------------------------------------------------------

test('initial state has no tabs and nothing dismissed', () => {
  assert.deepStrictEqual(initial(), { tabs: [], dismissed: [] });
});

test('the first observation opens dev first, then each worktree in list order', () => {
  const { state, actions } = reconcile(initial(), obs([DEV_WT, A_WT, B_WT]));
  assert.deepStrictEqual(state.tabs.map(t => [t.path, t.branch, t.isDev, t.phase]), [
    [DEV, 'develop', true, 'live'], [A, 'feat/a', false, 'live'], [B, 'feat/b', false, 'live'],
  ]);
  assert.deepStrictEqual(actions, [
    { type: 'open', path: DEV, branch: 'develop' },
    { type: 'open', path: A, branch: 'feat/a' },
    { type: 'open', path: B, branch: 'feat/b' },
  ]);
});

test('dev is kept first even when the observation lists it later', () => {
  const { state } = reconcile(initial(), obs([A_WT, DEV_WT]));
  assert.deepStrictEqual(state.tabs.map(t => t.isDev), [true, false]);
});

test('a worktree listed twice is one tab', () => {
  const { state, actions } = reconcile(initial(), obs([DEV_WT, A_WT, wt(A.toUpperCase(), 'feat/a')]));
  const expectedTabs = process.platform === 'win32' ? 2 : 3;
  assert.strictEqual(state.tabs.length, expectedTabs);
  assert.strictEqual(types(actions).length, expectedTabs);
});

test('reconciling the same observation again changes nothing', () => {
  const o = obs([DEV_WT, A_WT]);
  const first = reconcile(initial(), o);
  const second = reconcile(first.state, o);
  assert.deepStrictEqual(second.actions, []);
  assert.deepStrictEqual(second.state, first.state);
});

test('a worktree that appears later gets a tab (live pickup)', () => {
  const s1 = reconcile(initial(), obs([DEV_WT])).state;
  const { state, actions } = reconcile(s1, obs([DEV_WT, A_WT]));
  assert.deepStrictEqual(actions, [{ type: 'open', path: A, branch: 'feat/a' }]);
  assert.strictEqual(state.tabs.length, 2);
});

test('a worktree that vanishes: its host is stopped and its tab closed', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT, B_WT])).state;
  const { state, actions } = reconcile(s1, obs([DEV_WT, B_WT]));
  assert.deepStrictEqual(actions, [{ type: 'stop', path: A }, { type: 'close', path: A }]);
  assert.deepStrictEqual(state.tabs.map(t => t.path), [DEV, B]);
});

// Dexter F1 / Miguel F1: `git rebase` detaches HEAD, so the worktree stops
// being openable -- but it is still there, and so is the session in it.
test('a tab whose worktree goes detached mid-session (rebase) is kept, not stopped', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const { state, actions } = reconcile(s1, obs([DEV_WT, wt(A, null, false, false)]));
  assert.deepStrictEqual(actions, []);
  assert.deepStrictEqual(state.tabs.map(t => t.path), [DEV, A]);
});

// Dexter's counterexample end to end, from git's own text: [DEV, A(feat/a)],
// then A detaches during a rebase conflict. Must not emit `stop A`.
test('end to end: a rebase in a worktree does not stop its session', () => {
  const { parsePorcelain, tabWorktrees } = require('../host/worktree-list');
  const g = (p) => p.replace(/\\/g, '/');
  const poll = (aLines) => obs(tabWorktrees(parsePorcelain([
    `worktree ${g(DEV)}`, 'HEAD 765ee008ee548055970882a0062f31933838d8ce', 'branch refs/heads/develop', '',
    `worktree ${g(A)}`, 'HEAD 03263a79c0236152213afb800252f994c63b65a0', ...aLines, '',
  ].join('\n')), C));
  const s1 = reconcile(initial(), poll(['branch refs/heads/feat/a'])).state;
  const { state, actions } = reconcile(s1, poll(['detached']));
  assert.deepStrictEqual(actions, []);
  assert.deepStrictEqual(state.tabs.map(t => t.path), [DEV, A]);
});

test('a listed but not openable worktree gets no new tab', () => {
  const { state, actions } = reconcile(initial(), obs([DEV_WT, wt(A, null, false, false)]));
  assert.deepStrictEqual(types(actions), ['open']);
  assert.deepStrictEqual(state.tabs.map(t => t.path), [DEV]);
});

test('a worktree that finishes being created (becomes openable) gets its tab then', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, wt(A, 'feat/a', false, false)])).state;
  const { actions } = reconcile(s1, obs([DEV_WT, A_WT]));
  assert.deepStrictEqual(actions, [{ type: 'open', path: A, branch: 'feat/a' }]);
});

// Dexter F4 / Miguel F3: `git switch` or `git branch -m` inside a worktree.
test('a tab\'s branch follows its worktree, dev\'s too', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const { state, actions } = reconcile(s1, obs([wt(DEV, 'main', true), wt(A, 'feat/renamed')]));
  assert.deepStrictEqual(actions, []);
  assert.deepStrictEqual(state.tabs.map(t => t.branch), ['main', 'feat/renamed']);
});

test('mid-rebase (no branch) the tab keeps its last branch', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const { state } = reconcile(s1, obs([DEV_WT, wt(A, null, false, false)]));
  assert.strictEqual(state.tabs[1].branch, 'feat/a');
});

// Its marker was for the old branch; the new one hasn't merged. The shell
// reads markers with the branch from the same poll, so merged is false here.
test('a finishing tab whose branch changes goes back to live, and is not removed', () => {
  const WTS = [DEV_WT, A_WT];
  const s = run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: true } }),
  ]).state;
  const { state, actions } = reconcile(s, obs([DEV_WT, wt(A, 'feat/b')], { listening: { [A]: false } }));
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(state.tabs[1].phase, 'live');
  assert.strictEqual(state.tabs[1].branch, 'feat/b');
});

test('mark-merged names the branch the worktree is on now', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const { actions } = reconcile(s1, obs([DEV_WT, wt(A, 'feat/b')], { merged: [A] }));
  assert.deepStrictEqual(actions, [{ type: 'mark-merged', path: A, branch: 'feat/b' }]);
});

// A transient git failure must not read as "every worktree vanished" and
// stop every session.
test('an observation without dev is ignored: no tabs dropped, no actions', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  for (const bad of [obs([]), obs([A_WT]), { worktrees: null }, null, undefined, {}]) {
    const { state, actions } = reconcile(s1, bad);
    assert.deepStrictEqual(actions, [], JSON.stringify(bad));
    assert.deepStrictEqual(state, s1);
  }
});

test('a merged live worktree goes to finishing and is marked merged', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const { state, actions } = reconcile(s1, obs([DEV_WT, A_WT], { merged: [A] }));
  assert.deepStrictEqual(actions, [{ type: 'mark-merged', path: A, branch: 'feat/a' }]);
  assert.strictEqual(state.tabs[1].phase, 'finishing');
});

test('dev is never marked merged', () => {
  const s1 = reconcile(initial(), obs([DEV_WT])).state;
  const { state, actions } = reconcile(s1, obs([DEV_WT], { merged: [DEV] }));
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(state.tabs[0].phase, 'live');
});

test('merged must be strictly true', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  for (const v of ['true', 1, {}, 'yes']) {
    const o = obs([DEV_WT, A_WT]);
    o.merged[normPath(A)] = v;
    assert.deepStrictEqual(reconcile(s1, o).actions, [], String(v));
  }
});

// Acceptance 9.
test('marker -> still listening: no remove -> listening false: remove -> ok: close', () => {
  const WTS = [DEV_WT, A_WT];
  let r = run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: true } }),
  ]);
  assert.deepStrictEqual(types(r.actions), ['open', 'open', 'mark-merged']);
  assert.strictEqual(r.state.tabs[1].phase, 'finishing');

  r = reconcile(r.state, obs(WTS, { merged: [A], listening: { [A]: true } }));
  assert.deepStrictEqual(r.actions, [], 'still listening: nothing');

  r = reconcile(r.state, obs(WTS, { merged: [A], listening: { [A]: false } }));
  assert.deepStrictEqual(r.actions, [{ type: 'remove', path: A }]);
  assert.strictEqual(r.state.tabs[1].phase, 'removing');

  r = removeResult(r.state, A, { ok: true });
  assert.deepStrictEqual(r.actions, [{ type: 'close', path: A }]);
  assert.deepStrictEqual(r.state.tabs.map(t => t.path), [DEV]);
  assert.deepStrictEqual(r.state.dismissed, [normPath(A)]);
});

test('missing, null or falsy-but-not-false listening is not "stopped"', () => {
  for (const v of [undefined, null, 0, '', 'false']) {
    const WTS = [DEV_WT, A_WT];
    const r = run([
      obs(WTS, { listening: { [A]: true } }),
      obs(WTS, { merged: [A], listening: { [A]: true } }),
    ]);
    const o = obs(WTS, { merged: [A] });
    if (v !== undefined) o.listening[normPath(A)] = v;
    assert.deepStrictEqual(reconcile(r.state, o).actions, [], String(v));
  }
});

// A host that hasn't come up yet reads as not listening too. Opening a window
// on an already-merged worktree must not delete its folder while its session
// is starting.
test('a host never seen listening is not "stopped": no remove', () => {
  const WTS = [DEV_WT, A_WT];
  const r = run([
    obs(WTS, { merged: [A], listening: { [A]: false } }),
    obs(WTS, { merged: [A], listening: { [A]: false } }),
  ]);
  assert.deepStrictEqual(types(r.actions), ['open', 'open', 'mark-merged']);
  assert.strictEqual(r.state.tabs[1].phase, 'finishing');
});

// Dexter F2: the session ran and ended, Ricardo pressed Restart, and the
// marker lands while the NEW host is still starting. "Seen listening" must
// mean seen after the merge, or this removes the folder under the new host.
// The contract says a starting host is left out of `listening`; this pins the
// guard even when the shell misreports it as false.
test('restart after exit: the marker landing while the new host starts does not remove', () => {
  const WTS = [DEV_WT, A_WT];
  let r = run([
    obs(WTS, { listening: { [A]: true } }),                 // the first session runs
    obs(WTS, { listening: { [A]: false } }),                // ...and ends; Restart pressed
    obs(WTS, { merged: [A], listening: { [A]: false } }),   // marker lands, new host starting
    obs(WTS, { merged: [A], listening: { [A]: false } }),
  ]);
  assert.ok(!types(r.actions).includes('remove'), types(r.actions).join());
  assert.strictEqual(r.state.tabs[1].phase, 'finishing');

  // The new host comes up, then Ricardo ends it: now the folder goes.
  r = run([
    obs(WTS, { merged: [A], listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: false } }),
  ], r.state);
  assert.deepStrictEqual(r.actions, [{ type: 'remove', path: A }]);
});

// Miguel S1: `finishing` is always visible for at least one poll, because the
// host has to be seen running after the merge before it can be seen stopping.
test('a merged tab is never marked and removed in the same poll', () => {
  const WTS = [DEV_WT, A_WT];
  const r = run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: false } }),
  ]);
  assert.deepStrictEqual(types(r.actions), ['open', 'open', 'mark-merged']);
});

// Unreadable marker = not merged, including at the moment of removal.
test('a finishing tab whose marker is no longer read is not removed', () => {
  const WTS = [DEV_WT, A_WT];
  const r = run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: true } }),
    obs(WTS, { listening: { [A]: false } }),
  ]);
  assert.ok(!types(r.actions).includes('remove'));
  assert.strictEqual(r.state.tabs[1].phase, 'finishing');
});

function removingState() {
  const WTS = [DEV_WT, A_WT];
  return run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: false } }),
  ]).state;
}

test('a failed remove keeps the tab with the error, and is never retried by itself', () => {
  const r = removeResult(removingState(), A, { ok: false, error: 'contains modified files' });
  assert.deepStrictEqual(r.actions, [{ type: 'error', path: A, error: 'contains modified files' }]);
  assert.strictEqual(r.state.tabs[1].phase, 'remove-failed');
  assert.strictEqual(r.state.tabs[1].error, 'contains modified files');
  const again = reconcile(r.state, obs([DEV_WT, A_WT], { merged: [A], listening: { [A]: false } }));
  assert.deepStrictEqual(again.actions, []);
});

test('anything but ok: true is a failed remove', () => {
  for (const result of [{ ok: 'yes' }, { ok: 1 }, {}, null, undefined]) {
    const r = removeResult(removingState(), A, result);
    assert.strictEqual(r.state.tabs[1].phase, 'remove-failed', JSON.stringify(result));
    assert.strictEqual(r.actions[0].type, 'error');
    assert.strictEqual(typeof r.actions[0].error, 'string');
  }
});

test('a removing tab stays until its result arrives, even if git already stopped listing it', () => {
  const { state, actions } = reconcile(removingState(), obs([DEV_WT]));
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(state.tabs[1].phase, 'removing');
});

test('a remove-failed tab whose worktree vanishes is stopped and closed', () => {
  const failed = removeResult(removingState(), A, { ok: false, error: 'x' }).state;
  const { state, actions } = reconcile(failed, obs([DEV_WT]));
  assert.deepStrictEqual(actions, [{ type: 'stop', path: A }, { type: 'close', path: A }]);
  assert.deepStrictEqual(state.tabs.map(t => t.path), [DEV]);
});

test('removeResult for a tab that is not removing does nothing', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  for (const p of [A, DEV, B, null]) {
    const r = removeResult(s1, p, { ok: true });
    assert.deepStrictEqual(r.actions, [], String(p));
    assert.deepStrictEqual(r.state, s1);
  }
});

// --- kept on purpose (Contract C exit 2) and reopen (PR 3) ---------------------

test('a remove KEPT on purpose (exit 2) is phase kept with the reason, and no error action', () => {
  const r = removeResult(removingState(), A, { ok: false, kept: true, reason: 'feat/a still has a handoff brief' });
  assert.deepStrictEqual(r.actions, []);
  assert.strictEqual(r.state.tabs[1].phase, 'kept');
  assert.strictEqual(r.state.tabs[1].note, 'feat/a still has a handoff brief');
  assert.strictEqual(r.state.tabs[1].error, undefined, 'kept is not an error');
});

test('a kept result with no reason still says why', () => {
  const r = removeResult(removingState(), A, { ok: false, kept: true });
  assert.strictEqual(r.state.tabs[1].phase, 'kept');
  assert.match(r.state.tabs[1].note, /handoff brief/);
});

test('a kept tab is never removed again by later polls', () => {
  const kept = removeResult(removingState(), A, { ok: false, kept: true, reason: 'brief' }).state;
  const r = run([
    obs([DEV_WT, A_WT], { merged: [A], listening: { [A]: true } }),
    obs([DEV_WT, A_WT], { merged: [A], listening: { [A]: false } }),
  ], kept);
  assert.deepStrictEqual(r.actions, []);
  assert.strictEqual(r.state.tabs[1].phase, 'kept');
});

test('a kept tab whose worktree moved to another branch goes back to live', () => {
  const kept = removeResult(removingState(), A, { ok: false, kept: true, reason: 'brief' }).state;
  const { state } = reconcile(kept, obs([DEV_WT, wt(A, 'feat/a2')]));
  assert.strictEqual(state.tabs[1].phase, 'live');
  assert.strictEqual(state.tabs[1].branch, 'feat/a2');
});

test('a kept tab whose worktree vanishes (the reaper removed it later) is stopped and closed', () => {
  const kept = removeResult(removingState(), A, { ok: false, kept: true, reason: 'brief' }).state;
  const { state, actions } = reconcile(kept, obs([DEV_WT]));
  assert.deepStrictEqual(actions, [{ type: 'stop', path: A }, { type: 'close', path: A }]);
  assert.deepStrictEqual(state.tabs.map(t => t.path), [DEV]);
});

test('reopen drops a hand-closed path from dismissed; the next poll opens it again', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const closed = closeByHand(s1, A).state;
  assert.deepStrictEqual(reconcile(closed, obs([DEV_WT, A_WT])).actions, [], 'dismissed: not reopened by a poll');
  const r = reopen(closed, A);
  assert.deepStrictEqual(r.actions, [], 'reopen opens nothing itself');
  assert.deepStrictEqual(r.state.dismissed, []);
  const again = reconcile(r.state, obs([DEV_WT, A_WT]));
  assert.deepStrictEqual(again.actions, [{ type: 'open', path: A, branch: 'feat/a' }]);
});

test('reopen matches the path however it is spelled, and ignores a path that is not dismissed', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const closed = closeByHand(s1, A).state;
  if (process.platform === 'win32') assert.deepStrictEqual(reopen(closed, A.toUpperCase()).state.dismissed, []);
  for (const p of [B, DEV, null, '', 42]) {
    const r = reopen(closed, p);
    assert.deepStrictEqual(r.state, closed, String(p));
    assert.deepStrictEqual(r.actions, []);
  }
});

test('closing dev by hand does nothing', () => {
  const s1 = reconcile(initial(), obs([DEV_WT, A_WT])).state;
  const r = closeByHand(s1, DEV);
  assert.deepStrictEqual(r.actions, []);
  assert.deepStrictEqual(r.state, s1);
});

test('closing a tab by hand stops it, closes it, and keeps it closed while the window lives', () => {
  const o = obs([DEV_WT, A_WT]);
  const s1 = reconcile(initial(), o).state;
  const r = closeByHand(s1, A);
  assert.deepStrictEqual(r.actions, [{ type: 'stop', path: A }, { type: 'close', path: A }]);
  assert.deepStrictEqual(r.state.tabs.map(t => t.path), [DEV]);
  assert.deepStrictEqual(reconcile(r.state, o).actions, [], 'the poll must not reopen it');
});

// Dexter F3 / Miguel F2: dismissing is about THAT worktree. Once git stops
// listing the path, a new worktree created there is a new tab (W3), e.g.
// feat-x merged and removed, then feat-x created again with `+`.
test('a worktree removed and re-created at the same folder gets a tab again', () => {
  let s = removeResult(removingState(), A, { ok: true }).state;
  s = reconcile(s, obs([DEV_WT, A_WT])).state;                     // prune lag: still listed
  assert.deepStrictEqual(s.dismissed, [normPath(A)]);
  s = reconcile(s, obs([DEV_WT])).state;                           // git no longer lists it
  assert.deepStrictEqual(s.dismissed, []);
  const { actions } = reconcile(s, obs([DEV_WT, A_WT]));           // created again
  assert.deepStrictEqual(actions, [{ type: 'open', path: A, branch: 'feat/a' }]);
});

test('a hand-closed tab stays closed while git lists it, even across polls', () => {
  const o = obs([DEV_WT, A_WT]);
  let s = closeByHand(reconcile(initial(), o).state, A).state;
  for (let i = 0; i < 3; i++) {
    const r = reconcile(s, o);
    assert.deepStrictEqual(r.actions, []);
    s = r.state;
  }
  assert.deepStrictEqual(s.dismissed, [normPath(A)]);
});

test('closing a merged tab by hand keeps its folder: no remove', () => {
  const WTS = [DEV_WT, A_WT];
  const s = run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: true } }),
  ]).state;
  const r = closeByHand(s, A);
  assert.deepStrictEqual(types(r.actions), ['stop', 'close']);
  assert.deepStrictEqual(reconcile(r.state, obs(WTS, { merged: [A], listening: { [A]: false } })).actions, []);
});

test('closing a path that is not a tab does nothing', () => {
  const s1 = reconcile(initial(), obs([DEV_WT])).state;
  for (const p of [A, null, '', 42]) {
    const r = closeByHand(s1, p);
    assert.deepStrictEqual(r.actions, []);
    assert.deepStrictEqual(r.state, s1);
  }
});

test('the reducer never mutates the state it is given', () => {
  const WTS = [DEV_WT, A_WT];
  const s = deepFreeze(run([
    obs(WTS, { listening: { [A]: true } }),
    obs(WTS, { merged: [A], listening: { [A]: true } }),
  ]).state);
  const o = deepFreeze(obs(WTS, { merged: [A], listening: { [A]: false } }));
  const removing = deepFreeze(reconcile(s, o).state);
  removeResult(removing, A, { ok: true });
  removeResult(removing, A, { ok: false, error: 'x' });
  closeByHand(s, A);
  reconcile(s, deepFreeze(obs([DEV_WT])));
});

// ---------------------------------------------------------------------------
// Properties over random sequences of observations, hand closes and remove
// results.

const POOL = [DEV_WT, A_WT, B_WT, wt(path.join(C, 'feat-c'), 'feat/c')];
const spell = (p, upper) => (process.platform === 'win32' && upper ? p.toUpperCase() : p);

const obsArb = fc.record({
  kind: fc.constant('obs'),
  withDev: fc.boolean(),
  present: fc.subarray(POOL.slice(1)),
  // Listed but not openable this time (detached mid-rebase, being created...).
  notOpenable: fc.subarray(POOL.slice(1).map(w => w.path)),
  // On another branch this time (git switch / branch -m).
  renamed: fc.subarray(POOL.map(w => w.path)),
  merged: fc.subarray(POOL.map(w => w.path)),
  listening: fc.array(fc.tuple(fc.constantFrom(...POOL.map(w => w.path)), fc.constantFrom(true, false, null)),
    { maxLength: 4 }),
  upper: fc.boolean(),
}).map(e => {
  const worktrees = (e.withDev ? [DEV_WT, ...e.present] : e.present)
    .map(w => (e.renamed.includes(w.path) ? { ...w, branch: `${w.branch}-2` } : w))
    .map(w => (e.notOpenable.includes(w.path) ? { ...w, branch: null, openable: false } : w))
    .map(w => ({ ...w, path: spell(w.path, e.upper) }));
  const listening = {};
  for (const [p, v] of e.listening) if (v !== null) listening[p] = v;
  return { kind: 'obs', o: obs(worktrees, { merged: e.merged, listening }) };
});
const closeArb = fc.constantFrom(...POOL.map(w => w.path)).map(p => ({ kind: 'close', p }));
const resultArb = fc.tuple(fc.constantFrom(...POOL.map(w => w.path)), fc.constantFrom('ok', 'failed', 'kept'))
  .map(([p, outcome]) => ({ kind: 'result', p, outcome }));
const reopenArb = fc.constantFrom(...POOL.map(w => w.path)).map(p => ({ kind: 'reopen', p }));
const eventsArb = fc.array(fc.oneof({ arbitrary: obsArb, weight: 4 }, closeArb, resultArb, reopenArb), { maxLength: 30 });

const RESULTS = {
  ok: { ok: true },
  failed: { ok: false, error: 'failed' },
  kept: { ok: false, kept: true, reason: 'still has a handoff brief' },
};

function apply(state, e) {
  if (e.kind === 'obs') return reconcile(state, e.o);
  if (e.kind === 'close') return closeByHand(state, e.p);
  if (e.kind === 'reopen') return reopen(state, e.p);
  return removeResult(state, e.p, RESULTS[e.outcome]);
}

// Runs the events, calling check(prevState, event, result) after each one.
function walk(events, check) {
  let state = initial();
  for (const e of events) {
    const r = apply(state, e);
    check(state, e, r);
    state = r.state;
  }
}

test('PROPERTY: no remove unless that observation says the host is not listening (strictly false)', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, e, r) => {
      for (const a of r.actions.filter(x => x.type === 'remove')) {
        assert.strictEqual(e.kind, 'obs');
        assert.strictEqual(e.o.listening[normPath(a.path)], false);
        assert.strictEqual(e.o.merged[normPath(a.path)], true);
      }
    });
  }));
});

test('PROPERTY: no remove unless the host was seen listening since the tab was marked merged', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    const seen = new Map();
    walk(events, (_, e, r) => {
      for (const a of r.actions) {
        const k = normPath(a.path);
        if (a.type === 'mark-merged') seen.set(k, false);
        if (a.type === 'remove') assert.strictEqual(seen.get(k), true, a.path);
      }
      if (e.kind === 'obs') {
        for (const [k, v] of Object.entries(e.o.listening)) if (v === true && seen.has(k)) seen.set(k, true);
      }
    });
  }));
});

test('PROPERTY: a poll stops or closes a tab only when git no longer lists its worktree at all', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, e, r) => {
      if (e.kind !== 'obs') return;
      for (const a of r.actions.filter(x => x.type === 'stop' || x.type === 'close')) {
        assert.ok(!e.o.worktrees.some(w => samePath(w.path, a.path)), `${a.type} ${a.path} while listed`);
      }
    });
  }));
});

test('PROPERTY: after a poll, a live, finishing or kept tab shows the branch git lists for it, when there is one', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, e, r) => {
      if (e.kind !== 'obs' || !e.o.worktrees.some(w => w.isDev)) return;
      for (const t of r.state.tabs.filter(x => ['live', 'finishing', 'kept'].includes(x.phase))) {
        const w = e.o.worktrees.find(x => samePath(x.path, t.path));
        if (w && w.branch) assert.strictEqual(t.branch, w.branch, t.path);
      }
    });
  }));
});

test('PROPERTY: a poll opens a tab only for an openable worktree', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, e, r) => {
      for (const a of r.actions.filter(x => x.type === 'open')) {
        assert.ok(e.o.worktrees.some(w => samePath(w.path, a.path) && w.openable), a.path);
      }
    });
  }));
});

test('PROPERTY: dev is never stopped, closed or removed', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, __, r) => {
      for (const a of r.actions) {
        if (['stop', 'close', 'remove', 'mark-merged'].includes(a.type)) assert.ok(!samePath(a.path, DEV), a.type);
      }
    });
  }));
});

test('PROPERTY: a dismissed path is never opened while dismissed, and stays dismissed while listed', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (prev, e, r) => {
      for (const a of r.actions.filter(x => x.type === 'open')) {
        assert.ok(!prev.dismissed.includes(normPath(a.path)), a.path);
      }
      // A path leaves `dismissed` only by a reopen of that path, or in a poll
      // where git doesn't list it.
      for (const d of prev.dismissed) {
        if (r.state.dismissed.includes(d)) continue;
        if (e.kind === 'reopen' && normPath(e.p) === d) continue;
        assert.strictEqual(e.kind, 'obs', 'only a poll or a reopen of that path un-dismisses');
        assert.ok(!e.o.worktrees.some(w => normPath(w.path) === d), `${d} un-dismissed while listed`);
      }
    });
  }));
});

test('PROPERTY: a path is never removed twice without being reopened in between (no automatic retry)', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    const outstanding = new Set();
    walk(events, (_, __, r) => {
      for (const a of r.actions) {
        const k = normPath(a.path);
        if (a.type === 'open') outstanding.delete(k);
        if (a.type === 'remove') {
          assert.ok(!outstanding.has(k), a.path);
          outstanding.add(k);
        }
      }
    });
  }));
});

test('PROPERTY: reconciling the same observation twice, the second call emits nothing', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, e, r) => {
      if (e.kind !== 'obs') return;
      const again = reconcile(r.state, e.o);
      assert.deepStrictEqual(again.actions, []);
      assert.deepStrictEqual(again.state, r.state);
    });
  }));
});

test('PROPERTY: whenever dev is among the worktrees, dev is the first tab, and no two tabs share a folder', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (_, e, r) => {
      const tabs = r.state.tabs;
      if (e.kind === 'obs' && e.o.worktrees.some(w => w.isDev)) {
        assert.ok(tabs[0].isDev);
        assert.ok(samePath(tabs[0].path, DEV));
      }
      assert.strictEqual(new Set(tabs.map(t => normPath(t.path))).size, tabs.length);
    });
  }));
});

test('PROPERTY: a kept tab is never removed, failed or errored by any later event until it goes back to live', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (prev, e, r) => {
      const keptBefore = prev.tabs.filter(t => t.phase === 'kept').map(t => normPath(t.path));
      // Moved to another branch in this event: live again, and its new branch
      // may be merged too. That is not the kept tab acting.
      const leftKept = (k) => r.state.tabs.some(t => normPath(t.path) === k && t.phase !== 'kept');
      for (const a of r.actions) {
        const k = normPath(a.path);
        if (!keptBefore.includes(k) || leftKept(k)) continue;
        assert.ok(!['remove', 'error', 'mark-merged'].includes(a.type), `${a.type} for a kept tab`);
      }
    });
  }));
});

test('PROPERTY: reopen never emits an action and never touches the tabs', () => {
  fc.assert(fc.property(eventsArb, fc.constantFrom(...POOL.map(w => w.path)), (events, p) => {
    walk(events, (_, __, r) => {
      const again = reopen(r.state, p);
      assert.deepStrictEqual(again.actions, []);
      assert.deepStrictEqual(again.state.tabs, r.state.tabs);
      assert.ok(!again.state.dismissed.includes(normPath(p)));
    });
  }));
});
