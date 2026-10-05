'use strict';
/**
 * host/resource-sampler.js (BACKLOG #63): the OS shell around the pure sample. One sample in flight at most, a 10 s
 * cadence that is a gap between samples (never a fixed rate that could pile up), the last good figures kept
 * through a failure, and three failures turning them into "—". Fake exec and fake timers; one real CIM call on
 * Windows at the end, because the script is the one thing a fake cannot check.
 */
const test = require('node:test');
const assert = require('node:assert');

const R = require('../host/resource-sampler');
const { parseSample } = require('../host/resource-sample');

const T0 = 134356416231909701n;
const text = (n, { procs = [] } = {}) => JSON.stringify({
  procs, perf: procs.map(p => ({ pid: p.pid, cpu: String(n * 1000), ts: String(T0 + BigInt(n) * 100000000n) })),
  cpu: { idle: String(n * 50000000), ts: String(T0 + BigInt(n) * 100000000n) }, os: { totalKb: 1000, freeKb: 400 },
}) + '\nEND';
const P = [{ pid: 4, ppid: 0, name: 'System', cmd: null, start: '5', priv: 10 }];

function fakeTimers() {
  const list = [];
  let id = 0;
  return {
    setTimer: (fn, ms) => { const t = { id: ++id, fn, ms, live: true }; list.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    live: () => list.filter(t => t.live),
    fire: () => { const t = list.filter(x => x.live).pop(); if (!t) throw new Error('no live timer'); t.live = false; t.fn(); },
  };
}
const settle = () => new Promise(r => setImmediate(r));
const until = async (f) => { for (let i = 0; i < 50 && !f(); i++) await settle(); assert.ok(f(), 'condition never became true'); };

function rig(script = []) {
  const timers = fakeTimers();
  const calls = [];
  const updates = [];
  let at = 1000;
  const sampler = R.createSampler({
    exec: (s) => { calls.push(s); const next = script.shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); },
    cores: 4, now: () => (at += 10), setTimer: timers.setTimer, clearTimer: timers.clearTimer, intervalMs: 10000,
    onUpdate: (s) => updates.push(s),
  });
  return { sampler, timers, calls, updates };
}

test('policy: the panel shown samples the process tree, the chip alone samples the machine, neither samples nothing', () => {
  assert.strictEqual(R.policy({ panel: true, chip: true }), 'full');
  assert.strictEqual(R.policy({ panel: true, chip: false }), 'full');
  assert.strictEqual(R.policy({ panel: false, chip: true }), 'machine');
  assert.strictEqual(R.policy({ panel: false, chip: false }), null);
  assert.strictEqual(R.policy(null), null);
});

test('the scripts: the full one reads the process table and the counters, the machine one reads neither', () => {
  assert.match(R.scriptFor('full'), /Win32_Process/);
  assert.match(R.scriptFor('full'), /Win32_PerfRawData_PerfProc_Process/);
  assert.match(R.scriptFor('machine'), /Win32_PerfRawData_PerfOS_Processor/);
  assert.match(R.scriptFor('machine'), /Win32_OperatingSystem/);
  assert.doesNotMatch(R.scriptFor('machine'), /Win32_Process|PerfProc_Process/);
  for (const m of ['full', 'machine']) assert.match(R.scriptFor(m), /'END'\s*$/);
  assert.throws(() => R.scriptFor('nope'));
});

