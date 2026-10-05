'use strict';
/**
 * host/resource-history.js (BACKLOG #63 follow-up): the one-hour ring of machine samples. Absence is never zero.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const H = require('../host/resource-history');

const good = (at, over = {}) => ({ at, cpu: 40, cpuOurs: 10, memUsed: 600, memOurs: 100, memTotal: 1000, ...over });

test('keeps one point per record, oldest first', () => {
  const h = H.createHistory();
  h.record(good(10000));
  h.record(good(20000, { cpu: 50 }));
  assert.deepStrictEqual(h.points().map(p => [p.at, p.cpu]), [[10000, 40], [20000, 50]]);
});

test('capacity is an hour of 10 s samples, and the oldest falls off first', () => {
  assert.strictEqual(H.CAPACITY, 360);
  const h = H.createHistory();
  for (let i = 1; i <= 365; i++) h.record(good(i * 10000));
  const pts = h.points();
  assert.strictEqual(pts.length, 360);
  assert.strictEqual(pts[0].at, 6 * 10000);
  assert.strictEqual(pts.at(-1).at, 365 * 10000);
});

test('an unmeasured value is null, never 0 (the Number(null) trap)', () => {
  const h = H.createHistory();
  h.record({ at: 10000, cpu: null, cpuOurs: undefined, memUsed: '5', memOurs: NaN, memTotal: Infinity });
  assert.deepStrictEqual(h.points()[0], { at: 10000, cpu: null, cpuOurs: null, memUsed: null, memOurs: null, memTotal: null });
});

test('a real 0 stays 0', () => {
  const h = H.createHistory();
  h.record(good(10000, { cpu: 0 }));
  assert.strictEqual(h.points()[0].cpu, 0);
});

test('a failed sample is a point with every figure null', () => {
  const h = H.createHistory();
  h.recordFailure(10000);
  assert.deepStrictEqual(h.points(), [{ at: 10000, cpu: null, cpuOurs: null, memUsed: null, memOurs: null, memTotal: null }]);
});

test('a point that is not after the last, or has no real time, is dropped', () => {
  const h = H.createHistory();
  h.record(good(20000));
  h.record(good(20000));
  h.record(good(10000));
  h.record(good(null));
  h.record(good('30000'));
  h.recordFailure(NaN);
  assert.strictEqual(h.points().length, 1);
});

test('points() is a copy: changing it does not change the ring', () => {
  const h = H.createHistory();
  h.record(good(10000));
  h.points().pop();
  assert.strictEqual(h.points().length, 1);
});

test('clear empties it', () => {
  const h = H.createHistory();
  h.record(good(10000));
  h.clear();
  assert.deepStrictEqual(h.points(), []);
});

test('property: at most 360 points, time strictly increasing, and a null never comes out as a number', () => {
  const val = fc.oneof(fc.constant(null), fc.constant(undefined), fc.constant(NaN), fc.double({ min: 0, max: 1e12, noNaN: true }));
  fc.assert(fc.property(
    fc.array(fc.record({ at: fc.integer({ min: -5, max: 1e7 }), cpu: val, cpuOurs: val, memUsed: val, memOurs: val, memTotal: val, fail: fc.boolean() }), { maxLength: 800 }),
    (inputs) => {
      const h = H.createHistory();
      for (const i of inputs) (i.fail ? h.recordFailure(i.at) : h.record(i));
      const pts = h.points();
      assert.ok(pts.length <= 360);
      for (let k = 1; k < pts.length; k++) assert.ok(pts[k].at > pts[k - 1].at);
      for (const p of pts) {
        for (const f of ['cpu', 'cpuOurs', 'memUsed', 'memOurs', 'memTotal']) assert.ok(p[f] === null || (typeof p[f] === 'number' && Number.isFinite(p[f])));
      }
      // every input that was null/undefined/NaN and became a point is null
      let last = -Infinity;
      for (const i of inputs) {
        if (!(i.at > last) || !Number.isFinite(i.at)) continue;
        last = i.at;
        const p = pts.find(x => x.at === i.at);
        if (!p) continue;   // fell off the front
        for (const f of ['cpu', 'cpuOurs', 'memUsed', 'memOurs', 'memTotal']) {
          const raw = i.fail ? null : i[f];
          if (typeof raw !== 'number' || !Number.isFinite(raw)) assert.strictEqual(p[f], null);
        }
      }
    },
  ));
});

// ---- breaks and rounding (Dexter, PR #114 D1/D3) ---------------------------------------------------------------------------

test('markBreak: the next point carries brk, and the one after it does not; with nothing before it there is nothing to break', () => {
  const h = H.createHistory();
  h.markBreak();
  h.record(good(10000));
  assert.strictEqual(h.points()[0].brk, undefined, 'the first point has no "before"');
  h.record(good(20000));
  h.markBreak();
  h.record(good(30000));
  h.record(good(40000));
  assert.deepStrictEqual(h.points().map(p => p.brk), [undefined, undefined, true, undefined]);
});

test('a step over a minute with no sample breaks the line; a slow 30 s one does not', () => {
  const h = H.createHistory();
  h.record(good(0));
  h.record(good(30000));
  h.record(good(30000 + 61000));
  assert.deepStrictEqual(h.points().map(p => p.brk), [undefined, undefined, true]);
});

test('a wall-clock jump of either sign, against the monotonic spacing, breaks the line', () => {
  const h = H.createHistory();
  h.record(good(0, { wall: 1000000 }));
  h.record(good(10000, { wall: 1010000 }));                 // wall agrees with the monotonic clock
  h.record(good(20000, { wall: 1020000 + 4 * 3600000 }));   // 4 h ahead
  h.record(good(30000, { wall: 1030000 }));                 // and back
  h.record(good(40000, { wall: 1042000 }));                 // 2 s of slack is not a break
  assert.deepStrictEqual(h.points().map(p => p.brk), [undefined, undefined, true, true, undefined]);
});

test('the ring keeps every point it is given in monotonic order, whatever wall times ride along (the real D1 regression is in resources-service.test.js)', () => {
  const h = H.createHistory();
  h.record(good(1000, { wall: 1000 }));
  h.record(good(11000, { wall: 4 * 3600000 + 11000 }));
  h.record(good(21000, { wall: 21000 }));
  h.record(good(31000, { wall: 31000 }));
  assert.deepStrictEqual(h.points().map(p => p.at), [1000, 11000, 21000, 31000]);
});

test('values are rounded when recorded: CPU to 0.1, bytes to whole numbers; a wall time is not stored', () => {
  const h = H.createHistory();
  h.record(good(1000, { cpu: 12.3456, cpuOurs: 0.04, memUsed: 1234.6, memOurs: 99.5, memTotal: 2000, wall: 5 }));
  assert.deepStrictEqual(h.points()[0], { at: 1000, cpu: 12.3, cpuOurs: 0, memUsed: 1235, memOurs: 100, memTotal: 2000 });
});

test('a failure point can break too (after a minimise), and carries nulls', () => {
  const h = H.createHistory();
  h.record(good(1000));
  h.markBreak();
  h.recordFailure(11000);
  assert.strictEqual(h.points()[1].brk, true);
  assert.strictEqual(h.points()[1].cpu, null);
});
