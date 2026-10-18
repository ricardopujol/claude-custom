'use strict';
/**
 * host/shared-sampler.js (BACKLOG #100 c): the resource sampler's own interface (start, stop, setWanted, sampleNow, snapshot,
 * onUpdate) over the shared poller, and createSampler's new `fetch` seam it rides on. A fake poller; no files, no PowerShell.
 */
const test = require('node:test');
const assert = require('node:assert');

const R = require('../host/resource-sampler');
const SS = require('../host/shared-sampler');

const T0 = 134356416231909701n;
const doc = (n) => JSON.stringify({
  procs: [{ pid: 4, ppid: 0, name: 'System', cmd: null, start: '5' }], perf: [{ pid: 4, cpu: String(n * 1000), ts: String(T0 + BigInt(n) * 100000000n) }],
  cpu: { idle: String(n * 50000000), ts: String(T0 + BigInt(n) * 100000000n) }, os: { totalKb: 1000, freeKb: 400 },
}) + '\nEND';
const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 4)); } };

function fakePoller() {
  const calls = { next: [], sampleNow: 0, levels: [], started: 0, stopped: 0, cancelled: 0 };
  let pending = [];
  let n = 0;
  const poller = {
    start() { calls.started++; return Promise.resolve(); },
    stop() { calls.stopped++; },
    setLevel(l) { calls.levels.push(l); },
    cancelWaiters() { calls.cancelled++; for (const w of pending.splice(0)) w.reject(new Error('cancelled')); },
    next(opts) {
      calls.next.push(opts);
      let w;
      const p = new Promise((resolve, reject) => { w = { resolve, reject }; pending.push(w); });
      p.kill = () => { const i = pending.indexOf(w); if (i >= 0) pending.splice(i, 1); w.reject(new Error('cancelled')); };
      return p;
    },
    sampleNow() { calls.sampleNow++; n++; return Promise.resolve({ text: doc(100 + n), at: 5000 + n, mode: 'full' }); },
    // test control: deliver the next record to whoever waits
    deliver(rec) { for (const w of pending.splice(0)) w.resolve(rec); },
    pendingCount: () => pending.length,
  };
  return { poller, calls };
}
const rec = (seq, over = {}) => ({ key: `1:${seq}:${seq}`, seq, at: 1000 * seq, mode: 'full', ok: true, text: doc(seq), error: null, ...over });

test('createSampler fetch seam: the sample is parsed from the fetched text with the fetched time, not the clock at parse time', async () => {
  const updates = [];
  const s = R.createSampler({
    fetch: () => Promise.resolve({ text: doc(1), at: 4242, mode: 'full' }), intervalMs: 1000000, cores: 4, now: () => 9999,
    onUpdate: (u) => updates.push(u), setTimer: () => ({}), clearTimer: () => {},
  });
  s.setWanted({ panel: true, chip: true });
  s.start();
  await settle();
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].sample.at, 4242);
  assert.strictEqual(updates[0].lastGoodAt, 4242);
});

test('createSampler fetch seam: a rejected fetch is a failed sample, counted like any other', async () => {
  const updates = [];
  const s = R.createSampler({
    fetch: () => Promise.reject(new Error('no sample')), intervalMs: 1000000, cores: 4, onUpdate: (u) => updates.push(u), setTimer: () => ({}), clearTimer: () => {},
  });
  s.setWanted({ panel: true, chip: true });
  s.start();
  await settle();
  assert.strictEqual(updates[0].failures, 1);
  assert.strictEqual(updates[0].sample, null);
});

test('the shared sampler hands the level of what is wanted to the poller: nothing wanted is hidden, the chip alone is chip, the panel in view is panel', () => {
  const { poller, calls } = fakePoller();
  const s = SS.createSharedSampler({ poller, cores: 4 });
  s.setWanted({ panel: false, chip: false });
  s.setWanted({ panel: true, chip: true });
  s.setWanted({ panel: true, chip: true, viewing: true });
  s.setWanted({ panel: false, chip: false, viewing: true });
  assert.deepStrictEqual(calls.levels, ['hidden', 'chip', 'panel', 'hidden']);
});

