'use strict';
/**
 * Coalescing a read that is triggered by events, without losing the last event.
 *
 * THE DEFECT THIS EXISTS FOR. Vera (display-integrity-auditor) 2026-09-14, and
 * Miguel independently: `refreshAgentStats` coalesced with
 *
 *     if (agentStatsPending) return agentStatsPending;
 *
 * which is correct for DEDUPLICATING concurrent reads and wrong for the
 * CORRECTNESS of the last one. A read that started before an event cannot
 * reflect that event. Concretely: two agents finish 50ms apart, the second
 * `SubagentStop` is handed the in-flight promise that began before that agent
 * had finished writing, both callers broadcast the same stale snapshot, and
 * because nothing else re-reads, the second agent's run is missing from the
 * panel indefinitely.
 *
 * This project's own CLAUDE.md mandates running two reviewers in parallel on
 * every merge, so two agents finishing seconds apart is the NORMAL case here,
 * not an edge case.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createCoalescer } = require('../host/coalesce');

// A controllable async function: each call returns a promise the test resolves
// by hand, so the interleaving is exact rather than timing-dependent.
function controllable() {
  const calls = [];
  const fn = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ resolve, reject, promise });
    return promise;
  };
  return { fn, calls };
}

test('a single call runs once and returns its result', async () => {
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);
  const p = c();
  calls[0].resolve('first');
  assert.strictEqual(await p, 'first');
  assert.strictEqual(calls.length, 1);
});

test('a request made WHILE one is in flight triggers a SECOND run afterwards', async () => {
  // The whole point. The in-flight read began before this request's event, so
  // it cannot be the answer to it.
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);

  const first = c();
  const second = c();              // arrives mid-flight
  assert.strictEqual(calls.length, 1, 'still only one read running');

  calls[0].resolve('stale');
  await first;
  // The coalescer must now start a fresh read rather than hand back 'stale'.
  await Promise.resolve();
  assert.strictEqual(calls.length, 2, 'a second read must be issued');

  calls[1].resolve('fresh');
  assert.strictEqual(await second, 'fresh', 'the late caller gets the FRESH result');
});

test('several requests during one flight collapse into exactly ONE re-run', async () => {
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);

  const first = c();
  const a = c();
  const b = c();
  const d = c();
  calls[0].resolve('one');
  await first;
  await Promise.resolve();

  assert.strictEqual(calls.length, 2, 'three mid-flight requests, one re-run');
  calls[1].resolve('two');
  assert.deepStrictEqual(await Promise.all([a, b, d]), ['two', 'two', 'two']);
});

test('a request made AFTER settling starts a fresh read, not a re-run', async () => {
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);
  const first = c();
  calls[0].resolve(1);
  await first;

  const later = c();
  assert.strictEqual(calls.length, 2);
  calls[1].resolve(2);
  assert.strictEqual(await later, 2);
});

test('a rejection does not wedge the coalescer', async () => {
  // If a failed read left `pending` set, every later request would be handed a
  // dead promise and the panel would freeze for the life of the host.
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);

  const first = c();
  calls[0].reject(new Error('disk on fire'));
  await assert.rejects(() => first);

  const after = c();
  assert.strictEqual(calls.length, 2, 'the next request still runs');
  calls[1].resolve('recovered');
  assert.strictEqual(await after, 'recovered');
});

test('a rejection DURING a flight still triggers the queued re-run', async () => {
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);

  const first = c();
  const queued = c();
  calls[0].reject(new Error('transient'));
  await assert.rejects(() => first);
  await Promise.resolve();

  assert.strictEqual(calls.length, 2, 'the queued request is not lost with the failure');
  calls[1].resolve('ok');
  assert.strictEqual(await queued, 'ok');
});

test('the re-run is not started before the first settles', async () => {
  // Two concurrent reads of the same transcripts would race each other and
  // double the disk cost this coalescer exists to avoid.
  const { fn, calls } = controllable();
  const c = createCoalescer(fn);
  c();
  c();
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(calls.length, 1, 'still exactly one read in flight');
});
