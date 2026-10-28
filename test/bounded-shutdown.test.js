'use strict';
// BACKLOG #121: a host told to stop exits even when its pty teardown blocks, and what it holds (the session lock, the identity file)
// outlives the pty (PR #217 Dexter F1, F2). The teardown is synchronous native work (PowerShell, node-pty's kill), so a JS timer can't
// bound it: the watchdog is a separate process (a worker thread doesn't start while the main thread is blocked), and the tests below
// block a real process's event loop to prove it.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const { runShutdown, armWatchdog, SHUTDOWN_BOUND_MS } = require('../host/bounded-shutdown');
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

// A process that arms the watchdog with its own start time, then runs `steps` (source text), as the host does.
function runBlocked(dir, body) {
  const script = `
    (async () => {
      const fs = require('fs');
      const { runShutdown } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'bounded-shutdown'))});
      const start = await require(${JSON.stringify(path.join(__dirname, '..', 'host', 'proc-start'))}).createSelfStartTime()();
      ${body}
    })();
  `;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => {
    const guard = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: 'HUNG', ms: Date.now() - t0 }); }, 15000);   // kill-ok(held-handle): the child this test spawned
    child.on('exit', (c) => { clearTimeout(guard); resolve({ code: c === null ? 'killed' : c, ms: Date.now() - t0 }); });
  });
}

const BLOCK = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";   // never returns

test('a host whose teardown blocks the event loop for good exits within the bound, and the steps after the block never run', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const marks = path.join(dir, 'marks.txt');
  const { code, ms } = await runBlocked(dir, `
    runShutdown({ boundMs: 400, logFile: ${JSON.stringify(logFile)}, start, steps: [
      () => fs.appendFileSync(${JSON.stringify(marks)}, 'pty-started\\n'),
      () => { ${BLOCK} },
      () => fs.appendFileSync(${JSON.stringify(marks)}, 'REACHED-AFTER-TEARDOWN\\n'),
    ] });`);
  assert.notStrictEqual(code, 'HUNG', 'the process must end by itself');
  assert.ok(ms < 14000);
  const m = fs.readFileSync(marks, 'utf8');
  assert.match(m, /pty-started/);
  assert.doesNotMatch(m, /REACHED-AFTER-TEARDOWN/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /\[host\] shutdown: the shutdown did not finish within 400 ms; exiting anyway/);
});

test('the kill switch stopper\'s kill is bounded too: a blocking stopPty under the same watchdog still ends the host (PR #217 Dexter F4)', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const { code } = await runBlocked(dir, `
    const { createStopper } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'kill-switch'))});
    const bounded = (t, o) => runShutdown({ boundMs: 400, logFile: ${JSON.stringify(logFile)}, start, steps: [() => { ${BLOCK} }] });
    createStopper({ term: () => ({ pid: 1 }), stopPty: bounded, killChildTree: () => {} }).stop({ kind: 'tripped', sentinel: 's', scope: 'all' });
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'after.txt'))}, 'REACHED');`);
  assert.notStrictEqual(code, 'HUNG');
  assert.strictEqual(fs.existsSync(path.join(dir, 'after.txt')), false);
  assert.match(fs.readFileSync(logFile, 'utf8'), /did not finish within 400 ms/);
});

test('host.js: the kill switch stopper gets the bounded stopPty, not the bare one', () => {
  const stopper = HOST_SRC.slice(HOST_SRC.indexOf('const killStop = createStopper({'), HOST_SRC.indexOf('const killSwitch = watchKillSwitch'));
  assert.match(stopper, /stopPty: boundedStopPty,/);
  assert.match(HOST_SRC, /const boundedStopPty = \(t, opts\) => runShutdown\(\{[^\n]*steps: \[\(\) => stopPty\(t, opts\)\]/);
});

test('a disarmed watchdog ends and leaves the process it guarded alone, well past its bound (Miguel 1)', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const disarm = armWatchdog({ boundMs: 150, logFile, pid: guarded.pid });
    assert.ok(Number.isInteger(disarm.pid), 'the disarm handle names the watchdog');
    disarm();
    // The watchdog must be GONE (not merely quiet): poll for its exit, well past startup under load.
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const until = Date.now() + 5000;
    while (alive(disarm.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(alive(disarm.pid), false, 'the watchdog exited after disarm');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(guarded.exitCode, null);
    assert.strictEqual(fs.existsSync(logFile), false);
  } finally {
    guarded.kill();   // kill-ok(held-handle): the child this test spawned
  }
});