test('start() and stop() join and leave the pool', () => {
  const { poller, calls } = fakePoller();
  const s = SS.createSharedSampler({ poller, cores: 4 });
  s.start();
  s.stop();
  assert.strictEqual(calls.started, 1);
  assert.strictEqual(calls.stopped, 1);
});

test('each published record becomes one update, in order, and no record is taken twice', async () => {
  const { poller, calls } = fakePoller();
  const updates = [];
  const s = SS.createSharedSampler({ poller, cores: 4, onUpdate: (u) => updates.push(u), setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: clearTimeout });
  s.setWanted({ panel: true, chip: true, viewing: true });
  s.start();
  await settle();
  assert.strictEqual(poller.pendingCount(), 1, 'waiting for the first record');
  assert.strictEqual(calls.next[0].after, null);
  poller.deliver(rec(1));
  await settle();
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(calls.next[1].after, '1:1:1', 'the next wait names the record already taken');
  poller.deliver(rec(2));
  await settle();
  assert.strictEqual(updates.length, 2);
  assert.ok(updates[1].prev, 'two records make a delta');
  s.stop();
});

test('the wait is as long as the level\'s interval allows, and a record older than twice it is not served as new', async () => {
  const { poller, calls } = fakePoller();
  const s = SS.createSharedSampler({ poller, cores: 4, setTimer: () => ({}), clearTimer: () => {} });
  s.setWanted({ panel: true, chip: true, viewing: true });
  s.start();
  await settle();
  assert.strictEqual(calls.next[0].maxAgeMs, 20000);
  assert.ok(calls.next[0].timeoutMs > 20000);
  s.stop();
  const b = fakePoller();
  const s2 = SS.createSharedSampler({ poller: b.poller, cores: 4, setTimer: () => ({}), clearTimer: () => {} });
  s2.setWanted({ panel: true, chip: true });
  s2.start();
  await settle();
  assert.strictEqual(b.calls.next[0].maxAgeMs, 60000, 'chip level: 30 s steps');
  s2.stop();
});

test('a failed record from the owner is a failed sample here too (and is consumed once)', async () => {
  const { poller, calls } = fakePoller();
  const updates = [];
  const s = SS.createSharedSampler({ poller, cores: 4, onUpdate: (u) => updates.push(u), setTimer: (fn) => setTimeout(fn, 0), clearTimer: clearTimeout });
  s.setWanted({ panel: true, chip: true });
  s.start();
  await settle();
  poller.deliver(rec(1, { ok: false, text: null, error: 'timed out' }));
  await settle();
  assert.strictEqual(updates[0].failures, 1);
  assert.strictEqual(calls.next[1].after, '1:1:1');
  s.stop();
});

test('going hidden cancels the wait; the next show asks again from where it left off', async () => {
  const { poller, calls } = fakePoller();
  const s = SS.createSharedSampler({ poller, cores: 4, setTimer: (fn) => setTimeout(fn, 0), clearTimer: clearTimeout });
  s.setWanted({ panel: true, chip: true });
  s.start();
  await settle();
  s.setWanted({ panel: false, chip: false });
  await settle();
  assert.strictEqual(calls.cancelled >= 1, true);
  assert.strictEqual(poller.pendingCount(), 0);
  s.setWanted({ panel: true, chip: true });
  await settle();
  assert.strictEqual(poller.pendingCount(), 1);
  s.stop();
});

test('sampleNow is the poller\'s off-cadence sample, marked adhoc, and returns the process list', async () => {
  const { poller, calls } = fakePoller();
  const updates = [];
  const s = SS.createSharedSampler({ poller, cores: 4, onUpdate: (u) => updates.push(u), setTimer: () => ({}), clearTimer: () => {} });
  s.setWanted({ panel: true, chip: true });
  s.start();
  await settle();
  poller.deliver(rec(1));
  await settle();
  const procs = await s.sampleNow();
  assert.strictEqual(calls.sampleNow, 1);
  assert.ok(Array.isArray(procs) && procs.length === 1);
  assert.strictEqual(updates[updates.length - 1].adhoc, true);
  s.stop();
});

test('the machine-only sampling path of the shared poller is never taken: every cadence row is the full sample', () => {
  const policy = require('../host/poller-policy');
  for (const level of ['panel', 'chip']) assert.strictEqual(policy.cadenceOf(level).mode, 'full');
});
