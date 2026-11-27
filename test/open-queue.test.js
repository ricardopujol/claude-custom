'use strict';
/**
 * app/open-queue.js (single-instance PR 3 step 5): the opens main runs (a handed-off launch, the tray, the ▾ menu, the probe driver, a restore)
 * go one at a time, in arrival order. A stuck start must not block every later launch: its slot is freed after boundMs (plan risk 5).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const load = () => require('../app/open-queue');

test('opens run one at a time, in arrival order', async () => {
  const log = [];
  let running = 0;
  const q = load().createOpenQueue({
    open: async (job) => { running++; assert.strictEqual(running, 1, 'never two at once'); log.push(`start ${job}`); await new Promise((r) => setTimeout(r, 10)); log.push(`end ${job}`); running--; return job; },
  });
  const rs = await Promise.all(['a', 'b', 'c'].map((j) => q.push(j)));
  assert.deepStrictEqual(rs, ['a', 'b', 'c']);
  assert.deepStrictEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('an open that never settles frees its slot after boundMs and the next runs; the stuck one is said once in the log', async () => {
  const lines = [];
  const started = [];
  const q = load().createOpenQueue({
    open: (job) => { started.push(job); return job === 'stuck' ? new Promise(() => {}) : Promise.resolve(job); },
    boundMs: 50, log: (l) => lines.push(l),
  });
  const stuck = q.push('stuck');
  const next = await q.push('next');
  assert.strictEqual(next, 'next');
  assert.deepStrictEqual(started, ['stuck', 'next']);
  assert.deepStrictEqual(await stuck, { ok: false, error: 'timed out' }, 'the stuck push settles too');
  assert.strictEqual(lines.filter((l) => /did not settle within 50 ms/.test(l)).length, 1);
});

test('a throw does not stop the queue: that push resolves { ok: false, error }, the next runs', async () => {
  const q = load().createOpenQueue({ open: async (job) => { if (job === 'bad') throw new Error('boom'); return job; }, log: () => {} });
  const bad = q.push('bad');
  const good = q.push('good');
  assert.deepStrictEqual(await bad, { ok: false, error: 'boom' });
  assert.strictEqual(await good, 'good');
});

test('busy() says whether an open is running or waiting (main\'s quitIfEmpty asks it)', async () => {
  let release;
  const q = load().createOpenQueue({ open: () => new Promise((r) => { release = r; }) });
  assert.strictEqual(q.busy(), false);
  const p = q.push('a');
  assert.strictEqual(q.busy(), true);
  await new Promise((r) => setImmediate(r));
  release('a');
  await p;
  assert.strictEqual(q.busy(), false);
});

test('P-Q1: opens never overlap inside the bound, run in arrival order, and every push settles', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ ms: fc.integer({ min: 0, max: 8 }), kind: fc.constantFrom('ok', 'throw', 'ok', 'hang') }), { maxLength: 8 }),
    async (jobs) => {
      const order = [];
      let running = 0;
      let overlap = false;
      const q = load().createOpenQueue({
        boundMs: 30, log: () => {},
        open: (i) => {
          if (running > 0) overlap = true;
          running++;
          order.push(i);
          const j = jobs[i];
          if (j.kind === 'hang') return new Promise(() => {});      // never settles: its slot is freed by the bound (running stays counted: it is stuck)
          return new Promise((res, rej) => setTimeout(() => { running--; j.kind === 'throw' ? rej(new Error('x')) : res(i); }, j.ms));
        },
      });
      const hangs = () => jobs.slice(0, order.length).filter((j) => j.kind === 'hang').length;
      const rs = await Promise.all(jobs.map((_, i) => q.push(i).then((r) => { running -= 0; return r; })));
      assert.strictEqual(rs.length, jobs.length, 'every push settled');
      assert.deepStrictEqual(order, jobs.map((_, i) => i), 'arrival order');
      if (hangs() === 0) assert.strictEqual(overlap, false, 'no overlap unless a stuck open was let go by the bound');
    }), { numRuns: 40 });
});

test('PR #258 Dexter 7: onIdle(fn) runs fn once the last open settled (at once, on the next tick, when nothing is opening)', async () => {
  let release;
  const q = load().createOpenQueue({ open: () => new Promise((r) => { release = r; }) });
  const seen = [];
  const p = q.push('a');
  q.onIdle(() => seen.push('idle-1'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [], 'still opening');
  release('a');
  await p;
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, ['idle-1']);
  q.onIdle(() => seen.push('idle-2'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, ['idle-1', 'idle-2']);
});