test('a full sample is taken at once when the panel is wanted, and the next one 10 s after it ends', async () => {
  const { sampler, timers, calls, updates } = rig([text(1, { procs: P }), text(2, { procs: P })]);
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await until(() => updates.length === 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(updates[0].mode, 'full');
  assert.strictEqual(updates[0].prev, null, 'the first sample has nothing before it');
  assert.strictEqual(timers.live().length, 1);
  assert.strictEqual(timers.live()[0].ms, 10000);
  timers.fire();
  await until(() => updates.length === 2);
  assert.ok(updates[1].prev, 'the second sample sees the first');
  assert.strictEqual(updates[1].prev.perf.size, 1);
});

test('one sample in flight at most: a wake while one runs does not start another', async () => {
  let release;
  const timers = fakeTimers();
  const calls = [];
  const sampler = R.createSampler({
    exec: (s) => { calls.push(s); return new Promise(r => { release = () => r(text(calls.length, { procs: P })); }); },
    cores: 4, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  sampler.start();
  sampler.setWanted({ panel: true, chip: false });
  sampler.setWanted({ panel: true, chip: true });
  sampler.setWanted({ panel: false, chip: true });
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  assert.strictEqual(calls.length, 1);
  release();
  await settle(); await settle();
  assert.strictEqual(timers.live().length, 1);
  assert.strictEqual(timers.live()[0].ms, 0, 'the wake that came during the run is served at once after it, not on the 10 s gap');
  timers.fire();
  await settle();
  assert.strictEqual(calls.length, 2, 'and as one sample, not stacked');
  release();
});

test('the chip alone takes machine-only samples; the process tree is never read', async () => {
  const { sampler, calls, updates } = rig([text(1), text(2)]);
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await until(() => updates.length === 1);
  assert.doesNotMatch(calls[0], /Win32_Process/);
  assert.strictEqual(updates[0].mode, 'machine');
  assert.ok(updates[0].machine.last.cpuTotal);
});

test('nothing wanted: no sample, no timer', async () => {
  const { sampler, timers, calls } = rig([text(1)]);
  sampler.start();
  sampler.setWanted({ panel: false, chip: false });
  await settle();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(timers.live().length, 0);
});

test('hiding the panel stops the process-tree samples and forgets them, so showing it again starts at "measuring…"', async () => {
  const { sampler, timers, updates } = rig([text(1, { procs: P }), text(2), text(3, { procs: P })]);
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await until(() => updates.length === 1);
  sampler.setWanted({ panel: false, chip: true });
  await until(() => updates.length === 2);
  assert.strictEqual(updates[1].mode, 'machine');
  assert.strictEqual(updates[1].sample, null, 'no process tree is kept while it is hidden');
  sampler.setWanted({ panel: true, chip: true });
  await until(() => updates.length === 3);
  assert.strictEqual(updates[2].prev, null);
  assert.ok(timers.live().length <= 1);
});

test('a failed sample keeps the last good figures and counts; three failures expire them; a good one resets', async () => {
  const { sampler, timers, updates } = rig([text(1, { procs: P }), new Error('timeout'), 'garbage', new Error('x'), text(5, { procs: P })]);
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await until(() => updates.length === 1);
  const good = updates[0];
  assert.strictEqual(good.failures, 0);
  assert.strictEqual(good.stale, false);
  for (let i = 2; i <= 4; i++) { timers.fire(); await until(() => updates.length === i); }
  assert.deepStrictEqual(updates.slice(1).map(u => [u.failures, u.stale, u.expired]), [[1, true, false], [2, true, false], [3, true, true]]);
  assert.strictEqual(updates[3].sample, good.sample, 'the last good sample is still there');
  assert.strictEqual(updates[3].lastGoodAt, good.lastGoodAt);
  timers.fire();
  await until(() => updates.length === 5);
  assert.deepStrictEqual([updates[4].failures, updates[4].stale, updates[4].expired], [0, false, false]);
});

test('sampleNow waits for a run in flight, then takes a fresh full sample and returns its process table', async () => {
  let resolveFirst;
  const calls = [];
  const timers = fakeTimers();
  const sampler = R.createSampler({
    exec: (s) => { calls.push(s); return calls.length === 1 ? new Promise(r => { resolveFirst = () => r(text(1, { procs: P })); }) : Promise.resolve(text(2, { procs: [{ ...P[0], pid: 77 }] })); },
    cores: 4, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  const asked = sampler.sampleNow();
  await settle();
  assert.strictEqual(calls.length, 1, 'it does not start beside the run in flight');
  resolveFirst();
  const procs = await asked;
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(procs.map(p => p.pid), [77]);
});

test('sampleNow answers null when the sample fails', async () => {
  const { sampler } = rig([new Error('boom')]);
  assert.strictEqual(await sampler.sampleNow(), null);
});

test('stop clears the timer and nothing more is sampled', async () => {
  const { sampler, timers, calls, updates } = rig([text(1, { procs: P }), text(2, { procs: P })]);
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await until(() => updates.length === 1);
  sampler.stop();
  assert.strictEqual(timers.live().length, 0);
  assert.strictEqual(calls.length, 1);
});

test('the real script, run once on this machine: it parses, has this process in it, and finishes inside the budget', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const exec = R.createExec(30000);
  const t0 = Date.now();
  const s = parseSample(await exec(R.scriptFor('full')), 1);
  const took = Date.now() - t0;
  assert.ok(s, 'the sample did not parse');
  assert.ok(s.procs.length > 20);
  const me = s.procs.find(p => p.pid === process.pid);
  assert.ok(me, 'this process is not in the table');
  assert.match(me.start, /^\d{17,19}$/, 'a FILETIME start');
  assert.ok(typeof s.perf.get(process.pid).ws === 'number' && s.perf.get(process.pid).ws > 0, 'its private working set is there');
  assert.ok(s.perf.has(process.pid), 'its CPU counter is there');
  assert.ok(s.cpuTotal && s.os && s.os.totalBytes > 0);
  const m = parseSample(await exec(R.scriptFor('machine')), 2);
  assert.ok(m && m.cpuTotal && m.os);
  assert.strictEqual(m.procs.length, 0);
  console.log(`# real CIM sample: ${took} ms, ${s.procs.length} processes`);
});

// ---- PR #113 review round 1 (Dexter 6 and 7, Miguel S4) ----

function manual() {
  const timers = fakeTimers();
  const pending = [];
  const updates = [];
  let killed = 0;
  const sampler = R.createSampler({
    exec: (s) => { const p = new Promise(r => pending.push({ s, resolve: r })); p.kill = () => { killed++; }; return p; },
    cores: 4, setTimer: timers.setTimer, clearTimer: timers.clearTimer, onUpdate: u => updates.push(u),
  });
  return { sampler, timers, pending, updates, killed: () => killed };
}

test('D6: hiding the panel while a full sample is in flight drops it, so showing it again starts at "measuring…"', async () => {
  const { sampler, pending, updates } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  assert.strictEqual(pending.length, 1);
  sampler.setWanted({ panel: false, chip: true });          // hidden mid-sample
  pending[0].resolve(text(1, { procs: P }));
  await settle(); await settle();
  assert.ok(updates.every(u => u.sample === null), 'the dropped sample did not come back as `last`');
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  const next = pending.at(-1);
  next.resolve(text(9, { procs: P }));
  await settle(); await settle();
  assert.strictEqual(updates.at(-1).prev, null, 'the first sample after re-showing has nothing before it');
  assert.ok(updates.at(-1).sample);
});

test('D7: a pause (nothing wanted) forgets the machine pair, so the first sample after it has no delta', async () => {
  const { sampler, pending, updates } = manual();
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  pending.at(-1).resolve(text(1));
  await settle(); await settle();
  sampler.setWanted({ panel: false, chip: false });          // minimised
  sampler.setWanted({ panel: false, chip: true });           // restored
  await settle();
  pending.at(-1).resolve(text(50));
  await settle(); await settle();
  const u = updates.at(-1);
  assert.strictEqual(u.machine.prev, null, 'no 2-hour average dressed up as "now"');
  assert.ok(u.machine.last);
});

test('a sample that finishes after stop() is dropped without an update or a failure count', async () => {
  const { sampler, pending, updates } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  sampler.stop();
  pending[0].resolve(text(1, { procs: P }));
  await settle(); await settle();
  assert.strictEqual(updates.length, 0);
});

test('S4: stop() ends the powershell that is running, by its own handle', async () => {
  const { sampler, pending, killed } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  assert.strictEqual(killed(), 0);
  sampler.stop();
  assert.strictEqual(killed(), 1);
  pending[0].resolve('');
});

test('sampleNow answers null when its own sample was dropped, never the older one', async () => {
  const { sampler, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  pending[0].resolve(text(1, { procs: P }));
  await settle(); await settle();
  const asked = sampler.sampleNow();
  await settle();
  sampler.setWanted({ panel: false, chip: true });
  pending.at(-1).resolve(text(2, { procs: P }));
  assert.strictEqual(await asked, null);
});
