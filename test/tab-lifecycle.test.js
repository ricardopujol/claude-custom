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

const { initial, reconcile, closeByHand, removeResult } = require('../host/tab-lifecycle');
const { normPath, samePath } = require('../host/project-layout');

const C = path.resolve('/fake/proj');
const DEV = path.join(C, 'dev');
const A = path.join(C, 'feat-a');
const B = path.join(C, 'feat-b');

const wt = (p, branch, isDev = false) => ({ path: p, branch, isDev });
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
  merged: fc.subarray(POOL.map(w => w.path)),
  listening: fc.array(fc.tuple(fc.constantFrom(...POOL.map(w => w.path)), fc.constantFrom(true, false, null)),
    { maxLength: 4 }),
  upper: fc.boolean(),
}).map(e => {
  const worktrees = (e.withDev ? [DEV_WT, ...e.present] : e.present)
    .map(w => ({ ...w, path: spell(w.path, e.upper) }));
  const listening = {};
  for (const [p, v] of e.listening) if (v !== null) listening[p] = v;
  return { kind: 'obs', o: obs(worktrees, { merged: e.merged, listening }) };
});
const closeArb = fc.constantFrom(...POOL.map(w => w.path)).map(p => ({ kind: 'close', p }));
const resultArb = fc.tuple(fc.constantFrom(...POOL.map(w => w.path)), fc.boolean())
  .map(([p, ok]) => ({ kind: 'result', p, ok }));
const eventsArb = fc.array(fc.oneof({ arbitrary: obsArb, weight: 4 }, closeArb, resultArb), { maxLength: 30 });

function apply(state, e) {
  if (e.kind === 'obs') return reconcile(state, e.o);
  if (e.kind === 'close') return closeByHand(state, e.p);
  return removeResult(state, e.p, { ok: e.ok, error: 'failed' });
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

test('PROPERTY: no remove unless the host was seen listening since the tab opened', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    const seen = new Map();
    walk(events, (_, e, r) => {
      for (const a of r.actions) {
        const k = normPath(a.path);
        if (a.type === 'open') seen.set(k, false);
        if (a.type === 'remove') assert.strictEqual(seen.get(k), true, a.path);
      }
      if (e.kind === 'obs') {
        for (const [k, v] of Object.entries(e.o.listening)) if (v === true && seen.has(k)) seen.set(k, true);
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

test('PROPERTY: a dismissed path is never opened again', () => {
  fc.assert(fc.property(eventsArb, (events) => {
    walk(events, (prev, _, r) => {
      for (const a of r.actions.filter(x => x.type === 'open')) {
        assert.ok(!prev.dismissed.includes(normPath(a.path)), a.path);
      }
      for (const d of prev.dismissed) assert.ok(r.state.dismissed.includes(d), 'dismissed only grows');
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
