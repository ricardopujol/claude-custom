'use strict';
/**
 * host/heavy-lock.js (BACKLOG #100 d): the wrapper around the machine-wide heavy-work lock script. Nothing here touches
 * the real lock or starts powershell: the script call (`run`), spawn, the existence check, the start-time query and the
 * process are all injected. The fake script below keeps a holder the way heavy-lock.ps1 does (status, acquire, release).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const EventEmitter = require('node:events');
const { tmpDir } = require('./tmp-dir');
const {
  acquire, release, createProcessLock, HeavyLockError, ENV_VAR, WAIT_VAR, DEFAULT_SCRIPT, DEFAULT_WAIT_MINUTES,
  ownerFor, parseOwner, defaultRun, queryStarts, createWorkStore, STATUS_TIMEOUT_MS, NOT_RUN_EXIT, notRunLine, startWatcher, WATCH_SCRIPT,
} = require('../host/heavy-lock');

// A stateful stand-in for heavy-lock.ps1. `holder` is what owner.txt would say; `alive` maps pid -> start time.
function rig({ holder = null, alive = {}, acquireOverride = null, releaseStatus = 0, exists = true, startsFail = false, work = null, workFails = false } = {}) {
  const r = { calls: [], env: {}, log: [], holder, alive: { 7: '100', 1: '100', 99: '100', ...alive }, exists: () => exists };
  r.run = (args) => {
    r.calls.push(args);
    if (args.includes('-Acquire')) {
      if (acquireOverride) return typeof acquireOverride === 'function' ? acquireOverride(r) : acquireOverride;
      if (r.holder) return { status: 2, stdout: `busy: ${r.holder}` };
      r.holder = `${args[args.indexOf('-Owner') + 1]} (since 10:00:00)`;
      return { status: 0, stdout: 'acquired' };
    }
    if (args.includes('-Release')) {
      const owner = args[args.indexOf('-Owner') + 1];
      if (releaseStatus !== 0) return { status: releaseStatus, stdout: 'held by someone else' };
      if (r.holder && !r.holder.startsWith(owner)) return { status: 2, stdout: `held by someone else: ${r.holder}` };
      r.holder = null;
      return { status: 0, stdout: 'released' };
    }
    return { status: 0, stdout: r.holder ? `held: ${r.holder}` : 'free' };
  };
  r.startsOf = (pids) => (startsFail ? null : new Map(pids.filter(p => r.alive[p] !== undefined).map(p => [p, r.alive[p]])));
  // The side file of recorded children, in memory: { owner, work: [{ pid, start }] } or null.
  r.work = work;
  r.workStore = {
    read: (h) => { if (workFails) throw new Error('unreadable'); return r.work && h.startsWith(r.work.owner) ? r.work.work : []; },
    add: (owner, pid, start) => { if (!r.work || r.work.owner !== owner) r.work = { owner, work: [] }; r.work.work = r.work.work.filter(w => w.pid !== pid); r.work.work.push({ pid, start }); },
    remove: (owner, pid) => { if (r.work && r.work.owner === owner) r.work.work = r.work.work.filter(w => w.pid !== pid); },
    clear: (h) => { if (r.work && h.startsWith(r.work.owner)) r.work = null; },
  };
  r.clock = { t: 0 };
  // watch: null. The real watcher is the default, so every unit test hands in null or a fake (#237 Miguel M2).
  r.deps = () => ({ run: r.run, exists: r.exists, env: r.env, log: (m) => r.log.push(m), startsOf: r.startsOf, work: r.workStore, now: () => r.clock.t, watch: null });
  return r;
}
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const of = (r, flag) => r.calls.filter(c => c.includes(flag));

test('the default script is the shared one in ~/.claude/scripts', () => {
  assert.match(DEFAULT_SCRIPT.replace(/\\/g, '/'), /\/\.claude\/scripts\/heavy-lock\.ps1$/);
});

test('ownerFor: label, pid and start, closed with a paren so one pid is not a prefix of another; no start, no start part', () => {
  assert.strictEqual(ownerFor('npm test', 12, '555'), 'npm test (pid 12 start 555)');
  assert.strictEqual(ownerFor('npm test', 12), 'npm test (pid 12)');
  assert.strictEqual(ownerFor('npm test', 12, 'x1'), 'npm test (pid 12)', 'a start that is not digits is not written');
  assert.ok(!ownerFor('a', 12, '5').startsWith(ownerFor('a', 1, '5').slice(0, -1) + ' '));
  assert.ok(!ownerFor('a', 12, '5').startsWith(ownerFor('a', 1, '5')));
});

test('parseOwner reads the pid and start from an owner, with or without the script\'s "(since ...)" tail', () => {
  assert.deepStrictEqual(parseOwner('npm test (pid 12 start 555) (since 10:00:00)'), { pid: 12, start: '555' });
  assert.strictEqual(parseOwner('hub: probes (since 10:00:00)'), null);
  assert.strictEqual(parseOwner('npm test (pid 12)'), null);
  assert.strictEqual(parseOwner(undefined), null);
});

test('held: the owner carries pid and start, the re-entrancy flag is set, and release uses the same owner', () => {
  const r = rig();
  const lock = acquire({ label: 'npm test', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'held');
  assert.strictEqual(flagValue(of(r, '-Acquire')[0], '-Owner'), 'npm test (pid 7 start 100)');
  assert.strictEqual(r.env[ENV_VAR], 'npm test (pid 7 start 100)', 'the flag is its own identity (#237 Dexter 2)');
  assert.strictEqual(lock.release(), true);
  assert.strictEqual(flagValue(of(r, '-Release')[0], '-Owner'), 'npm test (pid 7 start 100)');
  assert.strictEqual(r.env[ENV_VAR], undefined, 'the flag goes with the lock');
  assert.strictEqual(r.holder, null);
});

test('an own start time that cannot be read gives an owner without one (never a guess)', () => {
  const r = rig({ startsFail: true });
  acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(flagValue(of(r, '-Acquire')[0], '-Owner'), 'x (pid 7)');
});

test('release is idempotent: the second call does not run the script again', () => {
  const r = rig();
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  lock.release(); lock.release();
  assert.strictEqual(of(r, '-Release').length, 1);
});

// A live outer holder, as the wrapper's own owner looks in the script's status.
const OUTER = 'npm test (pid 1 start 100) (since 10:00:00)';
const OUTER_ID = 'npm test (pid 1 start 100)';   // the flag that holder sets for its children (#237 Dexter 2)

test('re-entrant: the flag names the live holder of the slot, so only its status is read and release is a no-op', () => {
  const r = rig({ holder: OUTER });
  r.env[ENV_VAR] = OUTER_ID;
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'reentrant');
  assert.deepStrictEqual(r.calls, [[]], 'one status read, no acquire, no release');
  assert.strictEqual(lock.release(), false);
  assert.strictEqual(r.env[ENV_VAR], OUTER_ID, 'a lock we did not take is not cleared');
  assert.strictEqual(r.holder, OUTER);
});

test('Dexter 4: "0", "false", "" and "true" are not "held": the lock is taken', () => {
  for (const v of ['0', 'false', '', 'true', ' 1']) {
    const r = rig();
    r.env[ENV_VAR] = v;
    const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
    assert.strictEqual(lock.state, 'held', JSON.stringify(v));
  }
});

test('script missing: runs without the lock, one warning line', () => {
  const r = rig({ exists: false });
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'missing');
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.log.length, 1);
  assert.match(r.log[0], /heavy-lock\.ps1 not found/);
  assert.strictEqual(lock.release(), false);
});

test('busy (exit 2): throws with the holder and what to do next, and never reports held', () => {
  const r = rig({ holder: 'hub: probes (since 10:00:00)' });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) =>
    e instanceof HeavyLockError && e.code === 'busy' && /hub: probes/.test(e.message) && /Retry later/.test(e.message)
    && !/set HEAVY_LOCK_HELD/.test(e.message), '#237 Miguel M5: retry later, and no variable offered as a way past it');
  assert.strictEqual(r.env[ENV_VAR], undefined);
  assert.strictEqual(of(r, '-Release').length, 0, 'a manual holder is never touched');
});

test('too loaded (exit 3): throws, with the same next step', () => {
  const r = rig({ acquireOverride: { status: 3, stdout: 'machine too loaded: 4 GB free, 90% CPU' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'loaded' && /too loaded/.test(e.message) && /Retry later/.test(e.message)
    && /neither HEAVY_LOCK_HELD nor HEAVY_LOCK_SCRIPT is a way past it/.test(e.message) && !/HEAVY_LOCK_HELD=1/.test(e.message));
});

test('any other exit (or no exit status) throws too: it never runs anyway', () => {
  for (const status of [1, null]) {
    const r = rig({ acquireOverride: { status, stdout: 'boom' } });
    assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'error' && /boom/.test(e.message));
  }
});

test('BACKLOG #178 b: wait defaults to 20 minutes (two ~8-minute suites ahead plus the load gate), and HEAVY_LOCK_WAIT_MINUTES changes it', () => {
  assert.strictEqual(DEFAULT_WAIT_MINUTES, 20);
  assert.ok(DEFAULT_WAIT_MINUTES >= 2 * 8 + 2, 'two full suites ahead, with margin');
  const a = rig(); acquire({ label: 'x', pid: 7, ...a.deps() });
  assert.strictEqual(flagValue(of(a, '-Acquire')[0], '-WaitMinutes'), '20');
  const b = rig(); b.env[WAIT_VAR] = '3'; acquire({ label: 'x', pid: 7, ...b.deps() });
  assert.strictEqual(flagValue(of(b, '-Acquire')[0], '-WaitMinutes'), '3');
  for (const bad of ['0', '-2', 'abc', '1.5', '']) {
    const c = rig(); c.env[WAIT_VAR] = bad; acquire({ label: 'x', pid: 7, ...c.deps() });
    assert.strictEqual(flagValue(of(c, '-Acquire')[0], '-WaitMinutes'), '20', bad);
  }
  const d = rig(); acquire({ label: 'x', pid: 7, waitMinutes: 5, ...d.deps() });
  assert.strictEqual(flagValue(of(d, '-Acquire')[0], '-WaitMinutes'), '5');
});

test('a release that the script refuses is reported false, not thrown', () => {
  const r = rig({ releaseStatus: 2 });
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.release(), false);
  assert.ok(r.log.some(m => /could not release/.test(m)));
});

test('release() as a function runs the script with the owner', () => {
  const r = rig();
  assert.strictEqual(release({ owner: 'o (pid 1)', run: r.run, log: () => {} }), true);
  assert.strictEqual(flagValue(r.calls[0], '-Owner'), 'o (pid 1)');
});

// ---- Dexter 1: a holder that was killed hard ----
const DEAD = 'npm test (pid 5000 start 777)';

test('Dexter 1: a holder whose process is gone is released by its exact owner string, said once, and the acquire succeeds', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  const lock = acquire({ label: 'npm test', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'held');
  const rel = of(r, '-Release')[0];
  assert.strictEqual(flagValue(rel, '-Owner'), `${DEAD} (since 09:00:00)`);
  assert.strictEqual(r.log.filter(m => /dead holder/.test(m)).length, 1);
  assert.match(r.holder, /^npm test \(pid 7 start 100\)/);
});

test('Dexter 1: a holder whose pid now has a different start time is dead too', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 5000: '888' } });
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...r.deps() }).state, 'held');
  assert.strictEqual(of(r, '-Release').length, 1);
});

test('Dexter 1: a live holder (same pid and start) is never touched', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 5000: '777' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0);
});

test('Dexter 1: a holder whose start is unreadable (running, access denied) is never touched', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  r.startsOf = (pids) => new Map(pids.map(p => [p, p === 5000 ? null : '100']));
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps(), startsOf: r.startsOf }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0);
});

test('Dexter 1: when the start-time query fails, "cannot tell" is never "dead"', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, startsFail: true });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0);
});

test('Dexter 1: a holder without the pid-and-start shape (a manual one) is never touched, even if a pid is in its text', () => {
  for (const holder of ['hub: probes (since 10:00:00)', 'npm test (pid 5000) (since 10:00:00)', 'me: pid 5000 start 777']) {
    const r = rig({ holder });
    assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy', holder);
    assert.strictEqual(of(r, '-Release').length, 0, holder);
  }
});

test('Dexter 1: a holder that dies DURING the wait is freed after the busy answer, and the acquire is tried again', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 5000: '777' } });
  let first = true;
  const run = r.run;
  r.run = (args) => {
    if (args.includes('-Acquire') && first) { first = false; const out = run(args); delete r.alive[5000]; return out; }
    return run(args);
  };
  const lock = acquire({ label: 'x', pid: 7, ...r.deps(), run: r.run });
  assert.strictEqual(lock.state, 'held');
  assert.strictEqual(of(r, '-Acquire').length, 2);
  assert.strictEqual(of(r, '-Release').length, 1);
});

test('Dexter 1: busy because of the queue ("n ahead") is not a dead holder: no status read, no release', () => {
  const r = rig({ acquireOverride: { status: 2, stdout: 'busy: 2 ahead in the queue' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0);
  assert.strictEqual(of(r, '-Acquire').length, 1);
});

test('Dexter 1: a dead holder that cannot be released (the script refuses) is not retried forever', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, releaseStatus: 2 });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.ok(of(r, '-Acquire').length <= 2);
});

// ---- the real runner (Miguel B1, I1, I2) ----
test('defaultRun: powershell by absolute path, the owner as ONE argv element, the script path, a timeout, stderr merged', () => {
  const seen = [];
  const spawnFn = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { status: 2, stdout: 'busy: x', stderr: 'warn y' }; };
  const run = defaultRun('C:/s/heavy-lock.ps1', { spawnFn, timeoutMs: 12345 });
  const out = run(['-Acquire', '-Owner', 'npm test (pid 7 start 100)', '-WaitMinutes', '8']);
  assert.ok(path.win32.isAbsolute(seen[0].cmd) || path.isAbsolute(seen[0].cmd), seen[0].cmd);
  assert.match(seen[0].cmd, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.deepStrictEqual(seen[0].args.slice(0, 5), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/s/heavy-lock.ps1']);
  assert.deepStrictEqual(seen[0].args.slice(5), ['-Acquire', '-Owner', 'npm test (pid 7 start 100)', '-WaitMinutes', '8']);
  assert.strictEqual(seen[0].opts.timeout, 12345);
  assert.strictEqual(seen[0].opts.windowsHide, true);
  assert.strictEqual(out.status, 2);
  assert.match(out.stdout, /busy: x/);
  assert.match(out.stdout, /warn y/);
});

test('defaultRun: a powershell that cannot start says why; a timeout says the signal', () => {
  const noStart = defaultRun('s', { spawnFn: () => ({ status: null, error: Object.assign(new Error('spawn blocked'), { code: 'EPERM' }) }) })(['-Release']);
  assert.strictEqual(noStart.status, null);
  assert.match(noStart.stdout, /EPERM/);
  assert.match(noStart.stdout, /spawn blocked/);
  const timedOut = defaultRun('s', { spawnFn: () => ({ status: null, signal: 'SIGTERM', stdout: '' }) })(['-Release']);
  assert.match(timedOut.stdout, /SIGTERM/);
});

test('acquire with the real runner and an injected spawn: the failure to start reaches the HeavyLockError message', () => {
  const spawnFn = () => ({ status: null, error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.throws(() => acquire({ label: 'x', pid: 7, exists: () => true, env: {}, log: () => {}, spawnFn, startsOf: () => new Map(), watch: null, work: createWorkStore(path.join(tmpDir('hl-enoent-'), 'w.json')) }),
    (e) => e.code === 'error' && /ENOENT/.test(e.message));
});

test('Miguel r2 N3 / #112 Dexter 2: -Acquire is killed at the wait plus one minute; status and release get their own 1-minute leash', () => {
  const seen = [];
  const spawnFn = (cmd, args, o) => { seen.push({ kind: args.includes('-Acquire') ? 'acquire' : args.includes('-Release') ? 'release' : 'status', t: o.timeout }); return { status: 0, stdout: 'free' }; };
  const lock = acquire({ label: 'x', pid: 7, waitMinutes: 3, exists: () => true, env: {}, log: () => {}, spawnFn, startsOf: () => new Map(), work: createWorkStore(path.join(tmpDir('hl-n3-'), 'w.json')), watch: null });
  lock.release();
  assert.deepStrictEqual(seen.map(s => s.kind), ['status', 'acquire', 'release']);
  assert.strictEqual(seen[1].t, 4 * 60000);
  assert.strictEqual(seen[0].t, STATUS_TIMEOUT_MS, 'a status call no longer inherits the long acquire timeout');
  assert.strictEqual(seen[2].t, STATUS_TIMEOUT_MS);
  assert.strictEqual(STATUS_TIMEOUT_MS, 60000);
});

test('queryStarts: absolute powershell, parses pid and start, a pid that is not listed is absent', () => {
  const seen = [];
  const spawnFn = (cmd, args, o) => { seen.push(cmd); return { status: 0, stdout: '\r\n7 12345\r\n8 ?\r\nEND\r\n' }; };
  const m = queryStarts([7, 8, 9], spawnFn);
  assert.match(seen[0], /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.strictEqual(m.get(7), '12345');
  assert.strictEqual(m.get(8), null);
  assert.strictEqual(m.has(9), false);
});

test('queryStarts: no END, an error or a throw is null (cannot tell)', () => {
  assert.strictEqual(queryStarts([7], () => ({ status: 0, stdout: '7 1\r\n' })), null);
  assert.strictEqual(queryStarts([7], () => ({ error: new Error('x'), stdout: 'END' })), null);
  assert.strictEqual(queryStarts([7], () => { throw new Error('x'); }), null);
  assert.deepStrictEqual([...queryStarts([], () => { throw new Error('never'); })], []);
});

// ---- the process-wide lock a probe takes at the start ----
function procRig(over = {}) {
  const r = rig(over);
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = (c) => proc.exits.push(c);
  proc.pid = 99;
  const order = [];
  const run = r.run;
  r.run = (args) => { if (args.includes('-Release')) order.push('release'); return run(args); };
  return { r, proc, order, lock: createProcessLock({ proc, label: 'probe-x.js', beforeRelease: () => order.push('stop'), ...r.deps(), run: r.run }) };
}

test('process lock: the first ensure() takes it, the second does nothing; the owner names the probe script', () => {
  const { r, lock } = procRig();
  lock.ensure(); lock.ensure();
  assert.strictEqual(of(r, '-Acquire').length, 1);
  assert.strictEqual(flagValue(of(r, '-Acquire')[0], '-Owner'), 'probe-x.js (pid 99 start 100)');
});

test('process lock: released on normal process exit, after the heavy work is stopped', () => {
  const { proc, order, lock } = procRig();
  lock.ensure();
  proc.emit('exit', 0);
  assert.deepStrictEqual(order, ['stop', 'release']);
});

test('process lock: released on a failing process exit too', () => {
  const { proc, order, lock } = procRig();
  lock.ensure();
  proc.emit('exit', 1);
  assert.deepStrictEqual(order, ['stop', 'release']);
});

test('process lock: SIGINT / SIGTERM / SIGHUP stop the work, release, then exit with the signal code; not released twice', () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 143]]) {
    const { proc, order, lock } = procRig();
    lock.ensure();
    proc.emit(sig);
    assert.deepStrictEqual(order, ['stop', 'release'], sig);
    assert.deepStrictEqual(proc.exits, [code], sig);
    proc.emit('exit', code);
    assert.deepStrictEqual(order.filter(o => o === 'release'), ['release'], sig + ': not released twice');
  }
});

test('process lock: a probe with its own SIGINT handler keeps its slot until its process really ends', () => {
  const { proc, order, lock } = procRig();
  lock.ensure();
  proc.on('SIGINT', () => {});
  proc.emit('SIGINT');
  assert.deepStrictEqual(order, [], 'its async cleanup may still be stopping children');
  assert.deepStrictEqual(proc.exits, []);
  proc.emit('exit', 0);
  assert.deepStrictEqual(order, ['stop', 'release']);
});

test('process lock: busy throws from ensure() and installs no hooks, and a later ensure() tries again', () => {
  const { r, proc, lock } = procRig({ holder: 'hub: probes (since 10:00:00)' });
  assert.throws(() => lock.ensure(), HeavyLockError);
  assert.strictEqual(proc.listenerCount('exit'), 0);
  assert.throws(() => lock.ensure(), HeavyLockError);
  assert.strictEqual(of(r, '-Acquire').length, 2);
});

test('process lock: re-entrant and missing install no hooks', () => {
  const a = procRig({ holder: OUTER }); a.r.env[ENV_VAR] = OUTER_ID; a.lock.ensure();
  assert.strictEqual(a.proc.listenerCount('exit'), 0);
  const b = procRig({ exists: false }); b.lock.ensure(); b.lock.ensure();
  assert.strictEqual(b.proc.listenerCount('exit'), 0);
  assert.strictEqual(b.r.log.length, 1, 'the missing-script warning is said once');
});


// ---- Dexter r2 #1: the work counts, not only the asker ----
const WORK = { owner: 'npm test (pid 5000 start 777)', work: [{ pid: 6000, start: '900' }] };

test('Dexter r2 1: a dead wrapper whose recorded child is still running is NOT a dead holder: no release, said', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '900' }, work: WORK });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0, 'the orphaned suite keeps the slot');
  assert.ok(r.log.some(m => /work \(pid 6000\) is still running/.test(m)));
});

test('Dexter r2 1: the same holder IS freed once the child is gone, or its pid was reused (another start)', () => {
  for (const alive of [{}, { 6000: '901' }]) {
    const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive, work: WORK });
    assert.strictEqual(acquire({ label: 'x', pid: 7, ...r.deps() }).state, 'held', JSON.stringify(alive));
    assert.strictEqual(of(r, '-Release').length, 1);
    assert.strictEqual(r.work, null, 'the dead holder\'s record goes with it');
  }
});

test('Dexter r2 1: a child whose start is unreadable counts as running; a child recorded without a start counts while its pid runs', () => {
  const a = rig({ holder: `${DEAD} (since 09:00:00)`, work: WORK });
  a.startsOf = (pids) => new Map(pids.filter(p => p !== 5000).map(p => [p, p === 6000 ? null : '100']));
  assert.throws(() => acquire({ label: 'x', pid: 7, ...a.deps(), startsOf: a.startsOf }), (e) => e.code === 'busy');
  const b = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '123' }, work: { owner: WORK.owner, work: [{ pid: 6000, start: null }] } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...b.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(a, '-Release').length + of(b, '-Release').length, 0);
});

test('Dexter r2 1: a record that cannot be read is "cannot tell", never "dead"', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, workFails: true });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0);
});

test('Dexter r2 1: another holder\'s record does not keep this dead holder alive', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '900' }, work: { owner: 'npm test (pid 4999 start 1)', work: [{ pid: 6000, start: '900' }] } });
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...r.deps() }).state, 'held');
});

test('Dexter r2 1: a held lock records its children with their start times; release clears the record; nothing after release', () => {
  const r = rig();
  const lock = acquire({ label: 'npm test', pid: 7, ...r.deps() });
  assert.strictEqual(lock.addWork(500, '123'), true);
  assert.strictEqual(lock.addWork(0), false);
  r.alive[501] = '456';
  assert.strictEqual(lock.addWork(501), true, 'a start not given is read');
  assert.deepStrictEqual(r.work, { owner: 'npm test (pid 7 start 100)', work: [{ pid: 500, start: '123' }, { pid: 501, start: '456' }] });
  lock.release();
  assert.strictEqual(r.work, null);
  assert.strictEqual(lock.addWork(502, '1'), false);
});

test('Dexter r2 1: reentrant and missing locks record nothing', () => {
  const a = rig({ holder: OUTER }); a.env[ENV_VAR] = OUTER_ID;
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...a.deps() }).addWork(5, '1'), false);
  const b = rig({ exists: false });
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...b.deps() }).addWork(5, '1'), false);
  assert.strictEqual(a.work, null);
  assert.strictEqual(b.work, null);
});

test('Dexter r2 1: a process lock records a probe\'s Electron root through addWork, and nothing before it holds the lock', () => {
  const { r, lock } = procRig();
  assert.strictEqual(lock.addWork(500, '123'), false);
  lock.ensure();
  assert.strictEqual(lock.addWork(500, '123'), true);
  assert.deepStrictEqual(r.work.work, [{ pid: 500, start: '123' }]);
});

test('the side file: add, read by owner prefix, clear only your own; a missing file is no work, a corrupt one throws', () => {
  const fs = require('fs');
  const dir = tmpDir('hl-work-');
  const file = path.join(dir, 'w.json');
  try {
    const st = createWorkStore(file);
    assert.deepStrictEqual(st.read('anything'), []);
    st.add('o (pid 1 start 2)', 10, '5');
    st.add('o (pid 1 start 2)', 11, null);
    assert.deepStrictEqual(st.read('o (pid 1 start 2) (since 10:00:00)'), [{ pid: 10, start: '5' }, { pid: 11, start: null }]);
    assert.deepStrictEqual(st.read('p (pid 3 start 4)'), []);
    st.clear('p (pid 3 start 4)');
    assert.strictEqual(st.read('o (pid 1 start 2)').length, 2, 'not someone else\'s to clear');
    st.add('q (pid 9 start 9)', 12, '1');
    assert.deepStrictEqual(st.read('o (pid 1 start 2)'), [], 'a new holder starts a new record');
    st.clear('q (pid 9 start 9)');
    assert.strictEqual(fs.existsSync(file), false);
    fs.writeFileSync(file, '{not json');
    assert.throws(() => st.read('o (pid 1 start 2)'));
    st.add('o (pid 1 start 2)', 10, '5');
    assert.strictEqual(st.read('o (pid 1 start 2)').length, 1, 'add heals a corrupt file');
  } finally { /* tmpDir() cleans itself up */ }
});

