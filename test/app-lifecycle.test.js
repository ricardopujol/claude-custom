'use strict';
/**
 * app/app-lifecycle.js (PR #258 Miguel I4): the app lock's, the restore record's and the quit's decisions out of app/main.js, so each path is
 * behaviour under plain node and not a regex. Covers PR #258 Dexter 2, 6, 7, 8, 9, 13 and Miguel I1, I2, S5. Fakes for every effect.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRegistry } = require('../app/project-registry');

const load = () => require('../app/app-lifecycle');
const settle = () => new Promise((r) => setImmediate(r));

function fakeWin(root, { visible = true, alive = true, unsaved = [] } = {}) {
  const w = { root, label: root.toLowerCase(), launchCwd: `${root}/dev`, allowed: null, saved: 0, focused: 0, claimResumed: 0,
    win: alive ? { destroyed: false, isDestroyed() { return this.destroyed; }, isVisible: () => visible } : null,
    readerUnsaved: { list: unsaved.map((p, i) => ({ key: `k${i}`, path: p })), all() { return this.list; } },
    saveReaders() { this.saved++; }, allowClose(on) { this.allowed = on; }, focusWindow() { this.focused++; },
    claim: { resume: async () => { w.claimResumed++; } }, dispose() {} };
  return w;
}

function rig(over = {}) {
  const calls = [];
  const registry = createProjectRegistry();
  let busy = false;
  let idle = [];
  const openQueue = { busy: () => busy, onIdle: (fn) => { idle.push(fn); } };
  const writes = [];
  let lockOwner = { pid: 50, start: 'S50' };
  let recordOnDisk = null;
  const writerOf = ({ owner, owns }) => ({
    begin: (o) => { if (owns()) writes.push(['begin', o]); },
    sync: (l) => { if (owns()) writes.push(['sync', l]); },
    endRestore: (l) => { if (owns()) writes.push(['endRestore', l]); },
    markClean: () => { if (owns()) writes.push(['markClean']); },
    reopen: (l) => { if (owns()) writes.push(['reopen', l]); },
  });
  const appClaim = {
    stop: () => calls.push(['appClaim.stop']),
    resume: async () => { calls.push(['appClaim.resume']); },
    reclaim: async () => { calls.push(['appClaim.reclaim']); lockOwner = { pid: 50, start: 'S50' }; return true; },
  };
  let quitting = false;
  const deps = {
    registry, openQueue, appClaim, lockOn: true, pid: 50,
    ownStart: async () => 'S50',
    readLockOwner: () => lockOwner,
    readRecord: () => recordOnDisk,
    proveOwner: async () => 'dead',
    decide: (record, proof) => (record && record.clean === false && proof === 'dead'
      ? { restore: record.windows, skipped: [], reason: 'restore' } : { restore: [], skipped: [], reason: 'nothing' }),
    makeWriter: writerOf,
    openProject: async (o) => { calls.push(['openProject', o]); return { ok: true }; },
    quit: () => calls.push(['quit']),
    getLaunchWindow: () => null,
    quitGate: { reset: () => calls.push(['gate.reset']), asking: () => false },
    setQuitting: (v) => { quitting = v; calls.push(['setQuitting', v]); },
    isQuitting: () => quitting,
    log: () => {},
    ...over,
  };
  const lc = load().createAppLifecycle(deps);
  return {
    lc, calls, registry, writes,
    setBusy: (v) => { busy = v; if (!v) { const f = idle; idle = []; for (const fn of f) fn(); } },
    setLock: (o) => { lockOwner = o; }, setRecord: (r) => { recordOnDisk = r; },
  };
}

// ---- Dexter 8 / Miguel I1: nothing is written before the launch settled ------------------------------------------------------------

test('D8 / I1: decideRestore writes NOTHING; an exit before beginRecord leaves the crash list on disk for the next launch', async () => {
  const t = rig();
  t.setRecord({ owner: { pid: 7, start: 'S7' }, clean: false, windows: [{ root: 'P', cwd: 'P/dev', hidden: false }] });
  const plan = await t.lc.decideRestore('L');
  assert.deepStrictEqual(plan.map((w) => w.root), ['P']);
  assert.deepStrictEqual(t.writes, [], 'no begin() yet: an elsewhere / no-port / attach-only exit here keeps the record as it was');
  t.lc.beginRecord();
  assert.deepStrictEqual(t.writes, [['begin', { restoring: true, keep: [{ root: 'P', cwd: 'P/dev', hidden: false }] }]]);
});

test('D8: with nothing to restore beginRecord writes restoring false and an empty list', async () => {
  const t = rig();
  await t.lc.decideRestore('L');
  t.lc.beginRecord();
  assert.deepStrictEqual(t.writes, [['begin', { restoring: false, keep: [] }]]);
});

test('decideRestore: the lock off, no own start, or app.json not this process -> [] and no writer', async () => {
  for (const over of [{ lockOn: false }, { ownStart: async () => null }, { readLockOwner: () => ({ pid: 9, start: 'S9' }) }]) {
    const t = rig(over);
    t.setRecord({ owner: { pid: 7, start: 'S7' }, clean: false, windows: [{ root: 'P', cwd: 'P/dev', hidden: false }] });
    assert.deepStrictEqual(await t.lc.decideRestore('L'), []);
    t.lc.beginRecord();
    assert.deepStrictEqual(t.writes, []);
  }
});

// ---- Dexter 7 / Miguel I2: the last window closing while an open is in flight --------------------------------------------------------

test('D7 / I2: window-all-closed with an open in flight does not quit; once the queue is idle it quits only if no window came up', async () => {
  const t = rig();
  t.setBusy(true);
  t.lc.onWindowAllClosed();
  assert.ok(!t.calls.some((c) => c[0] === 'quit'), 'a launch told ok is being opened: no quit');
  t.registry.add(fakeWin('Q'));                     // the open made its window
  t.setBusy(false);
  assert.ok(!t.calls.some((c) => c[0] === 'quit'), 'a window came up: the process stays');
  const u = rig();
  u.setBusy(true);
  u.lc.onWindowAllClosed();
  u.setBusy(false);                                   // the open failed: no window
  assert.deepStrictEqual(u.calls.filter((c) => c[0] === 'quit'), [['quit']]);
});

test('window-all-closed with nothing in flight quits at once (as before)', () => {
  const t = rig();
  t.lc.onWindowAllClosed();
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'quit'), [['quit']]);
});

test('quitIfEmpty: a window, or an open in flight, keeps the process; else the app claim stops BEFORE the quit', () => {
  const t = rig();
  t.registry.add(fakeWin('A'));
  assert.strictEqual(t.lc.quitIfEmpty(), false);
  const u = rig();
  u.setBusy(true);
  assert.strictEqual(u.lc.quitIfEmpty(), false);
  const v = rig();
  assert.strictEqual(v.lc.quitIfEmpty(), true);
  assert.deepStrictEqual(v.calls, [['appClaim.stop'], ['quit']]);
});

// ---- Dexter 6: the last window's stale unsaved text after its own Discard ---------------------------------------------------------

test('D6: the quit gate lists only windows whose window is still there: a closed last window\'s stale text is never asked about again', () => {
  const t = rig();
  t.registry.add(fakeWin('A', { alive: false, unsaved: ['discarded.md'] }));   // closed with Discard, still registered (the last one)
  t.registry.add(fakeWin('B', { unsaved: ['b.md'] }));
  const listed = t.lc.gateWindows();
  assert.deepStrictEqual(listed.map((w) => w.label), ['b'], 'only B: A has no window to answer for, and its text was discarded');
  assert.deepStrictEqual(listed[0].unsaved(), ['b.md']);
  listed[0].saveAll(); listed[0].allowClose();
  assert.strictEqual(t.registry.get('B').saved, 1);
  assert.strictEqual(t.registry.get('B').allowed, true);
});

test('dirtyParent: the dirty window used last, else the first dirty one; never a window that has gone', () => {
  const t = rig();
  const a = fakeWin('A', { unsaved: ['a.md'] }); const b = fakeWin('B', { unsaved: ['b.md'] }); const gone = fakeWin('C', { alive: false, unsaved: ['c.md'] });
  t.registry.add(gone); t.registry.add(a); t.registry.add(b);
  assert.strictEqual(t.lc.dirtyParent(), a);
  t.registry.touch(b);
  assert.strictEqual(t.lc.dirtyParent(), b);
  t.registry.touch(gone);
  assert.strictEqual(t.lc.dirtyParent(), a, 'the one used last has no window: the first live dirty one');
});

// ---- Dexter 9 / Miguel S5: a cancelled quit writes the record not clean again ------------------------------------------------------

test('D9 / S5: quitCancelled puts quitting back, resets the gate, resumes the claims, and REOPENS the record once the app claim is back', async () => {
  const t = rig();
  const a = fakeWin('A');
  t.registry.add(a);
  await t.lc.decideRestore('L'); t.lc.beginRecord();
  t.lc.markRecordClean();
  t.lc.quitCancelled();
  await settle(); await settle();
  assert.ok(t.calls.some((c) => c[0] === 'setQuitting' && c[1] === false));
  assert.ok(t.calls.some((c) => c[0] === 'gate.reset'));
  assert.ok(t.calls.some((c) => c[0] === 'appClaim.resume'));
  assert.strictEqual(a.claimResumed, 1);
  assert.strictEqual(a.allowed, false);
  assert.deepStrictEqual(t.writes.at(-1), ['reopen', [{ root: 'A', cwd: 'A/dev', hidden: false }]]);
});

// ---- Dexter 2: a displaced owner claims again -------------------------------------------------------------------------------------

test('D2: the reclaim tick: not owning app.json while running -> reclaim, and when it is ours again the record is written with the open windows', async () => {
  const t = rig();
  t.registry.add(fakeWin('P'));
  await t.lc.decideRestore('L'); t.lc.beginRecord();
  t.setLock(null);                                    // the displacer quit and released app.json
  await t.lc.reclaimTick();
  assert.ok(t.calls.some((c) => c[0] === 'appClaim.reclaim'));
  assert.deepStrictEqual(t.writes.at(-1), ['reopen', [{ root: 'P', cwd: 'P/dev', hidden: false }]]);
});

test('D2: the tick does nothing while this process owns the lock, while quitting, or with the lock off', async () => {
  const t = rig();
  await t.lc.decideRestore('L'); t.lc.beginRecord();
  await t.lc.reclaimTick();
  assert.ok(!t.calls.some((c) => c[0] === 'appClaim.reclaim'), 'owned: nothing to do');
  t.setLock(null);
  t.lc.quitCancelled; // (no-op reference)
  const q = rig({ isQuitting: () => true });
  await q.lc.decideRestore('L'); q.lc.beginRecord(); q.setLock(null);
  await q.lc.reclaimTick();
  assert.ok(!q.calls.some((c) => c[0] === 'appClaim.reclaim'), 'quitting: claim nothing');
  const off = rig({ lockOn: false });
  await off.lc.reclaimTick();
  assert.ok(!off.calls.some((c) => c[0] === 'appClaim.reclaim'));
});

// ---- Dexter 13: a launch while the quit question is up ------------------------------------------------------------------------------

test('D13: while the quit question is up, launches are refused (each opens its own process: never quit with this one)', () => {
  let asking = false;
  const t = rig({ quitGate: { reset() {}, asking: () => asking } });
  assert.strictEqual(t.lc.refuseLaunches(), false);
  asking = true;
  assert.strictEqual(t.lc.refuseLaunches(), true);
});

// ---- the restores and the record's clean mark --------------------------------------------------------------------------------------

test('runRestores: every window through openProject (hidden ones hidden), then endRestore with the windows open now', async () => {
  const t = rig();
  await t.lc.decideRestore('L'); t.lc.beginRecord();
  t.registry.add(fakeWin('A'));
  await t.lc.runRestores([{ root: 'P', cwd: 'P/dev', hidden: true }, { root: 'Q', cwd: 'Q/dev', hidden: false }]);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'openProject').map((c) => c[1]), [{ cwd: 'P/dev', show: 'hidden' }, { cwd: 'Q/dev', show: 'shown' }]);
  assert.deepStrictEqual(t.writes.at(-1)[0], 'endRestore');
});

test('currentWindows: root, launch folder, hidden only when the window is there and not visible', () => {
  const t = rig();
  t.registry.add(fakeWin('A', { visible: false }));
  t.registry.add(fakeWin('B', { alive: false }));
  assert.deepStrictEqual(t.lc.currentWindows(), [{ root: 'A', cwd: 'A/dev', hidden: true }, { root: 'B', cwd: 'B/dev', hidden: false }]);
});

// ---- Jiandu Home ------------------------------------------------------------------------------------------------------------------

test('Jiandu Home: an open Home keeps the process: quitIfEmpty with no project window and Home open neither stops the claim nor quits', () => {
  let home = true;
  const t = rig({ homeOpen: () => home });
  assert.strictEqual(t.lc.quitIfEmpty(), false);
  assert.deepStrictEqual(t.calls, []);
  home = false;
  assert.strictEqual(t.lc.quitIfEmpty(), true);
  assert.deepStrictEqual(t.calls, [['appClaim.stop'], ['quit']]);
});

test('Jiandu Home (H9): a restore whose record had Home open shows Home; one without it does not', async () => {
  const shown = [];
  const decide = (record) => ({ restore: record.windows, skipped: [], reason: 'restore', home: record.home === true });
  for (const home of [true, false]) {
    const t = rig({ decide, showHome: () => shown.push(home) });
    t.setRecord({ owner: { pid: 7, start: 'S7' }, clean: false, windows: [], home });
    const plan = await t.lc.decideRestore(null);
    t.lc.beginRecord();
    await t.lc.runRestores(plan);
  }
  assert.deepStrictEqual(shown, [true]);
});

test('PR #263 Dexter 3: the quit that waits for an open in flight counts Home: Home open again before the open ends keeps the process', () => {
  let home = false;
  const t = rig({ homeOpen: () => home });
  t.setBusy(true);
  t.lc.onWindowAllClosed();
  home = true;                          // a second launch (type 'home') or the tray's Home, before the open ends
  t.setBusy(false);                     // the open ended with no project window
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'quit'), []);
});

test('PR #263 Dexter 4: a restore that brings back only Home leaves the launch window in front', async () => {
  const order = [];
  const lw = fakeWin('L');
  lw.focusWindow = () => order.push('focus launch');
  const decide = () => ({ restore: [], skipped: [], reason: 'restore', home: true });
  const t = rig({ decide, showHome: () => order.push('showHome'), getLaunchWindow: () => lw });
  t.setRecord({ owner: { pid: 7, start: 'S7' }, clean: false, windows: [], home: true });
  const plan = await t.lc.decideRestore('L');
  t.lc.beginRecord();
  await t.lc.runRestores(plan);
  assert.deepStrictEqual(order, ['showHome', 'focus launch']);
});

test('PR #263 Miguel G1: a restore obeys a Home that was hidden, and never re-shows a Home this launch already made (Start minimised)', async () => {
  const decide = (record) => ({ restore: [], skipped: [], reason: 'restore', home: true, homeHidden: record.homeHidden === true });
  for (const [homeHidden, open, want] of [[true, false, [{ hidden: true }]], [false, false, [{ hidden: false }]], [false, true, []]]) {
    const shown = [];
    const t = rig({ decide, homeOpen: () => open, showHome: (o) => shown.push(o) });
    t.setRecord({ owner: { pid: 7, start: 'S7' }, clean: false, windows: [], home: true, homeHidden });
    const plan = await t.lc.decideRestore(null);
    t.lc.beginRecord();
    await t.lc.runRestores(plan);
    assert.deepStrictEqual(shown, want, `hidden ${homeHidden}, already open ${open}`);
  }
});
