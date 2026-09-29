'use strict';
/**
 * When the host tells the panel about running processes and the party.
 *
 * Dexter, PR #34, Finding 6: the tick re-broadcast `processes` only while
 * `processes.list()` was non-empty. When mood.tick() reaped two stranded
 * background instances with no processes left, the party shrank and nobody was
 * told -- a sleeping card kept "×2 running now". The falling edge matters as
 * much as the rising one, the same lesson the cooldowns broadcast learned.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createProcessesBroadcast } = require('../host/processes-broadcast');

function harness() {
  const sent = [];
  const b = createProcessesBroadcast((msg) => sent.push(msg));
  return { b, sent };
}

test('tick: the party shrinking to nothing IS broadcast, even with no processes (Finding 6)', () => {
  const { b, sent } = harness();
  b.send([], ['logic-reviewer', 'logic-reviewer']);        // a hook event told everyone ×2
  sent.length = 0;
  b.tick([], []);                                          // mood.tick() reaped both
  assert.deepStrictEqual(sent, [{ type: 'processes', running: [], party: [] }]);
});

test('tick: the LAST running row going away IS broadcast, even with the party unchanged (#45)', () => {
  // processes.sweep() removes a stale row on the tick; nothing runs afterwards
  // and the party is the same. Sending only "while anything runs or the party
  // changed" left the swept row on screen forever -- the exact defect #45 fixes,
  // reintroduced by the merge with this module.
  const { b, sent } = harness();
  const row = { id: 't1', tool: 'Bash', stale: true };
  b.send([row], ['main']);
  sent.length = 0;
  b.tick([], ['main']);                                    // swept; party unchanged
  assert.deepStrictEqual(sent, [{ type: 'processes', running: [], party: ['main'] }]);
  sent.length = 0;
  b.tick([], ['main']);                                    // and only once
  assert.strictEqual(sent.length, 0);
});

test('tick: an unchanged, idle party is NOT re-broadcast every second', () => {
  const { b, sent } = harness();
  b.send([], []);
  sent.length = 0;
  b.tick([], []);
  b.tick([], []);
  assert.strictEqual(sent.length, 0);
});

test('tick: while anything runs, every tick broadcasts (elapsed times tick up)', () => {
  const { b, sent } = harness();
  const running = [{ id: 'p1' }];
  b.send(running, ['a']);
  sent.length = 0;
  b.tick(running, ['a']);
  b.tick(running, ['a']);
  assert.strictEqual(sent.length, 2);
});

test('tick: a party that CHANGED since the last broadcast is sent, whatever else is true', () => {
  const { b, sent } = harness();
  b.send([], ['a']);
  sent.length = 0;
  b.tick([], ['a', 'b']);
  assert.deepStrictEqual(sent, [{ type: 'processes', running: [], party: ['a', 'b'] }]);
  sent.length = 0;
  b.tick([], ['a', 'b']);
  assert.strictEqual(sent.length, 0, 'and once sent, it is not news again');
});

test('tick: before anything was ever sent, the first idle tick announces the state once', () => {
  const { b, sent } = harness();
  b.tick([], []);
  b.tick([], []);
  assert.strictEqual(sent.length, 1);
});

test('a broadcast that THROWS on the falling edge is retried on the next tick (Dexter, #45 review)', () => {
  // The retry works only because send() broadcasts BEFORE it records what was
  // sent. Record first and a throw loses the falling edge for good: the next
  // tick sees "nothing ran, party unchanged" and the swept row stays on screen.
  const sent = [];
  let fail = false;
  const b = createProcessesBroadcast((msg) => { if (fail) throw new Error('socket gone'); sent.push(msg); });
  b.send([{ id: 't1' }], ['main']);
  sent.length = 0;
  fail = true;
  assert.throws(() => b.tick([], ['main']));
  fail = false;
  b.tick([], ['main']);
  assert.deepStrictEqual(sent, [{ type: 'processes', running: [], party: ['main'] }]);
});
