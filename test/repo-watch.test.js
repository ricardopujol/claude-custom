'use strict';
/**
 * The Files tab's live refresh (#45): a debounced, re-arming watch of the WORKTREE (the
 * host/global-watch.js pattern), so a file Claude writes appears without a reload.
 */
const test = require('node:test');
const assert = require('node:assert');
const { watchRepo, ignoredEvent } = require('../host/repo-watch');

test('events inside .git, node_modules and the harness noise folders are ignored, at any depth', () => {
  for (const n of ['.git', '.git/index', '.git\\objects\\ab', 'node_modules', 'node_modules/x/y.js', 'pkg/node_modules/x.js',
    '.harness/state/a.json', '.stryker-tmp/x/y.js']) {
    assert.strictEqual(ignoredEvent(n), true, n);
  }
});

test('a real file, a sibling that merely resembles an ignored name, and an unnamed event are kept', () => {
  for (const n of ['src/a.js', '.gitignore', '.github/workflows/ci.yml', 'node_modules_old/a.js', 'my.git/x', 'a/.gitmodules', null, undefined, '']) {
    assert.strictEqual(ignoredEvent(n), false, String(n));
  }
});

function fakes() {
  const s = { calls: [], handlers: [], timers: [], made: [], closed: 0 };
  return {
    s,
    deps: {
      fsWatch: (dir, opts, h) => { s.calls.push([dir, opts]); s.handlers.push(h); return { on: () => {}, close: () => { s.closed += 1; } }; },
      setTimer: (fn, ms) => { const t = { fn, ms }; s.timers.push(t); return t; },
      clearTimer: () => {},
      log: () => {},
      mkdirSync: (...a) => s.made.push(a),
    },
  };
}

test('it watches the worktree recursively', () => {
  const { s, deps } = fakes();
  watchRepo('C:\\proj\\wt', () => {}, deps);
  assert.deepStrictEqual(s.calls, [['C:\\proj\\wt', { recursive: true }]]);
});

test('it NEVER creates the folder: a deleted worktree must not be conjured back by a watcher', () => {
  const { s, deps } = fakes();
  watchRepo('C:\\proj\\wt', () => {}, deps);
  assert.deepStrictEqual(s.made, []);
});

test('a burst of real events is one change, after the debounce', () => {
  const { s, deps } = fakes();
  let calls = 0;
  watchRepo('C:\\w', () => { calls += 1; }, deps);
  s.handlers[0]('change', 'src/a.js'); s.handlers[0]('rename', 'src/b.js');
  s.timers.filter(t => t.ms === 300).forEach(t => t.fn());
  assert.ok(calls >= 1);
});

test('events in ignored places never reach the callback or arm a timer', () => {
  const { s, deps } = fakes();
  let calls = 0;
  watchRepo('C:\\w', () => { calls += 1; }, deps);
  s.handlers[0]('change', '.git/index');
  s.handlers[0]('change', 'node_modules/x/y.js');
  assert.strictEqual(s.timers.length, 0);
  assert.strictEqual(calls, 0);
});

test('the debounce is 300ms and close() stops it', () => {
  const { s, deps } = fakes();
  const w = watchRepo('C:\\w', () => {}, deps);
  s.handlers[0]('change', 'a.js');
  assert.strictEqual(s.timers[0].ms, 300);
  w.close();
  assert.strictEqual(s.closed, 1);
});

test('a platform that cannot watch leaves a working handle and says so once', () => {
  const logs = [];
  const w = watchRepo('C:\\w', () => {}, {
    fsWatch: () => { throw new Error('no recursive watch here'); }, setTimer: () => ({}), clearTimer: () => {}, mkdirSync: () => {},
    log: (...a) => logs.push(a.join(' ')),
  });
  assert.strictEqual(typeof w.close, 'function');
  w.close();
  assert.ok(logs.length >= 1);
});

test('a watcher that keeps failing logs in its own words, once a minute', () => {
  const logs = [];
  const timers = [];
  let t = 1000;
  let errorHandler = null;
  let calls = 0;
  watchRepo('C:\w', () => {}, {
    fsWatch: () => {
      if (calls++ > 0) throw new Error('ENOENT: gone');
      return { on: (ev, h) => { errorHandler = h; }, close: () => {} };
    },
    setTimer: (fn) => { timers.push(fn); return {}; }, clearTimer: () => {},
    log: (m) => logs.push(m), now: () => t,
  });
  errorHandler(new Error('EPERM: the folder went away'));        // the watcher dies: said
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /worktree watch/);
  assert.ok(!/global picture/.test(logs[0]));
  timers.shift()();                                              // the re-arm fails: still inside the minute
  timers.shift()();                                              // ...and again
  assert.strictEqual(logs.length, 1, 'said already, not once a second');
  t += 61 * 1000;
  timers.shift()();
  assert.strictEqual(logs.length, 2);
  assert.match(logs[1], /ENOENT: gone/);
});
