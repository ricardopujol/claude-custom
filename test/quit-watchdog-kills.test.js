'use strict';
/**
 * Kill tests for the release-gate survivor S11 in app/quit-watchdog.js (Mortimer, 2026-10-09): every other test injects `hardKill`, so
 * the production default (SIGKILL on our own pid) and the `unref` guard were never run. `process.kill` is replaced for the length of
 * each call and restored in a finally; it is never allowed to reach the real one.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { armQuitWatchdog } = require('../app/quit-watchdog');

function withKillStub(fn) {
  const real = process.kill; const calls = [];
  process.kill = (...a) => { calls.push(a); return true; };
  try { fn(calls); } finally { process.kill = real; }
  return calls;
}

test('S11: the default hard kill is SIGKILL on this very process', () => {
  const app = new EventEmitter(); let fire = null;
  armQuitWatchdog(app, { setTimer: (fn) => { fire = fn; return {}; } });
  app.emit('will-quit', { preventDefault() {} });
  assert.strictEqual(typeof fire, 'function', 'a timer was armed with the default kill');
  const calls = withKillStub(() => fire());
  assert.deepStrictEqual(calls, [[process.pid, 'SIGKILL']]);
});

test('S11: a timer without unref is tolerated, one with unref is unref-ed, and no timer at all is tolerated', () => {
  const fire = (timer) => { const app = new EventEmitter(); armQuitWatchdog(app, { setTimer: () => timer, hardKill: () => {} }); app.emit('will-quit', { preventDefault() {} }); };
  assert.doesNotThrow(() => fire({}));
  assert.doesNotThrow(() => fire(undefined));
  assert.doesNotThrow(() => fire(null));
  assert.doesNotThrow(() => fire({ unref: 'nope' }));
  let called = 0;
  fire({ unref() { called++; } });
  assert.strictEqual(called, 1);
});

test('S11: the default grace period is the 5 s the module advertises', () => {
  const app = new EventEmitter(); let ms = null;
  armQuitWatchdog(app, { setTimer: (_fn, m) => { ms = m; return {}; }, hardKill: () => {} });
  app.emit('will-quit');
  assert.strictEqual(ms, 5000);
});