// ---- Dexter r2 #2: the retry is bounded by the one wait budget ----
test('Dexter r2 2: the retry after a reclaim waits only what is left of the budget (at least 1 minute), never more than the whole', () => {
  for (const [spent, expected] of [[0, '7'], [3 * 60000, '4'], [6.5 * 60000, '1'], [7 * 60000, '1'], [20 * 60000, '1']]) {
    const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 5000: '777' } });
    const timeouts = [];
    const deps = r.deps();
    let first = true;
    deps.run = (args, o) => {
      if (args.includes('-Acquire')) {
        timeouts.push(o && o.timeoutMs);
        if (first) { first = false; const out = r.run(args); delete r.alive[5000]; r.clock.t += spent; return out; }
      }
      return r.run(args);
    };
    assert.strictEqual(acquire({ label: 'x', pid: 7, waitMinutes: 7, ...deps }).state, 'held');
    const acq = of(r, '-Acquire');
    assert.strictEqual(flagValue(acq[0], '-WaitMinutes'), '7');
    assert.strictEqual(flagValue(acq[1], '-WaitMinutes'), expected, `spent ${spent}`);
    assert.strictEqual(timeouts[0], 8 * 60000);
    assert.strictEqual(timeouts[1], (Number(expected) + 1) * 60000, 'each call is killed one minute after its own deadline');
  }
});

