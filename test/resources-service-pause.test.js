'use strict';
/**
 * app/resources-service.js (BACKLOG #19): Pause / Resume in the service main builds. The Pause is judged by Stop's guard, the state
 * lives in host/pause-state.js, and the panel's payload says which rows are paused. Everything it touches is handed in.
 */
const test = require('node:test');
const assert = require('node:assert');

const S = require('../app/resources-service');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const T0 = 134000000000000000n;
const SEC = 10000000n;

function world() {
  let c = 1000;
  const p = (pid, ppid, name, cmd, priv) => ({ pid, ppid, name, cmd, priv, start: String(c += 10) });
  return [
    p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 100),
    p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 50),
    p(22, 20, 'claude.exe', 'claude.exe', 300),
    p(23, 22, 'node.exe', 'node server.js', 400),
    p(24, 23, 'node.exe', 'node child.js', 100),
  ];
}
const sampleAt = (procs, n) => ({
  at: 0, procs,
  perf: new Map(procs.map(p => [p.pid, { cpu: 0n, ts: T0 + BigInt(n) * 10n * SEC, ws: p.priv }])),
  cpuTotal: { idle: BigInt(n) * 5n * SEC, ts: T0 + BigInt(n) * 10n * SEC }, os: { totalBytes: 1000, freeBytes: 400 },
});
const snap = (n, procs = world(), over = {}) => ({
  mode: 'full', sample: sampleAt(procs, n), prev: n > 1 ? sampleAt(procs, n - 1) : null,
  machine: { last: sampleAt(procs, n), prev: n > 1 ? sampleAt(procs, n - 1) : null }, failures: 0, lastGoodAt: 4000, stale: false, expired: false, ...over,
});

function rig({ suspend, noSuspend = false, procs = world(), now = () => 5000, pauseNote } = {}) {
  const sent = [];
  const calls = [];
  const sampled = [];
  const claims = [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: world()[1].start }];
  const svc = S.createResourcesService({
    sampler: { setWanted: () => {}, sampleNow: async () => { sampled.push(1); return procs; }, snapshot: () => null },
    tabs: () => [{ key: 'k', cwd: 'C:\\r\\dev', branch: 'main', port: 7701 }],
    claims: () => claims, installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c.split('\\').pop(),
    send: payload => sent.push(payload),
    kill: async () => [],
    ...(noSuspend ? {} : { suspend: suspend || (async (action, targets) => { calls.push([action, targets.map(t => t.pid)]); return targets.map(t => ({ pid: t.pid, status: 'done' })); }) }),
    now, pauseNote,
  });
  return { svc, sent, calls, sampled, procs };
}
const childOf = (payload, pid) => payload.model.project.rows[0].children.find(c => c.pid === pid);

test('pause: judged by the stop guard, suspends the subtree root first, and the next payload marks the row paused with the time', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  assert.strictEqual(childOf(r.sent.at(-1), 23).canPause, true);
  const res = await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  assert.deepStrictEqual(res, { ok: true, pid: 23, name: 'node.exe', since: 5000 });
  assert.deepStrictEqual(r.calls, [['suspend', [23, 24]]]);
  assert.ok(r.sampled.length >= 1, 'a fresh sample is taken so the row updates at once');
  r.svc.onUpdate(snap(3));
  const c = childOf(r.sent.at(-1), 23);
  assert.deepStrictEqual(c.paused, { since: 5000 });
  assert.strictEqual(c.canPause, false);
});

test('pause: refuses claude and a malformed request, and suspends nothing', async () => {
  const r = rig();
  assert.strictEqual((await r.svc.pause({ pid: 22, startTime: r.procs[2].start })).ok, false);
  assert.strictEqual((await r.svc.pause({ pid: '23', startTime: r.procs[3].start })).ok, false);
  assert.strictEqual((await r.svc.pause(null)).ok, false);
  assert.deepStrictEqual(r.calls, []);
});

test('pause: with no suspend wired it is refused, plainly', async () => {
  const r = rig({ noSuspend: true });
  const res = await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'unavailable');
  assert.deepStrictEqual(await r.svc.resume({ pid: 23, startTime: r.procs[3].start }), { ok: false, reason: 'unavailable', text: res.text });
});

