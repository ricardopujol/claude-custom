'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createCooldowns, DEFAULT_COOLDOWNS } = require('../host/cooldowns');

function harness(opts = {}) {
  let now = 1_000_000;
  const c = createCooldowns({ now: () => now, store: memStore(), ...opts });
  return { c, advance(ms) { now += ms; }, now: () => now };
}

function memStore() {
  let data = {};
  return { read: (_n, d) => (Object.keys(data).length ? data : d), write: (_n, v) => (data = v) };
}

test('nothing is cooling down to begin with', () => {
  assert.deepStrictEqual(harness().c.list(), []);
});

test('an agent with a configured cooldown starts one when it finishes', () => {
  // Mortimer is expensive in wall-clock. The project rule is that mutation
  // testing runs LAST, ONCE, against a stable tree -- a rule currently kept
  // only by memory, and already broken once.
  const h = harness();
  h.c.finished('mutation-tester');
  const [c] = h.c.list();
  assert.strictEqual(c.agent, 'mutation-tester');
  assert.ok(c.remainingMs > 0);
});

test('an agent without a configured cooldown does not get one', () => {
  const h = harness();
  h.c.finished('code-reviewer');
  assert.deepStrictEqual(h.c.list(), []);
});

test('the cooldown expires', () => {
  const h = harness();
  h.c.finished('mutation-tester');
  h.advance(DEFAULT_COOLDOWNS['mutation-tester'] + 1);
  assert.deepStrictEqual(h.c.list(), []);
});

test('reports whether a specific agent is cooling', () => {
  const h = harness();
  assert.strictEqual(h.c.isCooling('mutation-tester'), false);
  h.c.finished('mutation-tester');
  assert.strictEqual(h.c.isCooling('mutation-tester'), true);
});

test('remaining time counts down', () => {
  const h = harness();
  h.c.finished('mutation-tester');
  const before = h.c.list()[0].remainingMs;
  h.advance(60_000);
  assert.strictEqual(h.c.list()[0].remainingMs, before - 60_000);
});

test('survives a host restart, because the rule outlives the process', () => {
  // A cooldown that resets when the GUI is reopened enforces nothing.
  const store = memStore();
  let now = 1_000_000;
  createCooldowns({ now: () => now, store }).finished('mutation-tester');
  now += 60_000;
  const revived = createCooldowns({ now: () => now, store });
  assert.strictEqual(revived.isCooling('mutation-tester'), true);
});

test('re-running restarts the clock rather than stacking', () => {
  const h = harness();
  h.c.finished('mutation-tester');
  h.advance(60_000);
  h.c.finished('mutation-tester');
  assert.strictEqual(h.c.list()[0].remainingMs, DEFAULT_COOLDOWNS['mutation-tester']);
});

test('cooldowns are advisory, never blocking', () => {
  // The harness must not refuse to run an agent. The point is to make the cost
  // visible, not to override a deliberate decision.
  const h = harness();
  h.c.finished('mutation-tester');
  assert.strictEqual(typeof h.c.isCooling, 'function');
  assert.ok(!('block' in h.c), 'cooldowns must not expose a blocking API');
});

test('soonest-to-expire first', () => {
  const h = harness({ cooldowns: { a: 100_000, b: 50_000 } });
  h.c.finished('a');
  h.c.finished('b');
  assert.deepStrictEqual(h.c.list().map(c => c.agent), ['b', 'a']);
});