test('Dexter r2 2: the reclaim happens before the first ticket is taken, so the common case loses no queue position', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  acquire({ label: 'x', pid: 7, ...r.deps() });
  const kinds = r.calls.map(c => c.includes('-Acquire') ? 'acquire' : c.includes('-Release') ? 'release' : 'status');
  assert.deepStrictEqual(kinds.slice(0, 3), ['status', 'release', 'acquire']);
  assert.strictEqual(kinds.filter(k => k === 'acquire').length, 1);
});

// ---- Dexter r2 #4: release is the last 'exit' listener ----
test('Dexter r2 4: an exit cleanup registered AFTER the lock was taken runs before the work is stopped and the slot freed', async () => {
  const { proc, order, lock } = procRig();
  lock.ensure();
  proc.on('exit', () => order.push('kill:host'));   // the probe's own cleanup, registered after its require of the launcher
  await new Promise(r => process.nextTick(r));
  proc.emit('exit', 1);
  assert.deepStrictEqual(order, ['kill:host', 'stop', 'release']);
});

test('Dexter r2 4: several late exit listeners all run first, and the slot is freed once', async () => {
  const { proc, order, lock } = procRig();
  lock.ensure();
  proc.on('exit', () => order.push('a'));
  proc.on('exit', () => order.push('b'));
  await new Promise(r => process.nextTick(r));
  proc.emit('exit', 0);
  assert.deepStrictEqual(order, ['a', 'b', 'stop', 'release']);
});

// ---- Dexter r2 #5: an exempted run says so ----
test('Dexter r2 5 / 2026-11-05: HEAVY_LOCK_HELD under the live holder it names prints ONE line, naming that holder', () => {
  const r = rig({ holder: OUTER });
  r.env[ENV_VAR] = OUTER_ID;
  acquire({ label: 'x', pid: 7, ...r.deps() });
  // #183: the holder its own flag names is this run's own outer wrapper, never "another lane's suite".
  assert.deepStrictEqual(r.log, [`[heavy-lock] HEAVY_LOCK_HELD is set and the slot is held by ${OUTER}: not taking the lock (re-entrant, under that holder: your own outer wrapper, pid 1)`]);
});