test('resume: wakes the set, the row is no longer paused on the next payload, and a second resume is refused', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  const res = await r.svc.resume({ pid: 23, startTime: r.procs[3].start });
  assert.deepStrictEqual(res, { ok: true, pid: 23 });
  assert.deepStrictEqual(r.calls, [['suspend', [23, 24]], ['resume', [23, 24]]]);
  r.svc.onUpdate(snap(3));
  assert.strictEqual(childOf(r.sent.at(-1), 23).paused, null);
  assert.strictEqual((await r.svc.resume({ pid: 23, startTime: r.procs[3].start })).reason, 'not-paused');
});

test('a paused process that leaves the table is no longer paused (it ended while frozen, or its pid was reused)', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  const without = world().filter(p => p.pid !== 23 && p.pid !== 24);
  r.svc.onUpdate(snap(3, without));
  assert.strictEqual((await r.svc.resume({ pid: 23, startTime: r.procs[3].start })).reason, 'not-paused', 'it was reconciled away');
  const reusedWorld = world().map(p => (p.pid === 23 ? { ...p, start: p.start + '0000000' } : p));
  const r2 = rig();
  r2.svc.onUpdate(snap(2));
  await r2.svc.pause({ pid: 23, startTime: r2.procs[3].start });
  r2.svc.onUpdate(snap(3, reusedWorld));
  assert.strictEqual(childOf(r2.sent.at(-1), 23).paused, null, 'another start is another process');
});

test('an expired sample, or a machine-only one, forgets nothing: not seeing the table is not seeing the process leave', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  r.svc.onUpdate(snap(3, world().filter(p => p.pid !== 23), { expired: true }));
  r.svc.onUpdate({ mode: 'machine', sample: null, machine: { last: sampleAt(world(), 3), prev: sampleAt(world(), 2) }, failures: 0, lastGoodAt: 4000, stale: false, expired: false });
  r.svc.onUpdate(snap(4));
  assert.deepStrictEqual(childOf(r.sent.at(-1), 23).paused, { since: 5000 });
});

test('resumeAll wakes everything paused, for a quit, and answers how many', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  await r.svc.pause({ pid: 24, startTime: r.procs[4].start });
  const res = await r.svc.resumeAll();
  assert.deepStrictEqual(res, { resumed: 1, failed: 0 });
  assert.deepStrictEqual(r.calls, [['suspend', [24]], ['resume', [24]]]);
});

test('resumeAll with nothing paused, or no suspend wired, does nothing', async () => {
  assert.deepStrictEqual(await rig().svc.resumeAll(), { resumed: 0, failed: 0 });
  assert.deepStrictEqual(await rig({ noSuspend: true }).svc.resumeAll(), { resumed: 0, failed: 0 });
});

test('the payload carries the CLI-limit note the host gave, next to Pause; absent means none', () => {
  const a = rig();
  a.svc.onUpdate(snap(2));
  assert.strictEqual(a.sent.at(-1).pauseNote, null);
});

test('with no suspend wired no row offers Pause; with one wired the rows that can be paused do', () => {
  const none = rig({ noSuspend: true });
  none.svc.onUpdate(snap(2));
  assert.strictEqual(childOf(none.sent.at(-1), 23).canPause, false);
  const some = rig();
  some.svc.onUpdate(snap(2));
  assert.strictEqual(childOf(some.sent.at(-1), 23).canPause, true);
});

test('the CLI-limit note given to the service rides in every payload', () => {
  const r = rig({ pauseNote: 'the CLI kills it after 9 min' });
  r.svc.onUpdate(snap(2));
  assert.strictEqual(r.sent.at(-1).pauseNote, 'the CLI kills it after 9 min');
});

test('hasPaused: false at the start, true while something is paused, false after it is resumed', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  assert.strictEqual(r.svc.hasPaused(), false);
  await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  assert.strictEqual(r.svc.hasPaused(), true);
  await r.svc.resume({ pid: 23, startTime: r.procs[3].start });
  assert.strictEqual(r.svc.hasPaused(), false);
});

// ---- PR #158 review -------------------------------------------------------------------------------------------------

