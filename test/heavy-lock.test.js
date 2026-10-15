'use strict';
/**
 * host/heavy-lock.js (BACKLOG #100 d): the wrapper around the machine-wide heavy-work lock script. Nothing here touches
 * the real lock: the script call (`run`), the existence check and the process are all injected.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { acquire, release, createProcessLock, HeavyLockError, ENV_VAR, DEFAULT_SCRIPT, ownerFor } = require('../host/heavy-lock');

function rig({ acquireStatus = 0, acquireOut = 'acquired: x', releaseStatus = 0, exists = true } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('-Acquire')) return { status: acquireStatus, stdout: acquireOut };
    return { status: releaseStatus, stdout: 'released' };
  };
  return { calls, run, exists: () => exists, env: {}, log: [] };
}
const deps = (r) => ({ run: r.run, exists: r.exists, env: r.env, log: (m) => r.log.push(m) });
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const releases = (r) => r.calls.filter(c => c.includes('-Release')).length;

test('the default script is the shared one in ~/.claude/scripts', () => {
  assert.match(DEFAULT_SCRIPT.replace(/\\/g, '/'), /\/\.claude\/scripts\/heavy-lock\.ps1$/);
});

test('ownerFor names the label and the pid, closed so one pid is not a prefix of another', () => {
  assert.strictEqual(ownerFor('npm test', 12), 'npm test (pid 12)');
  assert.ok(!ownerFor('a', 12).startsWith(ownerFor('a', 1)));
});

test('held: acquires with its owner, sets the re-entrancy flag, and release uses the same owner', () => {
  const r = rig();
  const lock = acquire({ label: 'npm test', pid: 7, ...deps(r) });
  assert.strictEqual(lock.state, 'held');
  assert.strictEqual(flagValue(r.calls[0], '-Owner'), 'npm test (pid 7)');
  assert.strictEqual(r.env[ENV_VAR], '1');
  assert.strictEqual(lock.release(), true);
  assert.ok(r.calls[1].includes('-Release'));
  assert.strictEqual(flagValue(r.calls[1], '-Owner'), 'npm test (pid 7)');
  assert.strictEqual(r.env[ENV_VAR], undefined, 'the flag goes with the lock');
});

test('release is idempotent: the second call does not run the script again', () => {
  const r = rig();
  const lock = acquire({ label: 'x', pid: 1, ...deps(r) });
  lock.release(); lock.release();
  assert.strictEqual(releases(r), 1);
});

test('re-entrant: the flag is set, so nothing is acquired and release is a no-op', () => {
  const r = rig();
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 1, ...deps(r) });
  assert.strictEqual(lock.state, 'reentrant');
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(lock.release(), false);
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.env[ENV_VAR], '1', 'a lock we did not take is not cleared');
});

test('script missing: runs without the lock, one warning line', () => {
  const r = rig({ exists: false });
  const lock = acquire({ label: 'x', pid: 1, ...deps(r) });
  assert.strictEqual(lock.state, 'missing');
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.log.length, 1);
  assert.match(r.log[0], /heavy-lock\.ps1 not found/);
  assert.strictEqual(lock.release(), false);
});

test('busy (exit 2): throws with the holder, and never reports held', () => {
  const r = rig({ acquireStatus: 2, acquireOut: 'busy: hub: probes (since 10:00:00)' });
  assert.throws(() => acquire({ label: 'x', pid: 1, ...deps(r) }), (e) => e instanceof HeavyLockError && e.code === 'busy' && /hub: probes/.test(e.message));
  assert.strictEqual(r.env[ENV_VAR], undefined);
});

test('too loaded (exit 3): throws', () => {
  const r = rig({ acquireStatus: 3, acquireOut: 'machine too loaded: 4 GB free, 90% CPU' });
  assert.throws(() => acquire({ label: 'x', pid: 1, ...deps(r) }), (e) => e.code === 'loaded' && /too loaded/.test(e.message));
});

test('any other exit (or no exit status) throws too: it never runs anyway', () => {
  for (const status of [1, null]) {
    const r = rig({ acquireStatus: status, acquireOut: '' });
    assert.throws(() => acquire({ label: 'x', pid: 1, ...deps(r) }), (e) => e.code === 'error');
  }
});

test('wait minutes are passed through to the script', () => {
  const r = rig();
  acquire({ label: 'x', pid: 1, waitMinutes: 5, ...deps(r) });
  assert.strictEqual(flagValue(r.calls[0], '-WaitMinutes'), '5');
});

test('a release that the script refuses is reported false, not thrown', () => {
  const r = rig({ releaseStatus: 2 });
  const lock = acquire({ label: 'x', pid: 1, ...deps(r) });
  assert.strictEqual(lock.release(), false);
  assert.ok(r.log.some(m => /could not release/.test(m)));
});

test('release() as a function runs the script with the owner', () => {
  const r = rig();
  assert.strictEqual(release({ owner: 'o (pid 1)', run: r.run, log: () => {} }), true);
  assert.strictEqual(flagValue(r.calls[0], '-Owner'), 'o (pid 1)');
});

// ---- the process-wide lock a probe takes on its first launch ----
function procRig(over = {}) {
  const r = rig(over);
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = (c) => proc.exits.push(c);
  proc.pid = 99;
  return { r, proc, lock: createProcessLock({ proc, label: 'probe-x', ...deps(r) }) };
}

test('process lock: the first ensure() takes it, the second does nothing', () => {
  const { r, lock } = procRig();
  lock.ensure(); lock.ensure();
  assert.strictEqual(r.calls.filter(c => c.includes('-Acquire')).length, 1);
});

test('process lock: released on normal process exit', () => {
  const { r, proc, lock } = procRig();
  lock.ensure();
  proc.emit('exit', 0);
  assert.strictEqual(releases(r), 1);
});

test('process lock: released on a failing process exit too', () => {
  const { r, proc, lock } = procRig();
  lock.ensure();
  proc.emit('exit', 1);
  assert.strictEqual(releases(r), 1);
});

test('process lock: released on SIGINT / SIGTERM / SIGHUP, then the process exits with the signal code', () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 143]]) {
    const { r, proc, lock } = procRig();
    lock.ensure();
    proc.emit(sig);
    assert.strictEqual(releases(r), 1, sig);
    assert.deepStrictEqual(proc.exits, [code], sig);
    proc.emit('exit', code);
    assert.strictEqual(releases(r), 1, sig + ': not released twice');
  }
});

test('process lock: a probe with its own SIGINT handler keeps control of its exit, the lock is still released', () => {
  const { r, proc, lock } = procRig();
  lock.ensure();
  proc.on('SIGINT', () => {});
  proc.emit('SIGINT');
  assert.strictEqual(releases(r), 1);
  assert.deepStrictEqual(proc.exits, []);
});

test('process lock: busy throws from ensure() and installs no hooks, and a later ensure() tries again', () => {
  const { r, proc, lock } = procRig({ acquireStatus: 2, acquireOut: 'busy: hub' });
  assert.throws(() => lock.ensure(), HeavyLockError);
  assert.strictEqual(proc.listenerCount('exit'), 0);
  assert.throws(() => lock.ensure(), HeavyLockError);
  assert.strictEqual(r.calls.filter(c => c.includes('-Acquire')).length, 2);
});

test('process lock: re-entrant and missing install no hooks', () => {
  const a = procRig(); a.r.env[ENV_VAR] = '1'; a.lock.ensure();
  assert.strictEqual(a.proc.listenerCount('exit'), 0);
  const b = procRig({ exists: false }); b.lock.ensure(); b.lock.ensure();
  assert.strictEqual(b.proc.listenerCount('exit'), 0);
  assert.strictEqual(b.r.log.length, 1, 'the missing-script warning is said once');
});
