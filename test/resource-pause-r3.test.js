'use strict';
/**
 * PR #158 Dexter round 3 (N1, N3, N6): a record leaves only through the operation that owns it, an adopt covers the whole subtree, and the
 * leftovers of a dead run are woken together with the workers found under their root.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createPauser } = require('../host/resource-pause');
const { createPauseStore } = require('../host/pause-state');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const p = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd: cmd || null, start: String(start), priv: 1 });
const world = (extra = []) => [
  p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 1000),
  p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 1010),
  p(22, 20, 'claude.exe', 'claude.exe', 1030),
  p(23, 22, 'bash.exe', 'bash -c burn', 5000),
  p(24, 23, 'node.exe', 'node burn.js', 5100),
  p(25, 24, 'node.exe', 'node helper.js', 5200),
  p(26, 22, 'node.exe', 'node other.js', 5300),
  ...extra,
];
const done = t => t.map(x => ({ pid: x.pid, status: 'done', start: x.start }));
const gate = () => { let open; const g = new Promise((r) => { open = r; }); return { g, open }; };
const tick = () => new Promise(r => setImmediate(r));
const stale = () => ({ pid: 24, start: '5100', name: 'node.exe', since: 5, pids: [{ pid: 24, start: '5100' }, { pid: 25, start: '5200' }] });

test('N1: a sweep that finds a pause of the same root in flight leaves its record alone: the pause stays recorded and confirmed', async () => {
  const store = createPauseStore({ now: () => 1000 });
  const hold = gate();
  const calls = [];
  const suspend = async (act, t) => {
    calls.push(act);
    if (act === 'suspend') await hold.g;
    return done(t);
  };
  const pauser = createPauser({ readProcs: async () => world(), hostPids: () => [20], suspend, store });
  const pausing = pauser.pause({ pid: 24, startTime: '5100' });
  await tick();
  const swept = await pauser.wakeStale([stale()]);
  assert.deepStrictEqual(swept, { stuck: 0 });
  assert.deepStrictEqual(calls, ['suspend'], 'the sweep did not wake what the pause is suspending');
  hold.open();
  const r = await pausing;
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(store.listConfirmed().map(e => e.pid), [24], 'the pause is recorded and shows as paused');
  assert.deepStrictEqual(store.list()[0].pids.map(x => x.pid), [24, 25]);
});

test('N1: a pause whose record vanished is not answered ok on a lost record: it is recorded again (the processes are suspended)', async () => {
  const store = createPauseStore({ now: () => 1000 });
  const suspend = async (act, t) => {
    if (act === 'suspend') store.remove(24, '5100');   // whoever took the record
    return done(t);
  };
  const pauser = createPauser({ readProcs: async () => world(), hostPids: () => [20], suspend, store });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(store.listConfirmed().map(e => e.pid), [24], 'what is suspended is on record again');
});

test('N1: an adopt whose record vanished does not throw', async () => {
  const store = createPauseStore({ now: () => 1000 });
  const suspend = async (act, t) => {
    if (act === 'suspend') { store.remove(24, '5100'); return t.map(x => ({ pid: x.pid, status: 'failed', text: 'already suspended' })); }
    return done(t);
  };
  const pauser = createPauser({ readProcs: async () => world(), hostPids: () => [20], suspend, store });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.since, 'number');
  assert.deepStrictEqual(store.listConfirmed().map(e => e.pid), [24]);
});

test('N6: an adopt records the whole subtree (the script never visited the children), so Resume wakes 25 too', async () => {
  const store = createPauseStore({ now: () => 1000 });
  const calls = [];
  const suspend = async (act, t) => {
    calls.push([act, t.map(x => x.pid)]);
    if (act === 'suspend') return t.map((x, i) => (i === 0 ? { pid: x.pid, status: 'failed', text: 'already suspended' } : { pid: x.pid, status: 'failed', unknown: true, text: 'no answer from the suspend' }));
    return done(t);
  };
  const pauser = createPauser({ readProcs: async () => world(), hostPids: () => [20], suspend, store });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.adopted, true);
  await pauser.resume({ pid: 24, startTime: '5100' });
  assert.deepStrictEqual(calls.at(-1), ['resume', [24, 25]]);
  assert.deepStrictEqual(store.list(), []);
});

test('N3: the leftovers of a dead run are woken together with the workers found under their root', async () => {
  const store = createPauseStore({ now: () => 1000 });
  const calls = [];
  const suspend = async (act, t) => { calls.push(t.map(x => `${x.pid}:${x.start}`)); return done(t); };
  const pauser = createPauser({ readProcs: async () => world([p(27, 24, 'node.exe', 'node worker.js', 5400)]), hostPids: () => [20], suspend, store });
  await pauser.wakeStale([stale()]);
  assert.deepStrictEqual(calls, [['24:5100', '25:5200', '27:5400']]);
  assert.deepStrictEqual(store.list(), []);
});

test('N3: a root that is another process now adds nothing: only the recorded pids are woken', async () => {
  const store = createPauseStore({ now: () => 1000 });
  const calls = [];
  const suspend = async (act, t) => { calls.push(t.map(x => x.pid)); return done(t); };
  const procs = world([p(27, 24, 'node.exe', 'node worker.js', 5400)]).map(x => (x.pid === 24 ? { ...x, start: '9999' } : x));
  const pauser = createPauser({ readProcs: async () => procs, hostPids: () => [20], suspend, store });
  await pauser.wakeStale([stale()]);
  assert.deepStrictEqual(calls, [[24, 25]]);
});

test('property: whatever the order of a sweep and a pause of the same root, and whether a wake works, a suspended process is never left without a record', async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (sweepFirst, wakeOk) => {
    const store = createPauseStore({ now: () => 1000 });
    const hold = gate();
    const suspended = new Set();
    const suspend = async (act, t) => {
      if (act === 'suspend') await hold.g;
      for (const x of t) { if (act === 'suspend') suspended.add(x.pid); else if (wakeOk) suspended.delete(x.pid); }
      return t.map(x => ({ pid: x.pid, status: act === 'resume' && !wakeOk ? 'failed' : 'done', start: x.start }));
    };
    const pauser = createPauser({ readProcs: async () => world(), hostPids: () => [20], suspend, store });
    let sw;
    if (sweepFirst) sw = pauser.wakeStale([stale()]);
    const pausing = pauser.pause({ pid: 24, startTime: '5100' });
    await tick();
    if (!sweepFirst) sw = pauser.wakeStale([stale()]);
    await tick();
    hold.open();
    await Promise.all([pausing, sw]);
    const recorded = new Set(store.list().flatMap(e => e.pids.map(x => x.pid)));
    for (const pid of suspended) assert.ok(recorded.has(pid), `PID ${pid} is suspended with no record`);
  }), { numRuns: 40 });
});
