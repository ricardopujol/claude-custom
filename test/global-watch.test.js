'use strict';
/**
 * Dexter F3 (PR #64): a change to the global picture made by another project
 * window (its own host, the same uploads folder) must reach this host.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { watchGlobalDir } = require('../host/global-watch');

function fakes() {
  const state = { handlers: [], timers: [], closed: 0, made: [], cleared: [] };
  return {
    state,
    deps: {
      mkdirSync: (d, o) => state.made.push([d, o]),
      watch: (d, h) => { state.handlers.push(h); return { on: () => {}, close: () => { state.closed += 1; } }; },
      setTimer: (fn, ms) => { const t = { fn, ms }; state.timers.push(t); return t; },
      clearTimer: (t) => state.cleared.push(t),
      log: () => {},
    },
  };
}

test('the folder is created first, so the very first global picture is seen', () => {
  const { state, deps } = fakes();
  watchGlobalDir('/x/_global', () => {}, deps);
  assert.deepStrictEqual(state.made, [['/x/_global', { recursive: true }]]);
});

test('a burst of events (temp file, rename, cleanup) is debounced into ONE change', () => {
  const { state, deps } = fakes();
  let calls = 0;
  watchGlobalDir('/x', () => { calls += 1; }, deps);
  state.handlers[0](); state.handlers[0](); state.handlers[0]();
  assert.strictEqual(state.timers.length, 3);
  assert.strictEqual(state.cleared.length, 2, 'each new event cancels the pending timer');
  state.timers[2].fn();
  assert.strictEqual(calls, 1);
});

test('close cancels a pending change and closes the watcher', () => {
  const { state, deps } = fakes();
  let calls = 0;
  const h = watchGlobalDir('/x', () => { calls += 1; }, deps);
  state.handlers[0]();
  h.close();
  state.timers[0].fn();
  assert.strictEqual(calls, 0);
  assert.strictEqual(state.closed, 1);
  assert.doesNotThrow(() => h.close());
});

test('an event after close is ignored', () => {
  const { state, deps } = fakes();
  const h = watchGlobalDir('/x', () => {}, deps);
  h.close();
  state.handlers[0]();
  assert.strictEqual(state.timers.length, 0);
});

test('a callback that throws is logged, not fatal', () => {
  const { state, deps } = fakes();
  const logged = [];
  watchGlobalDir('/x', () => { throw new Error('boom'); }, { ...deps, log: (...a) => logged.push(a.join(' ')) });
  state.handlers[0]();
  assert.doesNotThrow(() => state.timers[0].fn());
  assert.match(logged.join('\n'), /boom/);
});

test('a platform that cannot watch leaves a working no-op handle and says so', () => {
  const logged = [];
  const h = watchGlobalDir('/x', () => {}, {
    mkdirSync: () => {}, watch: () => { throw new Error('ENOSPC'); }, log: (...a) => logged.push(a.join(' ')),
  });
  assert.doesNotThrow(() => h.close());
  assert.match(logged.join('\n'), /cannot watch/);
});

test('REAL fs: a write by another actor in the folder fires onChange', async () => {
  const dir = path.join(tmpDir('cc-gw-'), 'uploads', '_global');
  let fired;
  const seen = new Promise((resolve) => { fired = resolve; });
  const h = watchGlobalDir(dir, () => fired(true), { delayMs: 30 });
  try {
    fs.writeFileSync(path.join(dir, 'default.png'), 'x');       // "the other window"
    const ok = await Promise.race([seen, new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.strictEqual(ok, true, 'no change was reported within 3 s');
  } finally {
    h.close();
  }
});

test('REAL fs: a removal (Reset in the other window) also fires onChange', async () => {
  const dir = path.join(tmpDir('cc-gw-'), '_global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'default.png'), 'x');
  let fired;
  const seen = new Promise((resolve) => { fired = resolve; });
  const h = watchGlobalDir(dir, () => fired(true), { delayMs: 30 });
  try {
    fs.unlinkSync(path.join(dir, 'default.png'));
    assert.strictEqual(await Promise.race([seen, new Promise((r) => setTimeout(() => r(false), 3000))]), true);
  } finally {
    h.close();
  }
});

// Reused for the occupancy folder (backlog #44 + #47): the log lines must name WHAT is being watched, or a
// failed occupancy watch reads as a broken global picture.
test('what: the log lines name the watched thing, defaulting to the global picture', () => {
  const lines = (what) => {
    const logged = [];
    const { state, deps } = fakes();
    watchGlobalDir('/x', () => { throw new Error('boom'); },
      { ...deps, ...(what ? { what } : {}), log: (...a) => logged.push(a.join(' ')), watch: () => { throw new Error('ENOSPC'); } });
    watchGlobalDir('/x', () => { throw new Error('boom'); },
      { ...deps, ...(what ? { what } : {}), log: (...a) => logged.push(a.join(' ')) });
    state.handlers[0]();
    state.timers[0].fn();
    return logged.join('\n');
  };
  assert.match(lines(), /global picture/);
  const named = lines('worktree occupancy');
  assert.match(named, /worktree occupancy/);
  assert.doesNotMatch(named, /global picture/);
});
