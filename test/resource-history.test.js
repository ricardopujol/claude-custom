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
