'use strict';
/**
 * Kill tests for host/resource-sampler.js createSampler (BACKLOG #70, Mortimer's release-#117 survivor 8): the stop and
 * clear-timer bookkeeping, a sample that ends after what it was for changed, a throwing listener. Fake exec, fake timers.
 */
const test = require('node:test');
const assert = require('node:assert');

const R = require('../host/resource-sampler');

const T0 = 134356416231909701n;
const text = (n, { procs = [] } = {}) => JSON.stringify({
  procs, perf: procs.map(p => ({ pid: p.pid, cpu: String(n * 1000), ts: String(T0 + BigInt(n) * 100000000n) })),
  cpu: { idle: String(n * 50000000), ts: String(T0 + BigInt(n) * 100000000n) }, os: { totalKb: 1000, freeKb: 400 },
}) + '\nEND';
const P = [{ pid: 4, ppid: 0, name: 'System', cmd: null, start: '5', priv: 10 }];
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function fakeTimers() {
  const list = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; list.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    live: () => list.filter(t => t.live),
    fire: () => { const t = list.filter(x => x.live).pop(); t.live = false; t.fn(); },
  };
}

// Every exec is held until the test resolves (or rejects) it; `withKill: false` gives a promise with no kill().
function manual({ withKill = true, onUpdate } = {}) {
  const timers = fakeTimers();
  const pending = [];
  const updates = [];
  const logs = [];
  let killed = 0;
  const sampler = R.createSampler({
    exec: (s) => {
      let resolve; let reject;
      const p = new Promise((a, b) => { resolve = a; reject = b; });
      if (withKill) p.kill = () => { killed++; };
      pending.push({ s, resolve, reject });
      return p;
    },
    cores: 4, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onUpdate: onUpdate || (u => updates.push(u)), log: (...a) => logs.push(a.join(' ')),
  });
  return { sampler, timers, pending, updates, logs, killed: () => killed };
}

test('kills: a listener that throws is logged once with its stack, and sampling goes on', async () => {
  let calls = 0;
  const boom = new Error('listener boom');
  const { sampler, timers, pending, logs } = manual({ onUpdate: () => { calls++; throw boom; } });
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  pending[0].resolve(text(1));
  await settle();
  assert.strictEqual(calls, 1);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /update listener threw/);
  assert.strictEqual(logs[0], `[resources] update listener threw: ${boom.stack}`, 'the stack, not just the message');
  assert.strictEqual(timers.live().length, 1, 'the next sample is still scheduled');
  timers.fire();
  await settle();
  assert.strictEqual(pending.length, 2, 'and it is taken');
});

test('kills: a non-Error thrown by the listener is logged as itself', async () => {
  const { sampler, pending, logs } = manual({ onUpdate: () => { throw 'plain text'; } });  // eslint-disable-line no-throw-literal
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  pending[0].resolve(text(1));
  await settle();
  assert.deepStrictEqual(logs, ['[resources] update listener threw: plain text']);
});

test('kills: a sample that FAILS after stop() is dropped: no update, no failure counted', async () => {
  const { sampler, pending, updates } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  sampler.stop();
  pending[0].reject(new Error('killed by stop'));
  await settle();
  assert.strictEqual(updates.length, 0);
  assert.strictEqual(sampler.snapshot().failures, 0);
});

test('kills: a sample that fails after nothing is wanted any more is dropped, though the sampler is still started', async () => {
  const { sampler, pending, updates } = manual();
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  sampler.setWanted({ panel: false, chip: false });
  pending[0].reject(new Error('late'));
  await settle();
  assert.strictEqual(updates.length, 0);
  assert.strictEqual(sampler.snapshot().failures, 0);
});

test('kills: a machine sample that lands after the panel was opened is not kept as the process sample', async () => {
  const { sampler, pending, updates } = manual();
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  sampler.setWanted({ panel: true, chip: true });          // opened while the machine-only sample runs
  pending[0].resolve(text(1));
  await settle();
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].sample, null, 'a machine sample has no process table to show');
  assert.ok(updates[0].machine.last, 'it still counts for the machine figures');
});

