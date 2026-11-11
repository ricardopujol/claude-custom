'use strict';
/** A window's timers and crash guard (single-instance PR 2, step 7): poll cleared on dispose, one-shots too, a throw costs a tick. */
const test = require('node:test');
const assert = require('node:assert');
const { createWindowTimers } = require('../app/window-timers');

function rig() {
  const logs = [];
  const timers = createWindowTimers({ label: 'Proj', log: (m) => logs.push(m) });
  return { timers, logs };
}

test('the poll ticks every interval while active; after dispose() it is inactive and no tick follows', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { timers } = rig();
  let ticks = 0;
  assert.strictEqual(timers.pollActive(), false);
  assert.strictEqual(timers.startPoll(3000, () => { ticks += 1; }), true);
  assert.strictEqual(timers.pollActive(), true);
  t.mock.timers.tick(9000);
  assert.strictEqual(ticks, 3);
  timers.dispose();
  assert.strictEqual(timers.pollActive(), false);
  t.mock.timers.tick(30000);
  assert.strictEqual(ticks, 3, 'no tick after dispose');
});

test('dispose() is idempotent, and nothing can be started after it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { timers } = rig();
  timers.startPoll(10, () => {});
  timers.dispose();
  assert.doesNotThrow(() => timers.dispose());
  assert.strictEqual(timers.startPoll(10, () => {}), false);
  assert.strictEqual(timers.later('x', 10, () => {}), null);
  assert.strictEqual(timers.pollActive(), false);
});

test('a second startPoll is ignored: one poll per window', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { timers } = rig();
  let ticks = 0;
  assert.strictEqual(timers.startPoll(1000, () => { ticks += 1; }), true);
  assert.strictEqual(timers.startPoll(1000, () => { ticks += 100; }), false);
  t.mock.timers.tick(1000);
  assert.strictEqual(ticks, 1);
  timers.dispose();
});

test('a one-shot runs once; a pending one-shot is cleared by dispose()', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { timers } = rig();
  const ran = [];
  timers.later('a', 20_000, () => ran.push('a'));
  timers.later('b', 40_000, () => ran.push('b'));
  t.mock.timers.tick(20_000);
  assert.deepStrictEqual(ran, ['a']);
  timers.dispose();
  t.mock.timers.tick(60_000);
  assert.deepStrictEqual(ran, ['a'], 'the pending b never ran');
});

test('guard() logs the label and what failed, returns, and does not rethrow (sync throw and rejected promise)', async () => {
  const { timers, logs } = rig();
  const g = timers.guard('poll', () => { throw new Error('boom'); });
  assert.doesNotThrow(() => g());
  assert.match(logs[0], /^\[Proj\] poll failed: /);
  assert.match(logs[0], /boom/);
  const h = timers.guard('issues', () => Promise.reject(new Error('later')));
  await h();
  await new Promise((r) => setImmediate(r));
  assert.match(logs[1], /^\[Proj\] issues failed: .*later/);
  assert.strictEqual(timers.guard('ok', () => 7)(), 7, 'a passing call still answers');
});

test('a tick that throws costs one tick, not the poll: the next interval still runs', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { timers, logs } = rig();
  let n = 0;
  timers.startPoll(100, () => { n += 1; if (n === 1) throw new Error('first'); });
  t.mock.timers.tick(300);
  assert.strictEqual(n, 3);
  assert.strictEqual(logs.length, 1);
  timers.dispose();
});

test('the module needs no Electron', () => {
  assert.doesNotMatch(require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'window-timers.js'), 'utf8'), /require\(\s*['"]electron['"]\s*\)/);
});
