'use strict';
// host/resource-history.js boundaries: the ring's capacity, MAX_STEP_MS, the wall-clock slack and clear().
// Release #117 Mortimer survivor 7 (the cheap, host-side part).
const test = require('node:test');
const assert = require('node:assert');
const { createHistory, MAX_STEP_MS, WALL_SLACK_MS } = require('../host/resource-history');

const fig = { cpu: 1, cpuOurs: 1, memUsed: 1, memOurs: 1, memTotal: 1 };

test('ring: exactly `capacity` points are all kept, one more drops the oldest', () => {
  const h = createHistory({ capacity: 3 });
  for (let i = 1; i <= 3; i++) h.record({ at: i * 1000, ...fig });
  assert.deepStrictEqual(h.points().map(p => p.at), [1000, 2000, 3000]);
  h.record({ at: 4000, ...fig });
  assert.deepStrictEqual(h.points().map(p => p.at), [2000, 3000, 4000]);
});

test('step: two points exactly MAX_STEP_MS apart are one run, one ms more is a break', () => {
  const exact = createHistory();
  exact.record({ at: 1000, ...fig });
  exact.record({ at: 1000 + MAX_STEP_MS, ...fig });
  assert.strictEqual(exact.points()[1].brk, undefined);
  const over = createHistory();
  over.record({ at: 1000, ...fig });
  over.record({ at: 1000 + MAX_STEP_MS + 1, ...fig });
  assert.strictEqual(over.points()[1].brk, true);
});

test('wall clock: a disagreement of exactly WALL_SLACK_MS is tolerated, one ms more is a break (either direction)', () => {
  const run = (skew) => {
    const h = createHistory();
    h.record({ at: 1000, wall: 50000, ...fig });
    h.record({ at: 11000, wall: 50000 + 10000 + skew, ...fig });
    return h.points()[1].brk;
  };
  assert.strictEqual(run(WALL_SLACK_MS), undefined);
  assert.strictEqual(run(-WALL_SLACK_MS), undefined);
  assert.strictEqual(run(WALL_SLACK_MS + 1), true);
  assert.strictEqual(run(-WALL_SLACK_MS - 1), true);
});

test('wall clock: a point with no wall time is not judged, and neither is the one after it', () => {
  const h = createHistory();
  h.record({ at: 1000, wall: 50000, ...fig });
  h.record({ at: 11000, ...fig });
  assert.strictEqual(h.points()[1].brk, undefined);
  h.record({ at: 21000, wall: 99999999, ...fig });
  assert.strictEqual(h.points()[2].brk, undefined, 'the previous point had no wall time: nothing to compare');
});

test('clear: empties the ring and forgets a pending break', () => {
  const h = createHistory();
  h.record({ at: 1000, ...fig });
  h.markBreak();
  h.clear();
  assert.deepStrictEqual(h.points(), []);
  h.record({ at: 2000, ...fig });
  h.record({ at: 3000, ...fig });
  assert.strictEqual(h.points()[0].brk, undefined);
  assert.strictEqual(h.points()[1].brk, undefined, 'the break marked before clear() does not survive it');
});

test('clear: forgets the last wall time too', () => {
  const h = createHistory();
  h.record({ at: 1000, wall: 50000, ...fig });
  h.clear();
  h.record({ at: 2000, wall: 1, ...fig });
  h.record({ at: 3000, ...fig });
  h.record({ at: 4000, wall: 987654321, ...fig });
  assert.strictEqual(h.points()[2].brk, undefined);
});

test('record: a point at or before the last one, or without a numeric time, is ignored', () => {
  const h = createHistory();
  h.record({ at: 1000, ...fig });
  h.record({ at: 1000, ...fig });
  h.record({ at: 999, ...fig });
  h.record({ at: '2000', ...fig });
  h.record({ at: NaN, ...fig });
  h.record(null);
  assert.strictEqual(h.points().length, 1);
});

test('record: cpu figures round to a tenth, memory to a whole byte; non-finite figures are null', () => {
  const h = createHistory();
  h.record({ at: 1, cpu: 12.34, cpuOurs: 5.55, memUsed: 100.6, memOurs: Infinity, memTotal: '5' });
  const p = h.points()[0];
  assert.deepStrictEqual([p.cpu, p.cpuOurs, p.memUsed, p.memOurs, p.memTotal], [12.3, 5.6, 101, null, null]);
});

test('recordFailure: a point with every figure null', () => {
  const h = createHistory();
  h.recordFailure(1, 1);
  assert.deepStrictEqual(h.points(), [{ at: 1, cpu: null, cpuOurs: null, memUsed: null, memOurs: null, memTotal: null }]);
});

test('points: returns copies, so a caller cannot edit the ring', () => {
  const h = createHistory();
  h.record({ at: 1, ...fig });
  h.points()[0].cpu = 99;
  assert.strictEqual(h.points()[0].cpu, 1);
});
