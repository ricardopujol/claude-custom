'use strict';
/**
 * Boundary kill tests for host/summary-scheduler.js, from Mortimer's gate on release PR #109 (survivor 11): the hold after
 * a failed job lasts exactly its length, equal waiting times go in insertion order, a hold of nothing is no hold,
 * activity at the very moment a job started is not lost, and forgetting the running tab frees the runner.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createScheduler, QUIET_MS } = require('../host/summary-scheduler');

/** A tab that is due at QUIET_MS and has just had a job started and failed at that moment with `holdMs`. */
function failed(holdMs, key = 'a') {
  const s = createScheduler();
  s.activity(key, 0);
  assert.strictEqual(s.start(key, QUIET_MS), true);
  s.fail(key, QUIET_MS, holdMs);
  return s;
}

test('a failed job holds the tab for exactly holdMs: due again at the last ms of the hold, not before', () => {
  const s = failed(5000);
  assert.strictEqual(s.ready(QUIET_MS), null);
  assert.strictEqual(s.ready(QUIET_MS + 4999), null);
  assert.strictEqual(s.ready(QUIET_MS + 5000), 'a');
});

test('a hold of 0 or less is no hold at all, and so is one that is not a number', () => {
  for (const hold of [0, -1, -5000, NaN, Infinity * 0, '5000', null, undefined]) {
    const s = failed(hold);
    assert.strictEqual(s.state('a').holdUntil, null, `holdMs ${String(hold)}`);
    assert.strictEqual(s.ready(QUIET_MS), 'a', `holdMs ${String(hold)} is due at once`);
  }
  const s = createScheduler();
  s.activity('a', 0);
  s.start('a', QUIET_MS);
  s.fail('a', NaN, 5000);
  assert.strictEqual(s.state('a').holdUntil, null, 'a hold needs a real "now"');
});

test('with no hold, a tab is due on a negative clock too (a missing hold is not read as time zero)', () => {
  const s = createScheduler();
  s.activity('a', -100_000);
  assert.strictEqual(s.ready(-100_000 + QUIET_MS), 'a');
});

test('tabs that have waited equally long go in the order they were first seen', () => {
  const s = createScheduler();
  s.activity('b', 1000);
  s.activity('a', 1000);
  s.activity('c', 1000);
  assert.strictEqual(s.ready(1000 + QUIET_MS), 'b');
  s.start('b', 1000 + QUIET_MS);
  s.finish('b', 1000 + QUIET_MS);
  assert.strictEqual(s.ready(1000 + QUIET_MS), 'a');
});

test('of two due tabs the one that began waiting first goes first, whatever the order they were added', () => {
  const s = createScheduler();
  s.activity('late', 2000);
  s.activity('early', 1000);
  assert.strictEqual(s.ready(2000 + QUIET_MS), 'early');
});

test('activity at the very moment the job started keeps the tab waiting; activity just before does not', () => {
  const at = createScheduler();
  at.activity('a', 0);
  at.start('a', 5000);
  at.activity('a', 5000);
  at.finish('a', 9000);
  assert.strictEqual(at.state('a').dirty, true);
  assert.strictEqual(at.state('a').dirtySince, 5000, 'and it has waited since that activity');

  const before = createScheduler();
  before.activity('a', 0);
  before.start('a', 5000);
  before.activity('a', 4999);
  before.finish('a', 9000);
  assert.strictEqual(before.state('a').dirty, false);
});

test('forgetting the tab whose job is running frees the runner; forgetting another tab does not', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.activity('b', 0);
  s.start('a', QUIET_MS);
  s.forget('b');
  assert.strictEqual(s.running(), 'a');
  s.forget('a');
  assert.strictEqual(s.running(), null);
  s.activity('c', 0);
  assert.strictEqual(s.start('c', QUIET_MS), true);
});
