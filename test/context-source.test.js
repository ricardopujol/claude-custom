'use strict';
/**
 * BACKLOG #119 A2: the context circle has two sources, the statusLine relay's document and the mod's usage record. The fresher
 * one wins, a tie goes to the mod (the CLI's own answer), and "can't say" from the fresher source is shown as unknown, never as
 * the older source's figure left standing.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createContextSource } = require('../host/context-source');

function rig() {
  let t = 1000;
  const s = createContextSource({ now: () => t });
  return { s, tick(ms = 1) { t += ms; } };
}
const A = { used: 10, size: 200 };
const B = { used: 20, size: 200 };

test('before anything arrives it is unknown', () => {
  assert.strictEqual(rig().s.current(), null);
});

test('with only the relay, the relay\'s figure; with only the mod, the mod\'s', () => {
  const r = rig();
  assert.deepStrictEqual(r.s.fromRelay(A), A);
  const q = rig();
  assert.deepStrictEqual(q.s.fromMod(B), B);
});

test('the later of the two wins', () => {
  const r = rig();
  r.s.fromRelay(A);
  r.tick();
  assert.deepStrictEqual(r.s.fromMod(B), B);
  r.tick();
  assert.deepStrictEqual(r.s.fromRelay(A), A, 'a newer relay document takes it back');
});

test('at the same instant the mod wins', () => {
  const r = rig();
  r.s.fromRelay(A);
  assert.deepStrictEqual(r.s.fromMod(B), B);
  const q = rig();
  q.s.fromMod(B);
  assert.deepStrictEqual(q.s.fromRelay(A), B);
});

test('a newer "can\'t say" clears the older source\'s figure: unknown is not the last good value', () => {
  const r = rig();
  r.s.fromMod(B);
  r.tick();
  assert.strictEqual(r.s.fromRelay(null), null);
  r.tick();
  assert.strictEqual(r.s.fromMod(null), null);
  r.tick();
  assert.deepStrictEqual(r.s.fromRelay(A), A);
});

test('current() is what the last call returned', () => {
  const r = rig();
  const got = r.s.fromMod(B);
  assert.deepStrictEqual(r.s.current(), got);
});

test('reset forgets both sources: nothing older can come back after a /clear', () => {
  const r = rig();
  r.s.fromMod(B);
  r.s.fromRelay(A);
  assert.strictEqual(r.s.reset(), null);
  assert.strictEqual(r.s.current(), null);
  r.tick();
  assert.strictEqual(r.s.fromRelay(null), null, 'and a relay that cannot say stays unknown');
});

test('a figure is copied: changing what came back does not change the source', () => {
  const r = rig();
  const got = r.s.fromMod({ used: 1, size: 2 });
  got.used = 99;
  assert.strictEqual(r.s.current().used, 1);
});