test('kills: switching the panel off forgets the process samples at once, before the next sample', async () => {
  const { sampler, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  pending[0].resolve(text(1, { procs: P }));
  await settle();
  assert.ok(sampler.snapshot().sample);
  sampler.setWanted({ panel: false, chip: true });
  assert.strictEqual(sampler.snapshot().sample, null);
  assert.strictEqual(sampler.snapshot().prev, null);
  assert.ok(sampler.snapshot().machine.last, 'the machine pair is kept while the chip is still on');
  sampler.setWanted({ panel: false, chip: false });
  assert.strictEqual(sampler.snapshot().machine.last, null, '... and forgotten when nothing is wanted');
});

test('kills: wanting nothing clears the pending timer, so no stray timer is left live', async () => {
  const { sampler, timers, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  pending[0].resolve(text(1));
  await settle();
  assert.strictEqual(timers.live().length, 1);
  sampler.setWanted({ panel: false, chip: false });
  assert.strictEqual(timers.live().length, 0);
});

test('kills: a change of what is wanted replaces the pending timer with a sample now, leaving one timer, not two', async () => {
  const { sampler, timers, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: false, chip: true });
  await settle();
  pending[0].resolve(text(1));
  await settle();
  assert.strictEqual(timers.live().length, 1);
  sampler.setWanted({ panel: true, chip: true });
  assert.strictEqual(timers.live().length, 0, 'the 10 s timer is cleared, the sample is taken now');
  assert.strictEqual(pending.length, 2);
  pending[1].resolve(text(2, { procs: P }));
  await settle();
  assert.strictEqual(timers.live().length, 1);
});

test('kills: setting the same policy again with a timer pending neither samples nor touches the timer', async () => {
  const { sampler, timers, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  pending[0].resolve(text(1, { procs: P }));
  await settle();
  const [t] = timers.live();
  sampler.setWanted({ panel: true, chip: false });         // still 'full'
  assert.strictEqual(pending.length, 1);
  assert.deepStrictEqual(timers.live(), [t]);
});

test('kills: stop() with nothing in flight, or with an exec that has no kill(), does not throw', async () => {
  const idle = manual();
  assert.doesNotThrow(() => idle.sampler.stop());
  idle.sampler.start();
  idle.sampler.setWanted({ panel: false, chip: true });
  await settle();
  idle.pending[0].resolve(text(1));
  await settle();
  assert.doesNotThrow(() => idle.sampler.stop());
  assert.strictEqual(idle.killed(), 0, 'nothing was in flight to end');
  const bare = manual({ withKill: false });
  bare.sampler.start();
  bare.sampler.setWanted({ panel: true, chip: true });
  await settle();
  assert.doesNotThrow(() => bare.sampler.stop());
  bare.pending[0].resolve('');
});

test('kills: sampleNow answers null when its own sample fails, never the older good one', async () => {
  const { sampler, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  pending[0].resolve(text(1, { procs: P }));
  await settle();
  assert.ok(sampler.snapshot().sample);
  const asked = sampler.sampleNow();
  await settle();
  pending.at(-1).reject(new Error('timeout'));
  assert.strictEqual(await asked, null);
});

test('kills: sampleNow answers null when stop() drops its own sample, though the older good one is still held', async () => {
  const { sampler, pending } = manual();
  sampler.start();
  sampler.setWanted({ panel: true, chip: true });
  await settle();
  pending[0].resolve(text(1, { procs: P }));
  await settle();
  const asked = sampler.sampleNow();
  await settle();
  sampler.stop();
  pending.at(-1).resolve(text(2, { procs: [{ ...P[0], pid: 77 }] }));
  assert.strictEqual(await asked, null);
  assert.ok(sampler.snapshot().sample, 'the older sample is still there (so only the comparison says "not mine")');
});