test('#183: a by-hand bare "1" holder is not called "your own wrapper"', () => {
  const r = rig({ holder: 'hub: probes (since 10:00:00)' });
  r.env[ENV_VAR] = '1';
  acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.deepStrictEqual(r.log, ['[heavy-lock] HEAVY_LOCK_HELD is set and the slot is held by hub: probes (since 10:00:00): not taking the lock (re-entrant, under that holder)']);
});

// ---- #237 Dexter 2 / Miguel S7: the flag names its holder, and a stranger's flag waits ----
const OTHER = 'npm test (pid 1 start 100) (since 10:00:00)';   // lane B's wrapper, holding the slot
test('#237 Dexter 2: own identity + own holder: skip, named', () => {
  const r = rig({ holder: OTHER });
  r.env[ENV_VAR] = 'npm test (pid 1 start 100)';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'reentrant');
  assert.strictEqual(lock.flag, 'npm test (pid 1 start 100)', 'passed on unchanged to what this run starts');
  assert.match(r.log[0], /held by npm test \(pid 1 start 100\) \(since 10:00:00\): not taking the lock/);
});

test('#237 Dexter 2: an identity under ANOTHER live holder is a stranger\'s flag: warned, and the lock is waited for (never run beside it)', () => {
  for (const flag of ['npm test (pid 1 start 999)', 'npm test (pid 12 start 100)', 'probe-x.js (pid 44 start 5)']) {
    const r = rig({ holder: OTHER });
    r.env[ENV_VAR] = flag;
    assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy' && e.holder === OTHER, flag);
    assert.strictEqual(of(r, '-Acquire').length, 1, `${flag}: it queued like anyone else`);
    assert.match(r.log[0], /WARNING: HEAVY_LOCK_HELD=.* is set, but the slot is held by npm test \(pid 1 start 100\) \(since 10:00:00\), which is not the holder that set it: a STRANGER'S variable/);
  }
});

test('#237 Dexter 2: a bare "1" under another lane\'s WRAPPER holder waits and warns; under a by-hand holder it skips', () => {
  const w = rig({ holder: OTHER });
  w.env[ENV_VAR] = '1';
  assert.throws(() => acquire({ label: 'x', pid: 7, ...w.deps() }), (e) => e.code === 'busy');
  assert.strictEqual(of(w, '-Acquire').length, 1);
  assert.match(w.log[0], /WARNING: HEAVY_LOCK_HELD=1 is set, but the slot is held by .*, which is another lane's wrapper or probe: a STRANGER'S variable/);
  const h = rig({ holder: 'ricardo: by hand (since 10:00:00)' });
  h.env[ENV_VAR] = '1';
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...h.deps() }).state, 'reentrant');
  assert.strictEqual(of(h, '-Acquire').length, 0);
});

test('#237 Dexter 2: a held lock sets the flag to ITS OWN identity, and the wrapper hands that to its command', async () => {
  const r = rig();
  const lock = acquire({ label: 'npm test', pid: 7, ...r.deps() });
  assert.strictEqual(r.env[ENV_VAR], 'npm test (pid 7 start 100)');
  assert.strictEqual(lock.flag, 'npm test (pid 7 start 100)');
  // What a child then sees: its parent's live slot, named by that flag, is re-entrant.
  const c = rig({ holder: `${r.holder}` }); c.env[ENV_VAR] = lock.flag;
  assert.strictEqual(acquire({ label: 'probe', pid: 8, ...c.deps() }).state, 'reentrant');
  lock.release();
  assert.strictEqual(r.env[ENV_VAR], undefined);
});

test('2026-11-05: the flag set + a manual holder (cannot be proven dead) skips, named', () => {
  const r = rig({ holder: 'hub: probes (since 10:00:00)' });
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'reentrant');
  assert.strictEqual(lock.holder, 'hub: probes (since 10:00:00)');
  assert.match(r.log[0], /held by hub: probes \(since 10:00:00\): not taking the lock/);
});

test('2026-11-05: the flag set + NOBODY holding the slot is a stale variable: one loud warning, and the lock is taken for real', () => {
  const r = rig();
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'held');
  assert.strictEqual(of(r, '-Acquire').length, 1);
  assert.match(r.holder, /^x \(pid 7 start 100\)/);
  assert.strictEqual(r.log.length, 1);
  assert.match(r.log[0], /^\[heavy-lock\] WARNING: HEAVY_LOCK_HELD is set but nobody holds the lock: a STALE variable in this shell\. Taking the lock for real; unset HEAVY_LOCK_HELD/);
  assert.strictEqual(r.env[ENV_VAR], lock.owner, 'while held, the flag is this holder\'s own identity');
  assert.strictEqual(lock.release(), true);
  assert.strictEqual(r.holder, null);
  // #237 Miguel S8: "on release the flag goes", the stale one included.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.env, ENV_VAR), false);
});

test('#237 Miguel S8: readHolder\'s status and reclaimDead\'s status and -Release all carry the 1-minute leash', () => {
  // The flag path (readHolder), then a dead holder freed before the ticket (reclaimDead): every call but the -Acquire is
  // bounded by STATUS_TIMEOUT_MS, never by the acquire's long timeout.
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  r.env[ENV_VAR] = '1';
  const seen = [];
  const run = r.run;
  r.run = (args, o) => { seen.push({ args, t: o && o.timeoutMs }); return run(args, o); };
  const lock = acquire({ label: 'x', pid: 7, waitMinutes: 20, ...r.deps() });
  assert.strictEqual(lock.state, 'held');
  const kinds = seen.map(s => (s.args.includes('-Acquire') ? 'acquire' : s.args.includes('-Release') ? 'release' : 'status'));
  assert.deepStrictEqual(kinds, ['status', 'status', 'release', 'acquire'], 'readHolder, reclaimDead\'s status, its release, the ticket');
  for (const s of seen) assert.strictEqual(s.t, s.args.includes('-Acquire') ? 21 * 60000 : STATUS_TIMEOUT_MS, JSON.stringify(s.args));
});

test('2026-11-05: the flag set + a provably dead holder is stale too: warned, the dead holder freed, the lock taken', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'held');
  assert.match(r.log[0], /WARNING: HEAVY_LOCK_HELD is set but the slot's holder is gone \(npm test \(pid 5000 start 777\) \(since 09:00:00\)\): a STALE variable/);
  assert.ok(r.log.some(m => /freed the slot of a dead holder/.test(m)));
});

test('2026-11-05: the flag set + a dead asker whose recorded work still runs is a LIVE holder: skip, named', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '900' }, work: WORK });
  r.env[ENV_VAR] = DEAD;   // the flag that holder set for its children
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...r.deps() }).state, 'reentrant');
  assert.strictEqual(of(r, '-Acquire').length + of(r, '-Release').length, 0);
});

test('2026-11-05: the flag set + a status that cannot be read, or no script: can\'t tell, so the flag is trusted, and the line says so', () => {
  const a = rig();
  a.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...a.deps(), run: (args) => { a.calls.push(args); return { status: null, stdout: '[ETIMEDOUT]' }; } });
  assert.strictEqual(lock.state, 'reentrant');
  assert.match(a.log[0], /who holds the slot could not be read: not taking the lock/);
  const b = rig({ exists: false });
  b.env[ENV_VAR] = '1';
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...b.deps() }).state, 'reentrant');
  assert.strictEqual(b.calls.length, 0, 'no script, nothing run');
  // #237 Miguel S3: the reason said is the missing script, not an unreadable status.
  assert.match(b.log[0], /HEAVY_LOCK_HELD is set and the lock script .* is not on this machine: not taking the lock/);
  assert.doesNotMatch(b.log[0], /could not be read/);
});

test('2026-11-05: HEAVY_LOCK_SCRIPT points the module at another script; a relative one is ignored', () => {
  const { SCRIPT_VAR } = require('../host/heavy-lock');
  assert.strictEqual(SCRIPT_VAR, 'HEAVY_LOCK_SCRIPT');
  const seen = [];
  const exists = (p) => { seen.push(p); return false; };
  const abs = path.join(tmpDir('hl-sv-'), 'nope.ps1');
  assert.strictEqual(acquire({ label: 'x', pid: 7, env: { [SCRIPT_VAR]: abs }, exists, log: () => {}, startsOf: () => new Map(), run: () => ({ status: 0 }), watch: null }).state, 'missing');
  assert.strictEqual(seen[0], abs);
  acquire({ label: 'x', pid: 7, env: { [SCRIPT_VAR]: 'rel\\x.ps1' }, exists, log: () => {}, startsOf: () => new Map(), run: () => ({ status: 0 }), watch: null });
  assert.strictEqual(seen[1], DEFAULT_SCRIPT);
});

// ---- BACKLOG #112: the record covers every heavy child, and a provisional entry is replaced, not duplicated ----
test('BACKLOG #112: a recorded Electron that is gone does not free a holder whose recorded host.js is still alive', () => {
  const two = { owner: WORK.owner, work: [{ pid: 6000, start: '900' }, { pid: 6001, start: '910' }] };
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6001: '910' }, work: two });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy');
  assert.ok(r.log.some(m => /work \(pid 6001\) is still running/.test(m)));
  assert.ok(!of(r, '-Release').some(c => flagValue(c, '-Owner') === DEAD), 'the dead holder was not released');
});

test('BACKLOG #112: a provisional record (start unknown) keeps the holder while its pid runs, and is replaced by the start time', () => {
  const dir = tmpDir('hl-prov-');
  const file = path.join(dir, 'w.json');
  const st = createWorkStore(file);
  st.add('o (pid 1 start 2)', 10, null);
  st.add('o (pid 1 start 2)', 11, '7');
  st.add('o (pid 1 start 2)', 10, '5');
  assert.deepStrictEqual(st.read('o (pid 1 start 2)'), [{ pid: 11, start: '7' }, { pid: 10, start: '5' }], 'one entry per pid');
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '123' }, work: { owner: WORK.owner, work: [{ pid: 6000, start: null }] } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy', 'a live provisional child holds the slot');
});

