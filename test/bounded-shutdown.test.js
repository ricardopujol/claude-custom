'use strict';
// BACKLOG #121: a host told to stop exits even when its pty teardown blocks, and what it holds (the session lock, the identity file)
// outlives the pty (PR #217 Dexter F1, F2). The teardown is synchronous native work (PowerShell, node-pty's kill), so a JS timer can't
// bound it: the watchdog is a separate process (a worker thread doesn't start while the main thread is blocked), and the tests below
// block a real process's event loop to prove it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const { runShutdown, SHUTDOWN_BOUND_MS } = require('../host/bounded-shutdown');
const { createWatchdog } = require('../host/bounded-watchdog');
const { killProven, KILL_PROVEN_TIMEOUT_MS } = require('../host/kill-tree');

const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the steps run in order, the watchdog is armed before the first and disarmed after the last', () => {
  const calls = [];
  runShutdown({
    steps: [() => calls.push('pty'), () => calls.push('servers'), () => calls.push('lock'), () => calls.push('identity')],
    arm: (ms) => { calls.push('arm:' + ms); return () => calls.push('disarm'); },
  });
  assert.deepStrictEqual(calls, ['arm:' + SHUTDOWN_BOUND_MS, 'pty', 'servers', 'lock', 'identity', 'disarm']);
});

test('the lock and the identity file still exist while a slow pty teardown runs, and are gone after it', () => {
  const dir = tmpDir('cc-bounded-');
  const lock = path.join(dir, 'lock.json');
  const identity = path.join(dir, 'host.json');
  fs.writeFileSync(lock, '{}'); fs.writeFileSync(identity, '{}');
  const seen = {};
  runShutdown({
    steps: [
      () => { seen.lockDuring = fs.existsSync(lock); seen.identityDuring = fs.existsSync(identity); },   // the slow stopPty
      () => fs.unlinkSync(lock),
      () => fs.unlinkSync(identity),
    ],
    arm: () => () => {},
  });
  assert.deepStrictEqual(seen, { lockDuring: true, identityDuring: true });
  assert.strictEqual(fs.existsSync(lock) || fs.existsSync(identity), false);
});

test('host.js: shutdown() ends the pty before it releases the lock or the identity file, all under the watchdog', () => {
  const down = HOST_SRC.slice(HOST_SRC.indexOf('function shutdown({ removeIdentity = true } = {}) {'), HOST_SRC.indexOf("process.on('SIGINT'"));
  const pty = down.indexOf('stopPty(term, { killChildTree })');
  assert.ok(pty > 0);
  assert.ok(pty < down.indexOf('releaseSessionLock('));
  assert.ok(pty < down.indexOf('fs.unlinkSync(fileFor('));
  assert.match(down, /runShutdown\(\{/);
});

test('a step that throws never skips the others', () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), (throwing) => {
    let ran = 0;
    runShutdown({ steps: throwing.map((t) => () => { ran += 1; if (t) throw new Error('x'); }), arm: () => () => {} });
    assert.strictEqual(ran, throwing.length);
  }));
});

test('the bound is above every timeout inside the teardown it covers, with margin (PR #217 Dexter F3)', () => {
  assert.ok(SHUTDOWN_BOUND_MS >= KILL_PROVEN_TIMEOUT_MS + 10000);
  let seen = null;
  killProven(4242, '133000000000000000', { run: (_exe, _args, opts) => { seen = opts.timeout; return { stdout: 'GONE\n' }; } });
  assert.strictEqual(seen, KILL_PROVEN_TIMEOUT_MS, 'the timeout the bound is derived from is the one killProven really uses');
});

test('watchdog: waits inside the bound, and a host that left is simply left', () => {
  let t = 0; const log = []; let alive = true; const proven = [];
  const wd = createWatchdog({ pid: 7, boundMs: 100, start: '5', now: () => t, alive: () => alive, killProven: (...a) => { proven.push(a); return 'killed'; }, log: (l) => log.push(l) });
  t = 99; assert.strictEqual(wd.tick(), 'wait');
  alive = false; t = 500; assert.strictEqual(wd.tick(), 'exit');
  assert.deepStrictEqual([proven.length, log.length], [0, 0]);
});

test('watchdog: past the bound it kills only through the proof, with the start time it was armed with', () => {
  let t = 0; const log = []; const proven = [];
  const wd = createWatchdog({ pid: 7, boundMs: 100, start: '5', now: () => t, alive: () => true, killProven: (...a) => { proven.push(a); return 'killed'; }, log: (l) => log.push(l) });
  t = 100;
  assert.strictEqual(wd.tick(), 'exit');
  assert.deepStrictEqual(proven, [[7, '5']]);
  assert.match(log[0], /did not finish within 100 ms/);
});

test('watchdog: a reused pid (the proof says mismatch) is never killed, and says so', () => {
  let t = 0; const log = [];
  const wd = createWatchdog({ pid: 7, boundMs: 100, start: '5', now: () => t, alive: () => true, killProven: () => 'mismatch', log: (l) => log.push(l) });
  t = 1000;
  assert.strictEqual(wd.tick(), 'exit');
  assert.ok(log.some((l) => /reused\); left alone/.test(l)));
});

test('watchdog: with no start time, or a proof it could not judge, it kills nothing', () => {
  for (const [start, outcome] of [[null, 'killed'], ['5', 'unknown'], ['5', 'failed']]) {
    let t = 0; const log = []; let calls = 0;
    const wd = createWatchdog({ pid: 7, boundMs: 100, start, now: () => t, alive: () => true, killProven: () => { calls += 1; return outcome; }, log: (l) => log.push(l) });
    t = 1000;
    assert.strictEqual(wd.tick(), 'exit');
    if (start === null) assert.strictEqual(calls, 0);
    assert.ok(log.some((l) => /could not prove/.test(l)), `${start}/${outcome}`);
  }
});

test('watchdog: its default clock is monotonic, a wall-clock step of an hour does not cut a healthy stop short (PR #217 Dexter F5)', () => {
  const realNow = Date.now;
  try {
    const wd = createWatchdog({ pid: 7, boundMs: 30000, start: '5', alive: () => true, killProven: () => { throw new Error('must not kill'); } });
    Date.now = () => realNow() + 3600 * 1000;
    assert.strictEqual(wd.tick(), 'wait');
  } finally { Date.now = realNow; }
});

test('host.js: the kill switch stopper gets the bounded stopPty, not the bare one', () => {
  const stopper = HOST_SRC.slice(HOST_SRC.indexOf('const killStop = createStopper({'), HOST_SRC.indexOf('const killSwitch = watchKillSwitch'));
  assert.match(stopper, /stopPty: boundedStopPty,/);
  assert.match(HOST_SRC, /const boundedStopPty = \(t, opts\) => runShutdown\(\{[^\n]*steps: \[\(\) => stopPty\(t, opts\)\]/);
});
