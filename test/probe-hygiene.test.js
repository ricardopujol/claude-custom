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

const { createHygieneRegistry } = require('../verify/lib/process-hygiene');
const { spawnWithTimeout } = require('../verify/lib/spawn-with-timeout');
const { startFakeServer } = require('../verify/probe-local-model');

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

test('spawnWithTimeout, with NO killFn passed, actually kills the hung child via the real default (host/kill-tree.js killPidTree)', async () => {
  // No injected killFn here -- this is the exact call shape
  // probe-local-model.js's runClaudeAttempt uses. Pins that the DEFAULT is
  // the real tree-kill helper end to end: the child must actually be dead
  // afterward, not just that some callback fired.
  const r = await spawnWithTimeout({
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 300,
  });
  assert.strictEqual(r.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 300)); // taskkill/SIGTERM needs a moment to land
  assert.throws(() => process.kill(r.pid, 0), /ESRCH|No such process/,
    'the hung child should be dead after the default kill path ran');
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