// ---- BACKLOG #178 b: a give-up that can't be misread, and a wait that shows ----
test('#178 b: a busy give-up carries who held the slot and how long this asker waited', () => {
  const r = rig({ holder: 'npm test (pid 5000 start 777) (since 09:00:00)', alive: { 5000: '777' } });
  const deps = r.deps();
  const run = deps.run;
  deps.run = (args, o) => { if (args.includes('-Acquire')) r.clock.t += 20 * 60000 + 15000; return run(args, o); };
  assert.throws(() => acquire({ label: 'x', pid: 7, ...deps }), (e) => {
    assert.strictEqual(e.code, 'busy');
    assert.strictEqual(e.holder, 'npm test (pid 5000 start 777) (since 09:00:00)');
    assert.strictEqual(e.waitedMs, 20 * 60000 + 15000);
    return true;
  });
});

test('#178 b: busy because of the queue has no holder, and says how many are ahead; too loaded carries the load', () => {
  const q = rig({ acquireOverride: { status: 2, stdout: 'busy: 2 ahead in the queue' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...q.deps() }), (e) => e.code === 'busy' && e.holder === null && e.detail === '2 ahead in the queue');
  const l = rig({ acquireOverride: { status: 3, stdout: 'machine too loaded: 4 GB free, 90% CPU' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...l.deps() }), (e) => e.code === 'loaded' && e.detail === '4 GB free, 90% CPU');
});

test('#178 b: notRunLine is the one last line, in words a builder cannot misread, and NOT_RUN_EXIT is 75 (never a failing suite\'s 1)', () => {
  assert.strictEqual(NOT_RUN_EXIT, 75);
  assert.strictEqual(notRunLine(new HeavyLockError('busy', 'm', { holder: 'npm test (pid 5 start 6) (since 10:00:00)', waitedMs: 20 * 60000 + 15000 })),
    '[heavy-lock] lock busy for 20 min, held by npm test (pid 5 start 6) (since 10:00:00): NOT RUN');
  assert.strictEqual(notRunLine(new HeavyLockError('busy', 'm', { detail: '2 ahead in the queue', waitedMs: 19.6 * 60000 })),
    '[heavy-lock] lock busy for 20 min, held by nobody now but 2 ahead in the queue (the first may be held back by the load gate: 8 GB free RAM and under 70% CPU): NOT RUN');
  assert.strictEqual(notRunLine(new HeavyLockError('busy', 'm', { waitedMs: 20 * 60000 })), '[heavy-lock] lock busy for 20 min, held by nobody now: NOT RUN');
  assert.strictEqual(notRunLine(new HeavyLockError('loaded', 'm', { detail: '4 GB free, 90% CPU', waitedMs: 20 * 60000 })),
    '[heavy-lock] machine busy after a 20 min wait: the lock is free, but its load gate needs 8 GB free RAM and under 70% CPU (now 4 GB free, 90% CPU): NOT RUN');
  assert.strictEqual(notRunLine(new HeavyLockError('loaded', 'm', { waitedMs: 60000 })),
    '[heavy-lock] machine busy after a 1 min wait: the lock is free, but its load gate needs 8 GB free RAM and under 70% CPU: NOT RUN');
  assert.match(notRunLine(new HeavyLockError('error', 'heavy-lock.ps1 failed (exit 1): boom')), /^\[heavy-lock\] the lock could not be taken \(heavy-lock\.ps1 failed \(exit 1\): boom\): NOT RUN$/);
  assert.match(notRunLine(new Error('x')), /: NOT RUN$/);
  assert.match(notRunLine(null), /: NOT RUN$/);
});

const FIRST_HELD = 'first in line: held back by the load gate since 10:05:00';
const FIRST_FREE = 'first in line: not held back by the load gate';
test('#187: the script\'s "first in line:" line is read, not inferred', () => {
  const held = rig({ acquireOverride: { status: 2, stdout: `busy: 2 ahead in the queue\n${FIRST_HELD}` } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...held.deps() }), (e) => e.code === 'busy' && e.detail === '2 ahead in the queue' && e.firstInLine === 'held back by the load gate since 10:05:00');
  const free = rig({ acquireOverride: { status: 2, stdout: `busy: 2 ahead in the queue\r\n${FIRST_FREE}\r\n` } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...free.deps() }), (e) => e.detail === '2 ahead in the queue' && e.firstInLine === 'not held back by the load gate');
  const old = rig({ acquireOverride: { status: 2, stdout: 'busy: 2 ahead in the queue' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...old.deps() }), (e) => e.detail === '2 ahead in the queue' && e.firstInLine === null);
});

test('#187: notRunLine says what the script said about the first in line; an older script keeps today\'s guess', () => {
  const mk = (firstInLine) => new HeavyLockError('busy', 'm', { detail: '2 ahead in the queue', waitedMs: 20 * 60000, firstInLine });
  assert.strictEqual(notRunLine(mk('held back by the load gate since 10:05:00')),
    '[heavy-lock] lock busy for 20 min, held by nobody now but 2 ahead in the queue (the first in line is held back by the load gate since 10:05:00: 8 GB free RAM and under 70% CPU): NOT RUN');
  assert.strictEqual(notRunLine(mk('not held back by the load gate')),
    '[heavy-lock] lock busy for 20 min, held by nobody now but 2 ahead in the queue (the first in line is not held back by the load gate): NOT RUN');
  assert.strictEqual(notRunLine(mk(null)),
    '[heavy-lock] lock busy for 20 min, held by nobody now but 2 ahead in the queue (the first may be held back by the load gate: 8 GB free RAM and under 70% CPU): NOT RUN');
});

test('#187: the error text drops the script\'s raw [heavy-lock] lines', () => {
  const r = rig({ acquireOverride: { status: 2, stdout: `[heavy-lock] waited 19:40 for the slot: 2 ahead in the queue\nbusy: 2 ahead in the queue\n${FIRST_FREE}\n[heavy-lock] this run's queue ticket was gone: written back in its place` } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => !/\[heavy-lock\]/.test(e.message) && /busy: 2 ahead in the queue/.test(e.message));
  const t = rig({ acquireOverride: { status: 1, stdout: '[heavy-lock] could not take the slot: boom\ncould not take the slot: boom' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...t.deps() }), (e) => e.code === 'error' && !/\[heavy-lock\]/.test(e.message) && /boom/.test(e.message));
});

test('#178 b: the watcher runs exactly around the wait, with the asker and its start, and is stopped whether the acquire holds or gives up', () => {
  for (const holder of [null, 'hub: probes (since 10:00:00)']) {
    const r = rig({ holder });
    const events = [];
    const deps = r.deps();
    const run = deps.run;
    deps.run = (args, o) => { if (args.includes('-Acquire')) events.push('acquire'); return run(args, o); };
    const watch = (cfg) => { events.push(['watch', cfg.parentPid, cfg.parentStart, cfg.waitMinutes, typeof cfg.startedAt]); return { stop: () => events.push('stop') }; };
    try { acquire({ label: 'x', pid: 7, waitMinutes: 20, ...deps, watch }); } catch (e) { assert.strictEqual(e.code, 'busy'); }
    assert.deepStrictEqual(events, [['watch', 7, '100', 20, 'number'], 'acquire', 'stop'], String(holder));
  }
});

test('#178 b: no watcher when nothing is waited for (re-entrant, script missing), and one that cannot start never stops the acquire', () => {
  let started = 0;
  const watch = () => { started++; return { stop() {} }; };
  const a = rig(); a.env[ENV_VAR] = 'npm test (pid 1 start 100)'; a.holder = 'npm test (pid 1 start 100) (since 10:00:00)';
  acquire({ label: 'x', pid: 7, ...a.deps(), watch });
  const b = rig({ exists: false }); acquire({ label: 'x', pid: 7, ...b.deps(), watch });
  assert.strictEqual(started, 0);
  const c = rig();
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...c.deps(), watch: () => { throw new Error('no node'); } }).state, 'held');
  const d = rig();
  assert.strictEqual(acquire({ label: 'x', pid: 7, ...d.deps(), watch: () => ({ stop() { throw new Error('gone'); } }) }).state, 'held');
});

test('#178 b: startWatcher starts node on host/heavy-lock-watch.js with its config, its lines on stderr, without the re-entrancy flag', () => {
  const seen = [];
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.unref = () => seen.push('unref');
  child.kill = () => seen.push('kill');
  const spawnFn = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return child; };
  const w = startWatcher({ scriptPath: 'S.ps1', workFile: 'W.json', parentPid: 7, parentStart: '100', startedAt: 5, waitMinutes: 20, everyMs: 1000, spawnFn, execPath: 'NODE', env: { A: 'a', [ENV_VAR]: '1' } });
  const call = seen[0];
  assert.strictEqual(call.cmd, 'NODE');
  assert.strictEqual(call.args[0], WATCH_SCRIPT);
  assert.match(WATCH_SCRIPT.replace(/\\/g, '/'), /\/host\/heavy-lock-watch\.js$/);
  assert.deepStrictEqual(JSON.parse(call.args[1]), { scriptPath: 'S.ps1', workFile: 'W.json', parentPid: 7, parentStart: '100', startedAt: 5, everyMs: 1000, maxMs: 22 * 60000 });
  assert.deepStrictEqual(call.opts.stdio, ['ignore', 'ignore', 'inherit']);
  assert.strictEqual(call.opts.windowsHide, true);
  assert.strictEqual(call.opts.env.A, 'a');
  assert.strictEqual(call.opts.env[ENV_VAR], undefined);
  assert.ok(seen.includes('unref'), 'the watcher never keeps its asker alive');
  w.stop();
  assert.ok(seen.includes('kill'));
  child.exitCode = 0; seen.length = 0;
  w.stop();
  assert.deepStrictEqual(seen, [], 'an exited watcher is not killed (its pid may be reused)');
  assert.doesNotThrow(() => startWatcher({ waitMinutes: 1, spawnFn: () => { throw new Error('EPERM'); } }).stop());
});

