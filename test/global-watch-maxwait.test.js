'use strict';
/**
 * PR #95 Dexter D6: a trailing-only debounce starves under a steady writer (a dev server logging every
 * 200 ms): every event re-armed the timer and onChange never fired. `maxWaitMs` bounds the wait; without it
 * every other caller behaves exactly as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const { watchGlobalDir } = require('../host/global-watch');

function rig(extra = {}) {
  const s = { t: 0, handlers: [], timers: [], calls: 0 };
  const deps = {
    mkdirSync: () => {}, log: () => {}, now: () => s.t,
    watch: (d, h) => { s.handlers.push(h); return { on: () => {}, close: () => {} }; },
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false, at: s.t }; s.timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    ...extra,
  };
  const w = watchGlobalDir('/x', () => { s.calls += 1; }, deps);
  // run every timer that is due at the current fake time
  const advance = (ms) => {
    s.t += ms;
    for (const h of s.timers) if (!h.cleared && !h.fired && h.at + h.ms <= s.t) { h.fired = true; h.fn(); }
  };
  return { s, w, advance };
}

test('D6: events every 200ms for 5s still fire onChange with a max wait of 2s (and at least twice)', () => {
  const { s, advance } = rig({ delayMs: 300, maxWaitMs: 2000 });
  for (let i = 0; i < 25; i++) { s.handlers[0]('change', 'log.txt'); advance(200); }
  assert.ok(s.calls >= 2, `fired ${s.calls} times`);
});

test('D6: without maxWaitMs the same stream starves, as before (every other caller is unchanged)', () => {
  const { s, advance } = rig({ delayMs: 300 });
  for (let i = 0; i < 25; i++) { s.handlers[0]('change', 'log.txt'); advance(200); }
  assert.strictEqual(s.calls, 0);
  advance(400);
  assert.strictEqual(s.calls, 1);
});

test('D6: a burst shorter than the max wait is one change after the quiet delay, as before', () => {
  const { s, advance } = rig({ delayMs: 300, maxWaitMs: 2000 });
  s.handlers[0]('change', 'a'); advance(100); s.handlers[0]('change', 'b'); advance(100); s.handlers[0]('change', 'c');
  assert.strictEqual(s.calls, 0);
  advance(300);
  assert.strictEqual(s.calls, 1);
});

test('D6: after a forced fire the next burst starts its own clock', () => {
  const { s, advance } = rig({ delayMs: 300, maxWaitMs: 1000 });
  for (let i = 0; i < 8; i++) { s.handlers[0]('change', 'x'); advance(200); }       // 1.6s of steady events
  const afterFirst = s.calls;
  assert.ok(afterFirst >= 1);
  advance(2000);                                                                     // quiet: the tail fires
  const quiet = s.calls;
  s.handlers[0]('change', 'y');
  assert.strictEqual(s.calls, quiet, 'a single new event does not fire at once');
  advance(300);
  assert.strictEqual(s.calls, quiet + 1);
});

test('D6: a forced fire leaves no stale timer that would fire the same burst twice', () => {
  const { s, advance } = rig({ delayMs: 300, maxWaitMs: 500 });
  s.handlers[0]('change', 'a'); advance(250); s.handlers[0]('change', 'a'); advance(250); s.handlers[0]('change', 'a');
  const forced = s.calls;
  assert.strictEqual(forced, 1);
  advance(1000);
  assert.strictEqual(s.calls, 1, 'nothing further without further events');
});
