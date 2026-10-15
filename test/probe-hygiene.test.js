'use strict';
/**
 * Process hygiene for verify/ probes that suspend a real process or spawn a
 * real `claude` session (probe-pause.js, probe-local-model.js).
 *
 * Written against Miguel's PR #61 review (H1/H2/H3): a probe's own `finally`
 * block is not enough, because Node's default SIGINT handling terminates
 * immediately and skips every pending `finally` -- exactly the moment an
 * operator watching a ~20s suspend window is most likely to press Ctrl+C.
 * These pin the three things the review asked to be pinned:
 *   1. the emergency-cleanup registry resumes every recorded suspended pid
 *      and kills every recorded spawned tree (createHygieneRegistry).
 *   2. a spawn timeout kills the whole process tree, not just the top pid
 *      (spawnWithTimeout, the fix for H3).
 *   3. a bind failure on the fake Anthropic-compatible server yields a
 *      rejected promise (a SKIP line), not an uncaught 'error' throw (L1).
 *
 * None of these spawn a real `claude` session or the real Windows
 * NtSuspendProcess/pssuspend primitives -- those are exercised by actually
 * running the probes (see their own RESULTS blocks). This file is scoped to
 * the pure, injectable cleanup/kill logic around them.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createHygieneRegistry } = require('../verify/lib/process-hygiene');
const { spawnWithTimeout } = require('../verify/lib/spawn-with-timeout');
const { startFakeServer } = require('../verify/probe-local-model');
const { killTree } = require('../host/kill-tree');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('hygiene registry resumes every recorded suspended pid on emergency cleanup', () => {
  const resumed = [];
  const registry = createHygieneRegistry({ killFn: () => {} });
  registry.setResumeFn((pid) => resumed.push(pid));

  registry.registerSuspended(111);
  registry.registerSuspended(222);
  registry.registerSuspended(333);

  const { resumed: reported } = registry._emergencyCleanup('test');

  assert.deepStrictEqual(resumed.sort(), [111, 222, 333]);
  assert.deepStrictEqual(reported.slice().sort(), [111, 222, 333]);
  assert.strictEqual(registry._suspendedPids.size, 0, 'cleared after resuming, not left registered');
});

test('hygiene registry kills every recorded spawned tree on emergency cleanup', () => {
  const killed = [];
  const registry = createHygieneRegistry({ killFn: (pid) => killed.push(pid) });
  registry.setResumeFn(() => {});

  registry.registerSpawnedTree(444);
  registry.registerSpawnedTree(555);

  const { killed: reported } = registry._emergencyCleanup('test');

  assert.deepStrictEqual(killed.sort(), [444, 555]);
  assert.deepStrictEqual(reported.slice().sort(), [444, 555]);
  assert.strictEqual(registry._spawnedTrees.size, 0, 'cleared after killing, not left registered');
});

test('hygiene registry does both at once, and a resume/kill failure does not stop the rest', () => {
  const resumed = [];
  const killed = [];
  let calls = 0;
  const registry = createHygieneRegistry({
    killFn: (pid) => { killed.push(pid); },
  });
  registry.setResumeFn((pid) => {
    calls++;
    if (pid === 'bad') throw new Error('resume failed');
    resumed.push(pid);
  });

  registry.registerSuspended('bad');
  registry.registerSuspended('good');
  registry.registerSpawnedTree(999);

  registry._emergencyCleanup('test');

  assert.strictEqual(calls, 2, 'both suspended pids were attempted despite the first throwing');
  assert.deepStrictEqual(resumed, ['good']);
  assert.deepStrictEqual(killed, [999]);
});

test('a resumeFn that returns false WITHOUT throwing is treated as a failure, not a success (Dexter finding 4)', () => {
  // The real resumeFn (probe-pause.js's `ntAction`-backed one) never throws
  // -- it reports failure via a return value. A resumeFn that only handled
  // thrown errors would silently treat this as "resumed".
  const registry = createHygieneRegistry({ killFn: () => {} });
  registry.setResumeFn(() => false);
  registry.registerSuspended(777);

  const result = registry._emergencyCleanup('test');

  assert.deepStrictEqual(result.resumed, [], 'a falsy return must not count as resumed');
  assert.deepStrictEqual(result.failedToResume, [777]);
  assert.ok(registry._suspendedPids.has(777), 'left registered after a failed (non-throwing) resume, so a later cleanup retries it');
});

test('probe-pause.js wires its real resumeFn to report failure honestly when the real ntAction fails (no mocking of ntAction itself)', { skip: process.platform !== 'win32' && 'ntAction shells out to powershell/NtResumeProcess, Windows-only' }, () => {
  const probePause = require('../verify/probe-pause');
  const bogusPid = 999999999; // far outside any real pid range on this machine
  probePause.hygiene.registerSuspended(bogusPid);

  const result = probePause.hygiene._emergencyCleanup('test-nonexistent-pid');

  assert.deepStrictEqual(result.resumed, []);
  assert.deepStrictEqual(result.failedToResume, [bogusPid]);
  assert.ok(probePause.hygiene._suspendedPids.has(bogusPid),
    'a real OpenProcess failure must leave the pid registered, not silently clear it');
});

test('clearSuspended/unregisterSpawnedTree remove an entry BEFORE cleanup runs, so a normal finally that already handled it is not double-acted-on', () => {
  const resumed = [];
  const killed = [];
  const registry = createHygieneRegistry({ killFn: (pid) => killed.push(pid) });
  registry.setResumeFn((pid) => resumed.push(pid));

  registry.registerSuspended(1);
  registry.registerSpawnedTree(2);
  registry.clearSuspended(1);
  registry.unregisterSpawnedTree(2);

  registry._emergencyCleanup('test');

  assert.deepStrictEqual(resumed, []);
  assert.deepStrictEqual(killed, []);
});

test('install() registers exactly one SIGINT/uncaughtException/unhandledRejection listener each, and is idempotent', () => {
  const registry = createHygieneRegistry({ killFn: () => {} });
  registry.setResumeFn(() => {});
  const before = {
    sigint: process.listenerCount('SIGINT'),
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  registry.install();
  registry.install(); // idempotent: a second call must not double-register
  assert.strictEqual(process.listenerCount('SIGINT'), before.sigint + 1);
  assert.strictEqual(process.listenerCount('uncaughtException'), before.uncaught + 1);
  assert.strictEqual(process.listenerCount('unhandledRejection'), before.rejection + 1);
  registry._uninstall();
  assert.strictEqual(process.listenerCount('SIGINT'), before.sigint);
  assert.strictEqual(process.listenerCount('uncaughtException'), before.uncaught);
  assert.strictEqual(process.listenerCount('unhandledRejection'), before.rejection);
});

// --- H3: the spawn-timeout path tree-kills, it does not bare-kill ------------

test('spawnWithTimeout tree-kills (via the injected killFn) when the child outlives timeoutMs', async () => {
  const killedPids = [];
  const r = await spawnWithTimeout({
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], // never exits on its own
    timeoutMs: 300,
    killFn: (pid) => { killedPids.push(pid); process.kill(pid, 'SIGTERM'); },
  });
  assert.strictEqual(r.timedOut, true);
  assert.deepStrictEqual(killedPids, [r.pid]);
});

test('spawnWithTimeout does NOT call killFn when the child exits on its own before the timeout', async () => {
  const killedPids = [];
  const r = await spawnWithTimeout({
    cmd: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 5000,
    killFn: (pid) => killedPids.push(pid),
  });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(killedPids, []);
});

// --- Finding 6: killTree itself was never directly unit-tested --------------

test('killTree does nothing when the child has already exited (exitCode !== null)', () => {
  let spawnFnCalls = 0;
  killTree({ exitCode: 0, pid: 123, kill() {} }, { spawnFn: () => { spawnFnCalls++; } });
  assert.strictEqual(spawnFnCalls, 0);
});

test('killTree(win32): spawns taskkill, and falls back to child.kill(SIGTERM) only if taskkill itself fails to spawn', {
  skip: process.platform !== 'win32' && 'this branch of killTree only runs on win32',
}, () => {
  const { EventEmitter } = require('node:events');
  let killedWith = null;
  const fakeChild = { exitCode: null, pid: 4242, kill(sig) { killedWith = sig; } };
  let spawnArgs = null;
  const fakeKiller = new EventEmitter();
  const spawnFn = (cmd, args, opts) => { spawnArgs = [cmd, args, opts]; return fakeKiller; };

  killTree(fakeChild, { spawnFn });
  assert.deepStrictEqual(spawnArgs[0], 'taskkill');
  assert.deepStrictEqual(spawnArgs[1], ['/PID', '4242', '/T', '/F']);
  assert.strictEqual(killedWith, null, 'no fallback yet -- taskkill has not reported an error');

  fakeKiller.emit('error', { message: 'ENOENT' });
  assert.strictEqual(killedWith, 'SIGTERM', 'falls back to child.kill once taskkill reports it could not even be spawned');
});

test('killTree(win32): does NOT fall back to child.kill when taskkill spawns without error', {
  skip: process.platform !== 'win32' && 'this branch of killTree only runs on win32',
}, () => {
  const { EventEmitter } = require('node:events');
  let killedWith = null;
  const fakeChild = { exitCode: null, pid: 4343, kill(sig) { killedWith = sig; } };
  const spawnFn = () => new EventEmitter(); // never emits 'error'

  killTree(fakeChild, { spawnFn });
  assert.strictEqual(killedWith, null);
});

test('killTree(non-win32): calls child.kill(SIGTERM) directly, without touching spawnFn at all', () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    let killedWith = null;
    let spawnFnCalls = 0;
    const fakeChild = { exitCode: null, pid: 5454, kill(sig) { killedWith = sig; } };
    killTree(fakeChild, { spawnFn: () => { spawnFnCalls++; } });
    assert.strictEqual(killedWith, 'SIGTERM');
    assert.strictEqual(spawnFnCalls, 0);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
});

// --- L1: a fake-server bind failure is a SKIP, not a crash -------------------

test('startFakeServer rejects on a genuine bind failure instead of throwing an uncaught error event', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const takenPort = blocker.address().port;

  await assert.rejects(
    () => startFakeServer('token-for-bind-failure-test', { port: takenPort }),
    /fake server failed to bind/,
  );

  await new Promise((resolve) => blocker.close(resolve));
});

test('startFakeServer resolves normally on port 0 (the real, non-test default)', async () => {
  const fake = await startFakeServer('token-for-normal-bind-test');
  assert.strictEqual(typeof fake.port, 'number');
  assert.ok(fake.port > 0);
  await new Promise((resolve) => fake.server.close(resolve));
});

// requiring verify/probe-pause.js (above, for the resumeFn wiring test)
// writes its NT_HELPER_PS1 temp file as a module-load side effect, which
// that module only cleans up under its own require.main === module guard --
// never reached when this test file requires it as a library. Small and
// harmless either way, but this is the file this whole PR is about not
// leaving stray artifacts behind.
test.after(() => {
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith('claude-custom-probe-pause-nt-')) fs.unlinkSync(path.join(os.tmpdir(), f));
    }
  } catch { /* best effort */ }
});