test('#237 Miguel M2: with no `watch` given, acquire starts the real watcher (node on heavy-lock-watch.js) through spawnAsync, around the wait', () => {
  // Nothing real starts: the async spawn is a fake, and the script calls go to a fake spawnSync.
  const sync = [];
  const spawnFn = (cmd, args) => { sync.push(args.includes('-Acquire') ? 'acquire' : 'other'); return { status: 0, stdout: 'free' }; };
  const started = [];
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.unref = () => {}; child.kill = () => started.push('kill');
  const spawnAsync = (cmd, args) => { started.push({ cmd, script: args[0], cfg: JSON.parse(args[1]), acquiresBefore: sync.filter(s => s === 'acquire').length }); return child; };
  acquire({ label: 'x', pid: 7, waitMinutes: 1, exists: () => true, env: {}, log: () => {}, spawnFn, spawnAsync, startsOf: () => new Map([[7, '100']]), work: createWorkStore(path.join(tmpDir('hl-nw-'), 'w.json')) });
  assert.strictEqual(started.length, 2, 'one watcher, stopped by its handle');
  assert.strictEqual(started[0].cmd, process.execPath);
  assert.strictEqual(started[0].script, WATCH_SCRIPT);
  assert.strictEqual(started[0].cfg.parentPid, 7);
  assert.strictEqual(started[0].acquiresBefore, 0, 'started before the -Acquire, so it speaks during the wait');
  assert.strictEqual(started[1], 'kill');
});

test('#237 Miguel M2: watch: null starts nothing, even with an async spawn handed in', () => {
  let n = 0;
  const spawnFn = () => ({ status: 0, stdout: 'free' });
  acquire({ label: 'x', pid: 7, waitMinutes: 1, exists: () => true, env: {}, log: () => {}, spawnFn, spawnAsync: () => { n++; return new EventEmitter(); }, startsOf: () => new Map(), work: createWorkStore(path.join(tmpDir('hl-nw0-'), 'w.json')), watch: null });
  assert.strictEqual(n, 0);
});

test('#237 Miguel M2: a caller that fakes the script but not the async spawn gets no default watcher (the module\'s own spawn is never called)', () => {
  // A fresh copy of the module, loaded while child_process.spawn is a counter, so its default spawn IS that counter: the
  // safety net is measured, not assumed. Restored before anything else runs.
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  const id = require.resolve('../host/heavy-lock');
  const cached = require.cache[id];
  let n = 0;
  let fresh;
  try {
    cp.spawn = () => { n++; const c = new EventEmitter(); c.exitCode = null; c.signalCode = null; c.unref = () => {}; c.kill = () => {}; return c; };
    delete require.cache[id];
    fresh = require('../host/heavy-lock');
  } finally {
    cp.spawn = realSpawn;
    require.cache[id] = cached;
  }
  const base = () => ({ label: 'x', pid: 7, waitMinutes: 1, exists: () => true, env: {}, log: () => {}, startsOf: () => new Map([[7, '100']]) });
  assert.strictEqual(fresh.acquire({ ...base(), spawnFn: () => ({ status: 0, stdout: 'free' }), work: createWorkStore(path.join(tmpDir('hl-nw1-'), 'w.json')) }).state, 'held');
  assert.strictEqual(fresh.acquire({ ...base(), run: () => ({ status: 0, stdout: 'acquired' }), work: createWorkStore(path.join(tmpDir('hl-nw2-'), 'w.json')) }).state, 'held');
  assert.strictEqual(n, 0, 'a faked script call must never start a real watcher against the real lock');
  // The counter really is the copy's default spawn (else the 0 above proves nothing): its startWatcher calls it.
  fresh.startWatcher({ waitMinutes: 1 }).stop();
  assert.strictEqual(n, 1);
});

// ---- the watcher's one step (host/heavy-lock-watch.js) ----
const { watchTick } = require('../host/heavy-lock-watch');
function tickRig(over = {}) {
  const r = rig(over);
  const d = r.deps();
  return { r, d, tick: (extra = {}) => watchTick({ run: d.run, startsOf: d.startsOf, work: d.work, log: d.log, parentPid: 7, startedAt: 0, now: () => 3 * 60000 + 5000, alive: (p) => r.alive[p] !== undefined, ...extra }) };
}

test('#178 b watch: says how long the asker has waited and who holds the slot', () => {
  const { r, tick } = tickRig({ holder: 'hub: probes (since 10:00:00)' });
  assert.strictEqual(tick(), 'waiting');
  assert.deepStrictEqual(r.log, ['[heavy-lock] waited 3 min so far for the lock, held by hub: probes (since 10:00:00)']);
  assert.strictEqual(of(r, '-Release').length, 0, 'a manual holder is never touched');
});

test('#178 b watch: a holder that died during the wait is freed by the dead-holder rules; a live one is not', () => {
  const dead = tickRig({ holder: `${DEAD} (since 09:00:00)` });
  dead.tick();
  assert.strictEqual(of(dead.r, '-Release').length, 1);
  assert.strictEqual(dead.r.holder, null);
  assert.ok(dead.r.log.some(m => /freed the slot of a dead holder/.test(m)));
  const live = tickRig({ holder: `${DEAD} (since 09:00:00)`, alive: { 5000: '777' } });
  live.tick();
  assert.strictEqual(of(live.r, '-Release').length, 0);
  const orphan = tickRig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '900' }, work: WORK });
  orphan.tick();
  assert.strictEqual(of(orphan.r, '-Release').length, 0, 'its recorded work still runs');
});

test('#178 b watch: the asker gone ends the watcher before it reads or frees anything; "cannot tell" carries on', () => {
  const { r, tick } = tickRig({ holder: `${DEAD} (since 09:00:00)` });
  delete r.alive[7];
  assert.strictEqual(tick(), 'asker-gone');
  assert.strictEqual(r.calls.length, 0);
  const t = tickRig({ holder: 'hub: probes (since 10:00:00)' });
  assert.strictEqual(t.tick({ alive: () => { throw new Error('cannot ask'); } }), 'waiting');
});

test('#237 Miguel M1: one tick costs one status read, and a start query only for a "(pid N start T)" holder; never one for the asker', () => {
  for (const [holder, queries] of [[`${DEAD} (since 09:00:00)`, 1], ['hub: probes (since 10:00:00)', 0]]) {
    const { r, tick } = tickRig({ holder, alive: { 5000: '777' } });
    const asked = [];
    tick({ startsOf: (pids) => { asked.push(pids); return r.startsOf(pids); } });
    assert.strictEqual(r.calls.filter(a => a.length === 0).length, 1, `${holder}: the status is read once and handed to the reclaim`);
    assert.strictEqual(asked.length, queries, holder);
    assert.ok(!asked.some(p => p.includes(7)), 'the asker is checked with process.kill(pid, 0), not a query');
  }
});

test('#237 Miguel M1: pidAlive tests liveness with process.kill(pid, 0): this process runs, a pid nobody has does not', () => {
  const { pidAlive } = require('../host/heavy-lock-watch');
  assert.strictEqual(pidAlive(process.pid), true);
  // Windows pids are multiples of 4 well below this; an odd number past 2^31 is never a live process.
  assert.strictEqual(pidAlive(2147483647), false);
});

test('#178 b watch: a free slot and an unreadable status are said as such', () => {
  const free = tickRig();
  free.tick();
  assert.match(free.r.log[0], /waited 3 min so far for the lock: the slot is free/);
  // The script's status with the asker alone in the queue: the load gate is what holds it, and the line says the load.
  const gated = tickRig();
  gated.tick({ run: () => ({ status: 0, stdout: 'free\nqueue 1: npm test (pid 7 start 100) (asked 10:00:00)\nload: 31.5 GB free RAM, 72% CPU' }) });
  assert.strictEqual(gated.r.log[0], '[heavy-lock] waited 3 min so far for the lock: the slot is free; 1 waiting, this one included (the load gate: it needs 8 GB free RAM and under 70% CPU; now 31.5 GB free RAM, 72% CPU)');
  const behind = tickRig();
  behind.tick({ run: () => ({ status: 0, stdout: 'free\nqueue 1: a\nqueue 2: b\nload: 20 GB free RAM, 10% CPU' }) });
  assert.match(behind.r.log[0], /2 waiting, this one included \(an earlier ticket goes first, or the load gate; now 20 GB free RAM, 10% CPU\)$/);
  const broken = tickRig();
  broken.tick({ run: () => ({ status: null, stdout: '' }) });
  assert.match(broken.r.log[0], /its status could not be read/);
  const thrown = tickRig();
  assert.strictEqual(thrown.tick({ run: () => { throw new Error('x'); } }), 'waiting');
});

// ---- #237 Dexter 1: after a busy give-up the question is "is it still held?", not "did I free it?" ----
const X = 'npm test (pid 5000 start 777) (since 09:00:00)';
function freedBySomeoneElse(extra = {}) {
  // The script gives up "busy: X" at the deadline; X then dies and someone else (this call's watcher, another lane's) frees
  // it before this call reads the slot again.
  let n = 0;
  return rig({ holder: X, alive: { 5000: '777' }, ...extra, acquireOverride: (r) => {
    n++;
    if (n === 1) { const said = `busy: ${r.holder}`; delete r.alive[5000]; r.holder = null; return { status: 2, stdout: said }; }
    if (r.holder) return { status: 2, stdout: `busy: ${r.holder}` };
    r.holder = `${flagValue(r.calls[r.calls.length - 1], '-Owner')} (since 10:00:00)`;
    return { status: 0, stdout: 'acquired' };
  } });
}

test('#237 Dexter 1: X freed by someone else after the give-up: the slot is read again, the acquire retried, and held', () => {
  const r = freedBySomeoneElse();
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'held', 'a free slot is not a NOT RUN');
  assert.strictEqual(of(r, '-Acquire').length, 2);
  assert.strictEqual(of(r, '-Release').length, 0, 'nothing for this call to free: it was already free');
  assert.ok(r.log.some(m => /came free just after the wait gave up/.test(m)), JSON.stringify(r.log));
});

