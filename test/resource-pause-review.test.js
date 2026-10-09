'use strict';
/**
 * host/resource-pause.js after the PR #158 review (Dexter 2, 6, 7, 9; Miguel Y1, Y2, Y3, Y4): nothing frozen is ever forgotten. Unknown is not
 * "not suspended"; what cannot be woken stays recorded; a quit waits for a pause in flight, wakes everything at once and gives up after a
 * deadline; orphans of a vanished root and the leftovers of a dead run are woken by their proved starts.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createPauser } = require('../host/resource-pause');
const { createPauseStore } = require('../host/pause-state');
const { suspendVerified } = require('../host/process-suspend');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const p = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd: cmd || null, start: String(start), priv: 1 });
const world = () => [
  p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 1000),
  p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 1010),
  p(22, 20, 'claude.exe', 'claude.exe', 1030),
  p(23, 22, 'bash.exe', 'bash -c burn', 5000),
  p(24, 23, 'node.exe', 'node burn.js', 5100),
  p(25, 24, 'node.exe', 'node helper.js', 5200),
  p(26, 22, 'node.exe', 'node other.js', 5300),
];

function rig({ suspend, store = createPauseStore({ now: () => 1000 }), ...extra } = {}) {
  const pauser = createPauser({ readProcs: async () => world(), hostPids: () => [20], suspend, store, ...extra });
  return { pauser, store };
}
// The real suspendVerified over a scripted exec: the answer is whatever text the script got to print (or an Error it threw).
function scripted(answers) {
  const calls = [];
  let i = 0;
  const suspend = (action, targets) => suspendVerified(action, targets, {
    exec: async () => {
      calls.push([action, targets.map(t => t.pid)]);
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  });
  return { calls, suspend };
}

test('Dexter 2: a suspend cut off after "24 done" (no END) wakes 24 and the child it said nothing about, and the pause is refused', async () => {
  const sc = scripted(['24 done\n24 start 5100\n', '24 done\n25 done\n24 start 5100\n25 start 5200\nEND\n']);
  const { pauser, store } = rig({ suspend: sc.suspend });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(sc.calls, [['suspend', [24, 25]], ['resume', [24, 25]]], 'the unknown child is woken too: it may have been suspended');
  assert.deepStrictEqual(store.list(), [], 'everything was woken, so nothing stays recorded');
});

test('Dexter 2: the same cutoff when the wake-up ALSO fails records both pids, so Resume, a quit and the next start can still reach them', async () => {
  const sc = scripted(['24 done\n24 start 5100\n', new Error('powershell timed out'), '24 done\n25 done\nEND\n']);
  const { pauser, store } = rig({ suspend: sc.suspend });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.stuck, [24, 25]);
  assert.match(r.text, /PID 24, 25 could not be woken again/);
  assert.deepStrictEqual(store.list()[0].pids, [{ pid: 24, start: '5100' }, { pid: 25, start: '5200' }]);
  const all = await pauser.resumeAll();
  assert.deepStrictEqual(all, { resumed: 1, failed: 0 });
  assert.deepStrictEqual(store.list(), []);
  assert.deepStrictEqual(sc.calls.at(-1), ['resume', [24, 25]]);
});

test('Dexter 2: no stdout at all (the exec threw) is unknown too: the targets are woken, not forgotten', async () => {
  const sc = scripted([new Error('timed out'), '24 done\n25 done\nEND\n']);
  const { pauser, store } = rig({ suspend: sc.suspend });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(sc.calls[1], ['resume', [24, 25]]);
  assert.deepStrictEqual(store.list(), []);
});

test('Dexter 9 / Miguel Y1: a rollback whose wake-up fails records the stuck pids (a failed child, the others suspended)', async () => {
  const { pauser, store } = rig({
    suspend: async (act, t) => (act === 'suspend'
      ? t.map(x => ({ pid: x.pid, status: x.pid === 25 ? 'failed' : 'done', text: x.pid === 25 ? 'denied' : undefined }))
      : t.map(x => ({ pid: x.pid, status: 'failed', text: 'no' }))),
  });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.deepStrictEqual(r.stuck, [24]);
  assert.deepStrictEqual(store.list().map(e => [e.pid, e.pids]), [[24, [{ pid: 24, start: '5100' }]]]);
  assert.strictEqual(store.isPaused(24, '5100'), true, 'so the row says paused and offers Resume');
});

test('a pause that was rolled back cleanly records nothing', async () => {
  const { pauser, store } = rig({
    suspend: async (act, t) => t.map(x => ({ pid: x.pid, status: act === 'suspend' && x.pid === 25 ? 'failed' : 'done' })),
  });
  assert.strictEqual((await pauser.pause({ pid: 24, startTime: '5100' })).ok, false);
  assert.deepStrictEqual(store.list(), []);
});

test('Dexter 7: a pause still in flight when the quit starts is awaited, then woken, and hasPaused-style pending() is true meanwhile', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const { pauser, store } = rig({ suspend: async (act, t) => { calls.push(act); if (act === 'suspend') await gate; return t.map(x => ({ pid: x.pid, status: 'done' })); } });
  const pausing = pauser.pause({ pid: 24, startTime: '5100' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(pauser.pending(), 1);
  assert.deepStrictEqual(store.list().map(e => [e.pid, e.pending]), [[24, true]], 'recorded BEFORE the script answers (write-ahead), as pending');
  assert.deepStrictEqual(store.listConfirmed(), [], 'but not shown as paused yet');
  const quitting = pauser.resumeAll();
  release();
  await pausing;
  const res = await quitting;
  assert.deepStrictEqual(res, { resumed: 1, failed: 0 });
  assert.deepStrictEqual(calls, ['suspend', 'resume'], 'the wake-up came AFTER the suspend landed');
  assert.deepStrictEqual(store.list(), []);
  assert.strictEqual(pauser.pending(), 0);
});

test('Miguel Y2: resumeAll wakes every entry at once, not one after the other', async () => {
  const store = createPauseStore();
  const starts = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const { pauser } = rig({ store, suspend: async (act, t) => { if (act === 'resume') { starts.push(t[0].pid); await gate; } return t.map(x => ({ pid: x.pid, status: 'done' })); } });
  store.add({ pid: 24, start: '5100', name: 'a', pids: [{ pid: 24, start: '5100' }] });
  store.add({ pid: 26, start: '5300', name: 'b', pids: [{ pid: 26, start: '5300' }] });
  const all = pauser.resumeAll();
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(starts.sort(), [24, 26], 'both resumes started before either finished');
  release();
  assert.deepStrictEqual(await all, { resumed: 2, failed: 0 });
});

test('Miguel Y2: resumeAll gives up after its deadline, says so, and leaves what it did not wake recorded', async () => {
  const store = createPauseStore();
  const { pauser } = rig({ store, suspend: () => new Promise(() => {}) });
  store.add({ pid: 24, start: '5100', name: 'a', pids: [{ pid: 24, start: '5100' }] });
  const t0 = Date.now();
  const res = await pauser.resumeAll({ deadlineMs: 30 });
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(res.timedOut, true);
  assert.deepStrictEqual([res.resumed, res.failed], [0, 0]);
});

test('Miguel Y2: the deadline timer is cleared when the wake-up finishes in time (a quit must not wait on it)', async () => {
  const timers = [];
  const store = createPauseStore();
  const { pauser } = rig({
    store, suspend: async (a, t) => t.map(x => ({ pid: x.pid, status: 'done' })),
    setTimer: (fn, ms) => { timers.push({ ms, cleared: false }); return timers.length - 1; }, clearTimer: (id) => { timers[id].cleared = true; },
  });
  store.add({ pid: 24, start: '5100', name: 'a', pids: [{ pid: 24, start: '5100' }] });
  assert.deepStrictEqual(await pauser.resumeAll({ deadlineMs: 777 }), { resumed: 1, failed: 0 });
  assert.deepStrictEqual(timers, [{ ms: 777, cleared: true }]);
});

test('Dexter 6 / Miguel Y3: orphans of a vanished root are woken by their proved starts', async () => {
  const calls = [];
  const { pauser, store } = rig({ suspend: async (act, t) => { calls.push([act, t]); return t.map(x => ({ pid: x.pid, status: 'done' })); } });
  const r = await pauser.wakeOrphans([{ pid: 23, start: '5000', name: 'sh', alive: [{ pid: 24, start: '5100' }] }, { pid: 30, start: '1', name: 'x', alive: [] }]);
  assert.deepStrictEqual(r, { woken: 1, stuck: 0 });
  assert.deepStrictEqual(calls, [['resume', [{ pid: 24, start: '5100' }]]]);
  assert.deepStrictEqual(store.list(), []);
});

test('an orphan that cannot be woken is recorded again (root-less), so the next sample tries again', async () => {
  const { pauser, store } = rig({ suspend: async (act, t) => t.map(x => ({ pid: x.pid, status: 'failed', text: 'denied' })) });
  store.add({ pid: 23, start: '5000', name: 'sh', since: 7, pids: [{ pid: 24, start: '5100' }] }, { rootInSet: false });   // reconcile keeps the entry until the wake is confirmed
  const r = await pauser.wakeOrphans([{ pid: 23, start: '5000', name: 'sh', since: 7, alive: [{ pid: 24, start: '5100' }] }]);
  assert.deepStrictEqual(r, { woken: 0, stuck: 1 });
  assert.deepStrictEqual(store.list().map(e => [e.pid, e.since, e.pids]), [[23, 7, [{ pid: 24, start: '5100' }]]]);
  assert.deepStrictEqual(await pauser.wakeOrphans(undefined), { woken: 0, stuck: 0 });
});

test('Miguel Y4: the leftovers of a dead run are woken through their proved starts, and what stays suspended is recorded in this run', async () => {
  const calls = [];
  const { pauser, store } = rig({ suspend: async (act, t) => { calls.push(t.map(x => x.pid)); return t.map(x => ({ pid: x.pid, status: x.pid === 25 ? 'failed' : 'done' })); } });
  const res = await pauser.wakeStale([{ pid: 24, start: '5100', name: 'a', since: 3, pids: [{ pid: 24, start: '5100' }, { pid: 25, start: '5200' }] }]);
  assert.deepStrictEqual(res, { stuck: 1 });
  assert.deepStrictEqual(calls, [[24, 25]]);
  assert.deepStrictEqual(store.list()[0].pids, [{ pid: 25, start: '5200' }]);
  assert.deepStrictEqual(await pauser.wakeStale(null), { stuck: 0 });
});

// ---- PR #158 review round 2 ---------------------------------------------------------------------------------------------

test('R2-2 write-ahead: a suspend that NEVER answers has its targets on disk already, and a quit past the deadline leaves them there for the next start', async () => {
  const saved = [];
  const store = createPauseStore({ onChange: list => saved.push(list.map(e => [e.pid, e.pids.map(p => p.pid + ':' + p.start)])) });
  const { pauser } = rig({ store, suspend: () => new Promise(() => {}) });
  pauser.pause({ pid: 24, startTime: '5100' });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(saved.at(-1), [[24, ['24:5100', '25:5200']]], 'on disk before the script has answered');
  const res = await pauser.resumeAll({ deadlineMs: 20 });
  assert.strictEqual(res.timedOut, true);
  assert.deepStrictEqual(saved.at(-1), [[24, ['24:5100', '25:5200']]], 'and still there after the quit gave up');
});

test('R2-2: a resume that never answers leaves the entry in the store (and so on disk): the removal waits for the confirmed wake', async () => {
  const saved = [];
  const store = createPauseStore({ onChange: list => saved.push(list.length) });
  let mode = 'ok';
  const { pauser } = rig({ store, suspend: (act, t) => (act === 'resume' && mode === 'hang' ? new Promise(() => {}) : Promise.resolve(t.map(x => ({ pid: x.pid, status: 'done' })))) });
  await pauser.pause({ pid: 24, startTime: '5100' });
  mode = 'hang';
  pauser.resume({ pid: 24, startTime: '5100' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(store.peek(24, '5100') !== null, true);
  assert.strictEqual(saved.at(-1), 1, 'the file still names it while the wake is in flight');
});

test('R2-2: a clean pause that is rolled back leaves nothing recorded, and a failed wake leaves the stuck ones', async () => {
  const store = createPauseStore();
  const { pauser } = rig({ store, suspend: async (act, t) => t.map(x => ({ pid: x.pid, status: act === 'suspend' && x.pid === 25 ? 'failed' : 'done' })) });
  await pauser.pause({ pid: 24, startTime: '5100' });
  assert.deepStrictEqual(store.list(), []);
});

test('R2-2: Pause on a process that is ALREADY suspended (a crashed run, another tool) adopts it: the row reads paused and Resume wakes it, not a dead end', async () => {
  const calls = [];
  const store = createPauseStore();
  const { pauser } = rig({ store, suspend: async (act, t) => { calls.push(act); return act === 'suspend' ? [{ pid: 24, status: 'failed', text: 'already suspended' }] : t.map(x => ({ pid: x.pid, status: 'done' })); } });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.adopted, true);
  assert.deepStrictEqual(store.listConfirmed().map(e => [e.pid, e.pids]), [[24, [{ pid: 24, start: '5100' }]]]);
  assert.deepStrictEqual(await pauser.resume({ pid: 24, startTime: '5100' }), { ok: true, pid: 24 });
  assert.deepStrictEqual(calls, ['suspend', 'resume']);
});

test('R2-6: an extra the script found that could NOT be suspended rolls the pause back (27 failed: Access is denied)', async () => {
  const answer = ['24 done', '24 start 5100', '25 done', '25 start 5200', '27 failed could not open it: Access is denied', 'END', ''].join(String.fromCharCode(10));
  const sc = scripted([answer, ['24 done', '25 done', 'END', ''].join(String.fromCharCode(10))]);
  const { pauser, store } = rig({ suspend: sc.suspend });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'suspend-failed');
  assert.match(r.text, /PID 27 could not be suspended/);
  assert.deepStrictEqual(sc.calls.at(-1), ['resume', [24, 25]]);
  assert.deepStrictEqual(store.list(), []);
});

test('R2-7 / Dexter 6: an orphan entry stays in the store until its wake is confirmed, then leaves', async () => {
  const store = createPauseStore();
  const { pauser } = rig({ store, suspend: async (a, t) => t.map(x => ({ pid: x.pid, status: 'done' })) });
  store.add({ pid: 23, start: '5000', name: 'sh', pids: [{ pid: 23, start: '5000' }, { pid: 24, start: '5100' }] });
  const ended = store.reconcile([p(24, 23, 'node.exe', 'x', 5100)]);
  assert.strictEqual(store.list().length, 1, 'still recorded after reconcile');
  await pauser.wakeOrphans(ended);
  assert.deepStrictEqual(store.list(), []);
});

test('R2-7: a stale entry from a dead run is recorded in THIS run before it is woken, and removed only once the wake is confirmed', async () => {
  const order = [];
  const store = createPauseStore({ onChange: l => order.push('saved:' + l.length) });
  const { pauser } = rig({ store, suspend: async (a, t) => { order.push('resume'); return t.map(x => ({ pid: x.pid, status: 'done' })); } });
  await pauser.wakeStale([{ pid: 24, start: '5100', name: 'a', since: 3, pids: [{ pid: 24, start: '5100' }] }]);
  assert.deepStrictEqual(order, ['saved:1', 'resume', 'saved:0']);
});
