'use strict';
/**
 * BACKLOG #80 / #55: the speech bubbles' rate limit and queue. At most one bubble per agent per 3 minutes, one model request at
 * a time, and a request that arrives while one is running is DROPPED (never queued): a joke is not worth a stalled GPU.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createBubbleGate, MIN_GAP_MS } = require('../host/bubble-gate');

function clock(t = 1_000_000) { return { now: () => t, set: (v) => { t = v; }, add: (d) => { t += d; } }; }

test('the gap between two bubbles of one agent is three minutes', () => {
  assert.strictEqual(MIN_GAP_MS, 3 * 60_000);
});

test('the first request is accepted, a second while it runs is dropped as busy', () => {
  const c = clock();
  const g = createBubbleGate({ now: c.now });
  assert.deepStrictEqual(g.offer('miguel'), { ok: true });
  assert.deepStrictEqual(g.offer('dexter'), { ok: false, reason: 'busy' });
});

test('after done(), another agent may go, the same agent waits out the gap', () => {
  const c = clock();
  const g = createBubbleGate({ now: c.now });
  g.offer('miguel'); g.done();
  assert.deepStrictEqual(g.offer('dexter'), { ok: true }); g.done();
  c.add(MIN_GAP_MS - 1);
  assert.deepStrictEqual(g.offer('miguel'), { ok: false, reason: 'rate' });
  c.add(1);
  assert.deepStrictEqual(g.offer('miguel'), { ok: true });
});

test('a dropped request does not start the gap', () => {
  const c = clock();
  const g = createBubbleGate({ now: c.now });
  g.offer('miguel');                          // in flight
  assert.strictEqual(g.offer('dexter').ok, false);
  g.done();
  assert.strictEqual(g.offer('dexter').ok, true);   // not blocked by the dropped try
});

test('done() with nothing in flight is harmless', () => {
  const g = createBubbleGate({ now: clock().now });
  g.done(); g.done();
  assert.strictEqual(g.offer('a').ok, true);
});

test('an agent named like a prototype key is an ordinary agent', () => {
  const c = clock();
  const g = createBubbleGate({ now: c.now });
  assert.strictEqual(g.offer('__proto__').ok, true); g.done();
  assert.strictEqual(g.offer('__proto__').ok, false);
  assert.strictEqual(g.offer('toString').ok, true);
});

test('a clock that goes backwards never opens the gate early', () => {
  const c = clock(5_000_000);
  const g = createBubbleGate({ now: c.now });
  g.offer('a'); g.done();
  c.set(1_000);
  assert.strictEqual(g.offer('a').ok, false);
});

test('the default clock is monotonic: a wall-clock step back holds nobody silent past the gap', () => {
  const realNow = performance.now; const realDate = Date.now;
  let mono = 1000; let wall = 9_000_000;
  performance.now = () => mono; Date.now = () => wall;
  try {
    const g = createBubbleGate();
    g.offer('a'); g.done();
    wall -= 3_600_000;
    mono += MIN_GAP_MS;
    assert.deepStrictEqual(g.offer('a'), { ok: true });
  } finally { performance.now = realNow; Date.now = realDate; }
});

test('the memory of old bubbles is bounded', () => {
  const c = clock();
  const g = createBubbleGate({ now: c.now });
  for (let i = 0; i < 5000; i++) { g.offer('agent' + i); g.done(); c.add(MIN_GAP_MS); }
  assert.ok(g.remembered() <= 1100, `remembered ${g.remembered()}`);
});

test('PROPERTY: over any event sequence, one at a time and one per agent per gap', () => {
  const ev = fc.oneof(
    fc.record({ t: fc.constant('offer'), a: fc.constantFrom('a', 'b', 'c', 'd'), dt: fc.integer({ min: 0, max: 120_000 }) }),
    fc.record({ t: fc.constant('done'), dt: fc.integer({ min: 0, max: 120_000 }) }),
  );
  fc.assert(fc.property(fc.array(ev, { maxLength: 80 }), (events) => {
    const c = clock();
    const g = createBubbleGate({ now: c.now });
    let inFlight = false;
    const acceptedAt = new Map();
    for (const e of events) {
      c.add(e.dt);
      if (e.t === 'done') { g.done(); inFlight = false; continue; }
      const out = g.offer(e.a);
      if (out.ok) {
        assert.strictEqual(inFlight, false, 'two requests in flight');
        inFlight = true;
        const last = acceptedAt.get(e.a);
        if (last !== undefined) assert.ok(c.now() - last >= MIN_GAP_MS, 'rate limit broken');
        acceptedAt.set(e.a, c.now());
      } else if (inFlight) {
        assert.strictEqual(out.reason, 'busy');
      }
    }
  }), { numRuns: 200 });
});

test('PROPERTY: a request with nothing in flight and a quiet agent is always accepted', () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 1e9 }), (agent, t0) => {
    const g = createBubbleGate({ now: () => t0 });
    assert.deepStrictEqual(g.offer(agent), { ok: true });
  }));
});