test('#237 Dexter 1: the watcher is stopped before the slot is read again, and runs around the retry too', () => {
  const r = freedBySomeoneElse();
  const events = [];
  const deps = r.deps();
  const run = deps.run;
  deps.run = (args, o) => { events.push(args.includes('-Acquire') ? 'acquire' : args.includes('-Release') ? 'release' : 'status'); return run(args, o); };
  const watch = () => { events.push('watch'); return { stop: () => events.push('stop') }; };
  acquire({ label: 'x', pid: 7, ...deps, watch });
  const tail = events.slice(events.indexOf('watch'));
  assert.deepStrictEqual(tail, ['watch', 'acquire', 'stop', 'status', 'watch', 'acquire', 'stop']);
});

test('#237 Dexter 1: still held by a LIVE holder after the give-up is a NOT RUN, with one status read and no retry', () => {
  const r = rig({ holder: X, alive: { 5000: '777' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'busy' && e.holder === X);
  assert.strictEqual(of(r, '-Acquire').length, 1);
});

// ---- #113 Dexter 1: a child the start query can't list has exited, and leaves the record ----
test('#113 Dexter 1: a provisional entry whose child the query no longer lists is DROPPED, not kept with an unknown start', () => {
  const r = rig();
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.addWork(9000, null), true, 'the provisional write');
  assert.deepStrictEqual(r.work.work, [{ pid: 9000, start: null }]);
  assert.strictEqual(lock.addWork(9000), false, 'the query answered without 9000: it exited inside the query');
  assert.deepStrictEqual(r.work.work, [], 'a stranger reusing pid 9000 later can not hold the slot');
});

test('#113 Dexter 1: a query that FAILS is "can\'t tell": the entry stays with an unknown start', () => {
  for (const failing of [() => null, () => { throw new Error('wmi'); }]) {
    const r = rig();
    let fail = false;
    const deps = r.deps();
    // The owner's own start is read normally; from the child's query on, the query fails.
    const lock = acquire({ label: 'x', pid: 7, ...deps, startsOf: (p) => (fail ? failing(p) : deps.startsOf(p)) });
    lock.addWork(9000, null);
    fail = true;
    assert.strictEqual(lock.addWork(9000), true);
    assert.deepStrictEqual(r.work.work, [{ pid: 9000, start: null }]);
  }
});

test('#113 Dexter 1: a listed child is upgraded to its start time, as before', () => {
  const r = rig({ alive: { 9000: '555' } });
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  lock.addWork(9000, null);
  assert.strictEqual(lock.addWork(9000), true);
  assert.deepStrictEqual(r.work.work, [{ pid: 9000, start: '555' }]);
});

test('#113 Dexter 1: the side file\'s remove drops one pid of its own owner only, and leaves a missing file alone', () => {
  const fs = require('fs');
  const file = path.join(tmpDir('hl-rm-'), 'w.json');
  const st = createWorkStore(file);
  assert.doesNotThrow(() => st.remove('o (pid 1 start 2)', 10));
  assert.strictEqual(fs.existsSync(file), false);
  st.add('o (pid 1 start 2)', 10, null);
  st.add('o (pid 1 start 2)', 11, '5');
  st.remove('p (pid 3 start 4)', 10);
  assert.strictEqual(st.read('o (pid 1 start 2)').length, 2, 'not someone else\'s to drop');
  st.remove('o (pid 1 start 2)', 10);
  assert.deepStrictEqual(st.read('o (pid 1 start 2)'), [{ pid: 11, start: '5' }]);
});

// ---- #237 Miguel S4: a malformed entry in the work record never throws out of acquire ----
test('#237 Miguel S4: work: [null] (or a pid that is no number) under a dead holder is "can\'t tell": no throw, no reclaim, said', () => {
  const fs = require('fs');
  for (const body of ['[null]', '[{"pid":"6000"}]', '[{"start":"1"}]', '[7]']) {
    const file = path.join(tmpDir('hl-malformed-'), 'w.json');
    fs.writeFileSync(file, `{"owner":"npm test (pid 5000 start 777)","work":${body}}`);
    const r = rig({ holder: `${DEAD} (since 09:00:00)` });
    assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps(), work: createWorkStore(file) }),
      (e) => e instanceof HeavyLockError && e.code === 'busy', `${body}: a refusal, never a TypeError`);
    assert.strictEqual(of(r, '-Release').length, 0, `${body}: never freed on "can't tell"`);
    assert.ok(r.log.some(m => /work record of .* can't be read \(EMALFORMED\)/.test(m)), body);
  }
});

// ---- #112 M2: a corrupt work record, decided: the safe side, said ----
test('#112 M2: a corrupt work record on disk keeps a dead holder\'s slot (never freed on "can\'t tell"), and a line says why', () => {
  const fs = require('fs');
  const file = path.join(tmpDir('hl-corrupt-'), 'w.json');
  fs.writeFileSync(file, '{"owner":"npm test (pid 5000 start 777)","work":[{"pid":60');   // damaged
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps(), work: createWorkStore(file) }), (e) => e.code === 'busy');
  assert.strictEqual(of(r, '-Release').length, 0, 'the dead asker\'s slot is not freed: its record may list a suite that still runs');
  const said = r.log.filter(m => /work record of npm test \(pid 5000 start 777\) \(since 09:00:00\) can't be read/.test(m));
  assert.ok(said.length >= 1, JSON.stringify(r.log));
  assert.match(said[0], /the slot stays held \(heavy-lock\.ps1 frees a hold after 60 minutes\)/);
  // After the script's takeover, the next holder's first record heals the file.
  createWorkStore(file).add('y (pid 8 start 1)', 9, '2');
  assert.deepStrictEqual(createWorkStore(file).read('y (pid 8 start 1)'), [{ pid: 9, start: '2' }]);
});

// ---- #237 L6 (Miguel M3, S9; Dexter 9 a-c): the watcher's loop, its command line, and its start ----
const watchMod = require('../host/heavy-lock-watch');
function loopRig({ alive = true, statusThrows = false } = {}) {
  const l = { t: 1000, timers: [], exits: [], log: [], runs: 0 };
  l.deps = {
    log: (m) => l.log.push(m), exit: (c) => l.exits.push(c), now: () => l.t,
    run: () => { l.runs++; if (statusThrows) throw new Error('no powershell'); return { status: 0, stdout: 'held: hub: probes (since 10:00:00)' }; },
    startsOf: () => new Map([[7, '100']]),
    alive: () => { if (alive === 'cant-tell') throw new Error('cannot ask'); return alive; },
    work: { read: () => [], clear() {} },
    setTimer: (fn, ms) => l.timers.push({ fn, ms }),
  };
  l.cfg = { scriptPath: 'x.ps1', parentPid: 7, parentStart: '100', startedAt: 0, everyMs: 60000, maxMs: 3 * 60000 };
  // Fire the next armed timer, the clock moved on by its delay.
  l.fire = () => { const t = l.timers.shift(); l.t += t.ms; t.fn(); };
  return l;
}

test('#237 Dexter 9 a: main() exits 0 at its deadline even when every tick says "can\'t tell, carry on"', () => {
  const l = loopRig({ alive: 'cant-tell', statusThrows: true });
  watchMod.main(l.cfg, l.deps);
  assert.strictEqual(l.timers.length, 1, 'armed once at start, nothing run yet');
  assert.strictEqual(l.timers[0].ms, 60000);
  let guard = 0;
  while (l.exits.length === 0 && l.timers.length && guard++ < 50) l.fire();
  assert.deepStrictEqual(l.exits, [0]);
  assert.strictEqual(l.timers.length, 0, 'never re-armed after the exit');
  assert.strictEqual(l.runs, 3, 'ticks at 1, 2 and 3 minutes; the fourth is past the 3-minute deadline');
});

test('#237 Miguel M3: main() exits 0 on the first tick that finds the asker gone, before it reads the status', () => {
  const l = loopRig({ alive: false });
  watchMod.main(l.cfg, l.deps);
  l.fire();
  assert.deepStrictEqual(l.exits, [0]);
  assert.strictEqual(l.runs, 0);
  assert.strictEqual(l.timers.length, 0);
});

test('#237 Miguel M3: main() re-arms after a waiting tick, with everyMs', () => {
  const l = loopRig();
  watchMod.main(l.cfg, l.deps);
  l.fire();
  assert.deepStrictEqual(l.exits, []);
  assert.strictEqual(l.timers.length, 1);
  assert.strictEqual(l.timers[0].ms, 60000);
  assert.match(l.log[0], /waited 1 min so far for the lock, held by hub: probes/);
});

test('#237 Miguel S9: the command line\'s config needs a pid, a script path, a start time, a cadence and a cap', () => {
  const good = { scriptPath: 'C:/x.ps1', workFile: 'w.json', parentPid: 7, parentStart: '100', startedAt: 5, everyMs: 60000, maxMs: 120000 };
  assert.deepStrictEqual(watchMod.parseConfig(JSON.stringify(good)), good);
  const bad = [
    '{bad', 'null', '7', JSON.stringify({ ...good, parentPid: 0 }), JSON.stringify({ ...good, parentPid: '7' }),
    JSON.stringify({ ...good, scriptPath: undefined }), JSON.stringify({ ...good, scriptPath: '' }),
    JSON.stringify({ ...good, startedAt: undefined }), JSON.stringify({ ...good, startedAt: 'now' }),
    JSON.stringify({ ...good, everyMs: 0 }), JSON.stringify({ ...good, maxMs: -1 }),
  ];
  for (const arg of bad) assert.strictEqual(watchMod.parseConfig(arg), null, arg);
});