function persistFake(dead = []) {
  const saved = [];
  const released = [];
  return { saved, released, save: list => saved.push(list.map(e => [e.pid, e.pids.map(p => p.pid)])), takeDead: async () => ({ entries: dead, release: () => released.push(true) }) };
}
test('Miguel Y4: every change to the paused set is saved (the next start can undo a crash)', async () => {
  const persist = persistFake();
  const sent = [];
  const svc = S.createResourcesService({
    sampler: { setWanted: () => {}, sampleNow: async () => world(), snapshot: () => null },
    tabs: () => [{ key: 'k', cwd: 'C:' + String.fromCharCode(92) + 'r' + String.fromCharCode(92) + 'dev', branch: 'main', port: 7701 }],
    claims: () => [{ pid: 20, port: 7701, cwd: 'C:' + String.fromCharCode(92) + 'r' + String.fromCharCode(92) + 'dev', processStartedAt: world()[1].start }],
    installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c, send: p => sent.push(p), kill: async () => [], now: () => 5000,
    suspend: async (a, t) => t.map(x => ({ pid: x.pid, status: 'done' })), pausePersist: persist,
  });
  svc.onUpdate(snap(2));
  await svc.pause({ pid: 23, startTime: world()[3].start });
  assert.deepStrictEqual(persist.saved.at(-1), [[23, [23, 24]]]);
  await svc.resume({ pid: 23, startTime: world()[3].start });
  assert.deepStrictEqual(persist.saved.at(-1), [], 'resumed: the file is emptied');
});

test('Miguel Y4: at start, what a dead run left suspended is woken by its proved starts, and the file is rewritten', async () => {
  const persist = persistFake([{ pid: 23, start: '1', name: 'x', pids: [{ pid: 23, start: '1' }, { pid: 24, start: '2' }] }]);
  const calls = [];
  const svc = S.createResourcesService({
    sampler: { setWanted: () => {}, sampleNow: async () => world(), snapshot: () => null },
    tabs: () => [], claims: () => [], installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c, send: () => {}, kill: async () => [], now: () => 5000,
    suspend: async (a, t) => { calls.push([a, t.map(x => x.pid + ':' + x.start)]); return t.map(x => ({ pid: x.pid, status: 'done' })); }, pausePersist: persist,
  });
  assert.deepStrictEqual(await svc.wakeLeftover(), { stuck: 0 });
  assert.deepStrictEqual(calls, [['resume', ['23:1', '24:2']]]);
  assert.deepStrictEqual(persist.saved[0], [[23, [23, 24]]], 'recorded in THIS run first (R2-7)');
  assert.deepStrictEqual(persist.saved.at(-1), [], 'and removed once the wake was confirmed');
  assert.deepStrictEqual(persist.released, [true], 'only then do the old files go');
});

test('R2-7: a wake that cannot complete leaves the old file recorded under this run', async () => {
  const persist = persistFake([{ pid: 23, start: '1', name: 'x', pids: [{ pid: 23, start: '1' }] }]);
  const svc = S.createResourcesService({
    sampler: { setWanted: () => {}, sampleNow: async () => world(), snapshot: () => null },
    tabs: () => [], claims: () => [], installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c, send: () => {}, kill: async () => [], now: () => 5000,
    suspend: async () => { throw new Error('boom'); }, pausePersist: persist,
  });
  const res = await svc.wakeLeftover();
  assert.deepStrictEqual(res, { stuck: 1 }, 'recorded as stuck under this run name');
  assert.deepStrictEqual(persist.saved.at(-1), [[23, [23]]]);
});

test('wakeLeftover with no persistence or no suspend wired does nothing', async () => {
  assert.deepStrictEqual(await rig().svc.wakeLeftover(), { stuck: 0 });
  assert.deepStrictEqual(await rig({ noSuspend: true }).svc.wakeLeftover(), { stuck: 0 });
});

test('Dexter 6: a paused root that leaves the table while its child stays is NOT forgotten: the child is woken by its proved start', async () => {
  const r = rig();
  r.svc.onUpdate(snap(2));
  await r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  r.calls.length = 0;
  r.svc.onUpdate(snap(3, world().filter(p => p.pid !== 23)));
  await new Promise(res => setImmediate(res));
  assert.deepStrictEqual(r.calls, [['resume', [24]]]);
  assert.strictEqual(r.svc.hasPaused(), false);
});

test('Dexter 7: hasPaused is true while a pause is still being made (a quit then waits for it)', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const r = rig({ suspend: async (a, t) => { await gate; return t.map(x => ({ pid: x.pid, status: 'done' })); } });
  r.svc.onUpdate(snap(2));
  const p = r.svc.pause({ pid: 23, startTime: r.procs[3].start });
  await new Promise(res => setImmediate(res));
  assert.strictEqual(r.svc.hasPaused(), true);
  release();
  await p;
});