test('#237 Miguel M3: the real command line exits 2 on a bad config (bounded real process, its own child only)', () => {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env[ENV_VAR];
  delete env.ELECTRON_RUN_AS_NODE;
  for (const arg of ['{bad', JSON.stringify({ parentPid: 7, startedAt: 0, everyMs: 10, maxMs: 10 })]) {
    const r = spawnSync(process.execPath, [WATCH_SCRIPT, arg], { encoding: 'utf8', timeout: 15000, windowsHide: true, env });
    assert.strictEqual(r.error, undefined, String(r.error));
    assert.strictEqual(r.status, 2, `${arg}: ${r.stderr}`);
  }
});

test('#237 Dexter 9 b: a watcher whose child emits \'error\' later (EACCES on the node) never throws into its asker', () => {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.unref = () => {}; child.kill = () => {};
  const w = startWatcher({ scriptPath: 'x', waitMinutes: 1, startedAt: 0, parentPid: 7, spawnFn: () => child, env: {} });
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
  assert.doesNotThrow(() => w.stop());
});

test('#237 Dexter 9 c: from an Electron main the watcher is started as plain node (ELECTRON_RUN_AS_NODE=1); from node it isn\'t set', () => {
  const envs = [];
  const spawnFn = (cmd, args, o) => { envs.push(o.env); const c = new EventEmitter(); c.exitCode = 0; c.signalCode = null; c.unref = () => {}; return c; };
  startWatcher({ scriptPath: 'x', waitMinutes: 1, startedAt: 0, parentPid: 7, spawnFn, env: { [ENV_VAR]: 'o (pid 7 start 1)' }, versions: { node: '22', electron: '33.0.0' } });
  startWatcher({ scriptPath: 'x', waitMinutes: 1, startedAt: 0, parentPid: 7, spawnFn, env: {}, versions: { node: '22' } });
  assert.strictEqual(envs[0].ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(envs[0][ENV_VAR], undefined, 'never the re-entrancy flag');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(envs[1], 'ELECTRON_RUN_AS_NODE'), false);
});

test('#237 Miguel S9: each attempt\'s watcher is bounded by THAT call\'s wait, and outlasts the call\'s own kill timer', () => {
  // The first call gives up at the 20-minute deadline (the clock moves past it), X is freed, the retry gets 1 minute.
  let n = 0;
  const r = rig({ holder: X, alive: { 5000: '777' }, acquireOverride: (rr) => {
    n++;
    if (n === 1) { const said = `busy: ${rr.holder}`; delete rr.alive[5000]; rr.holder = null; rr.clock.t = 20 * 60000 + 5000; return { status: 2, stdout: said }; }
    rr.holder = `${flagValue(rr.calls[rr.calls.length - 1], '-Owner')} (since 10:00:00)`;
    return { status: 0, stdout: 'acquired' };
  } });
  const cfgs = [];
  const timeouts = [];
  const deps = r.deps();
  const run = deps.run;
  deps.run = (args, o) => { if (args.includes('-Acquire')) timeouts.push(o.timeoutMs); return run(args, o); };
  const spawnFn = (cmd, args) => { cfgs.push(JSON.parse(args[1])); const c = new EventEmitter(); c.exitCode = 0; c.signalCode = null; c.unref = () => {}; return c; };
  const lock = acquire({ label: 'x', pid: 7, ...deps, watch: (cfg) => startWatcher({ ...cfg, spawnFn, env: {} }) });
  assert.strictEqual(lock.state, 'held');
  assert.deepStrictEqual(timeouts, [21 * 60000, 2 * 60000]);
  assert.deepStrictEqual(cfgs.map(c => c.maxMs), [22 * 60000, 3 * 60000]);
  cfgs.forEach((c, i) => assert.ok(c.maxMs > timeouts[i], `watcher ${i} outlasts its call`));
});

// ---- #237 L8 (Dexter 5): the re-entrant path says why a dead-looking holder still counts as live ----
test('#237 Dexter 5: flag set, the holder it names is dead, its work record is corrupt: re-entrant, and the #112 "can\'t be read" line is said', () => {
  const fs = require('fs');
  const file = path.join(tmpDir('hl-d5-'), 'w.json');
  fs.writeFileSync(file, '{"owner":"npm test (pid 5000 start 777)","work":[{"pid":60');   // damaged
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  r.env[ENV_VAR] = DEAD;
  const lock = acquire({ label: 'probe', pid: 8, ...r.deps(), work: createWorkStore(file) });
  assert.strictEqual(lock.state, 'reentrant');
  assert.ok(r.log.some(m => /work record of npm test \(pid 5000 start 777\) \(since 09:00:00\) can't be read/.test(m)), JSON.stringify(r.log));
  assert.strictEqual(of(r, '-Release').length, 0);
});

// ---- #237 L9 (Dexter 6, Miguel S1, S3): every give-up ends on one proper [heavy-lock] line ----
function timedOutRig(status) {
  // The -Acquire call is killed by its own wait + 1 timer: status null, ETIMEDOUT, 21 minutes on the clock.
  const r = rig({ acquireOverride: (rr) => { rr.clock.t = 21 * 60000; return { status: null, stdout: '[ETIMEDOUT spawnSync C:\\Windows\\powershell.exe ETIMEDOUT]' }; } });
  const run = r.run;
  r.run = (args, o) => (args.length === 0 && r.clock.t > 0 ? (r.calls.push(args), status) : run(args, o));
  return r;
}

test('#237 Dexter 6: an -Acquire killed by its own timer under a holder is "lock busy", names the holder, and says it was stopped', () => {
  const r = timedOutRig({ status: 0, stdout: 'held: hub: probes (since 10:00:00)' });
  let err = null;
  try { acquire({ label: 'x', pid: 7, ...r.deps() }); } catch (e) { err = e; }
  assert.ok(err instanceof HeavyLockError);
  assert.strictEqual(err.code, 'busy');
  assert.strictEqual(err.holder, 'hub: probes (since 10:00:00)');
  assert.strictEqual(err.timedOut, true);
  assert.strictEqual(notRunLine(err), '[heavy-lock] lock busy for 21 min (heavy-lock.ps1 ran past its wait and was stopped), held by hub: probes (since 10:00:00): NOT RUN');
});

test('#237 Dexter 6: killed by its timer with the slot free is "machine busy"; with the status unreadable it still says lock busy, not "exit null"', () => {
  const free = timedOutRig({ status: 0, stdout: 'free\nload: 3 GB free RAM, 95% CPU' });
  let e1 = null;
  try { acquire({ label: 'x', pid: 7, ...free.deps() }); } catch (e) { e1 = e; }
  assert.strictEqual(e1.code, 'loaded');
  assert.match(notRunLine(e1), /^\[heavy-lock\] machine busy after a 21 min wait \(heavy-lock\.ps1 ran past its wait and was stopped\): the lock is free/);
  const dark = timedOutRig({ status: null, stdout: '[ETIMEDOUT]' });
  let e2 = null;
  try { acquire({ label: 'x', pid: 7, ...dark.deps() }); } catch (e) { e2 = e; }
  assert.strictEqual(e2.code, 'busy');
  assert.strictEqual(notRunLine(e2), '[heavy-lock] lock busy for 21 min (heavy-lock.ps1 ran past its wait and was stopped), held by a holder its status could not name: NOT RUN');
  assert.doesNotMatch(notRunLine(e2), /exit null/);
});

test('#237 Miguel S1: the NOT RUN line is ONE physical line starting [heavy-lock], whatever the script printed', () => {
  const lines = [
    notRunLine(new HeavyLockError('error', 'heavy-lock.ps1 failed (exit 1): At line:1 char:1\r\n+ boom\r\n    + CategoryInfo')),
    notRunLine(new HeavyLockError('busy', 'x', { holder: 'a\nb (pid 1 start 2)', waitedMs: 60000 })),
    notRunLine(new HeavyLockError('loaded', 'x', { detail: '3 GB\r\nfree', waitedMs: 60000 })),
    notRunLine(new Error('a\nb')),
  ];
  for (const l of lines) {
    assert.strictEqual(l.split(/\r?\n/).length, 1, JSON.stringify(l));
    assert.match(l, /^\[heavy-lock\] .*: NOT RUN$/);
  }
});

test('#237 Miguel S1: with no wait time known the lines still read right', () => {
  assert.strictEqual(notRunLine(new HeavyLockError('loaded', 'x')), `[heavy-lock] machine busy after the whole wait: the lock is free, but its load gate needs 8 GB free RAM and under 70% CPU: NOT RUN`);
  assert.strictEqual(notRunLine(new HeavyLockError('busy', 'x', { holder: 'h' })), '[heavy-lock] lock busy for the whole wait, held by h: NOT RUN');
  assert.doesNotMatch(notRunLine(new HeavyLockError('loaded', 'x')), /a the whole wait wait/);
});

// ---- #237 L12 (Miguel M6): the status is parsed in one place ----
test('#237 Miguel M6: parseStatus reads every status line the script prints, and the watcher uses it and LOAD_GATE', () => {
  const { parseStatus, LOAD_GATE } = require('../host/heavy-lock');
  assert.deepStrictEqual(parseStatus('held: npm test (pid 1 start 2) (since 10:00:00)\nqueue 1: a\nqueue 2: b\nload: 20 GB free RAM, 10% CPU'),
    { held: 'npm test (pid 1 start 2) (since 10:00:00)', free: false, queued: 2, load: '20 GB free RAM, 10% CPU' });
  assert.deepStrictEqual(parseStatus('free'), { held: null, free: true, queued: 0, load: null });
  assert.deepStrictEqual(parseStatus('held: '), { held: '', free: false, queued: 0, load: null }, 'an empty holder line is a line');
  assert.deepStrictEqual(parseStatus(null), { held: null, free: false, queued: 0, load: null });
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'heavy-lock-watch.js'), 'utf8');
  assert.ok(!src.includes('8 GB free RAM'), 'the gate is heavy.LOAD_GATE, never re-typed');
  assert.ok(!/\/\^held: /.test(src), 'no status regex of its own');
  assert.strictEqual(LOAD_GATE, '8 GB free RAM and under 70% CPU');
});
