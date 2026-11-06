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
  r.deps = () => ({ run: r.run, exists: r.exists, env: r.env, log: (m) => r.log.push(m), startsOf: r.startsOf, work: r.workStore, now: () => r.clock.t });
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
  assert.strictEqual(r.env[ENV_VAR], '1');
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

test('re-entrant: the flag is exactly "1" and a live holder has the slot, so only its status is read and release is a no-op', () => {
  const r = rig({ holder: OUTER });
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'reentrant');
  assert.deepStrictEqual(r.calls, [[]], 'one status read, no acquire, no release');
  assert.strictEqual(lock.release(), false);
  assert.strictEqual(r.env[ENV_VAR], '1', 'a lock we did not take is not cleared');
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
    e instanceof HeavyLockError && e.code === 'busy' && /hub: probes/.test(e.message) && /HEAVY_LOCK_HELD=1/.test(e.message) && /[Ww]ait/.test(e.message));
  assert.strictEqual(r.env[ENV_VAR], undefined);
  assert.strictEqual(of(r, '-Release').length, 0, 'a manual holder is never touched');
});

test('too loaded (exit 3): throws, with the same next step', () => {
  const r = rig({ acquireOverride: { status: 3, stdout: 'machine too loaded: 4 GB free, 90% CPU' } });
  assert.throws(() => acquire({ label: 'x', pid: 7, ...r.deps() }), (e) => e.code === 'loaded' && /too loaded/.test(e.message) && /HEAVY_LOCK_HELD=1/.test(e.message));
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
  assert.throws(() => acquire({ label: 'x', pid: 7, exists: () => true, env: {}, log: () => {}, spawnFn, startsOf: () => new Map() }),
    (e) => e.code === 'error' && /ENOENT/.test(e.message));
});

test('Miguel r2 N3 / #112 Dexter 2: -Acquire is killed at the wait plus one minute; status and release get their own 1-minute leash', () => {
  const seen = [];
  const spawnFn = (cmd, args, o) => { seen.push({ kind: args.includes('-Acquire') ? 'acquire' : args.includes('-Release') ? 'release' : 'status', t: o.timeout }); return { status: 0, stdout: 'free' }; };
  const lock = acquire({ label: 'x', pid: 7, waitMinutes: 3, exists: () => true, env: {}, log: () => {}, spawnFn, startsOf: () => new Map(), work: createWorkStore(path.join(tmpDir('hl-n3-'), 'w.json')) });
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
  const a = procRig({ holder: OUTER }); a.r.env[ENV_VAR] = '1'; a.lock.ensure();
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
  const a = rig({ holder: OUTER }); a.env[ENV_VAR] = '1';
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
test('Dexter r2 5 / 2026-11-05: HEAVY_LOCK_HELD=1 under a live holder prints ONE line, naming that holder', () => {
  const r = rig({ holder: OUTER });
  r.env[ENV_VAR] = '1';
  acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.deepStrictEqual(r.log, [`[heavy-lock] HEAVY_LOCK_HELD=1 is set and the slot is held by ${OUTER}: not taking the lock (re-entrant, under that holder)`]);
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
  assert.match(r.log[0], /^\[heavy-lock\] WARNING: HEAVY_LOCK_HELD=1 is set but nobody holds the lock: a STALE variable in this shell\. Taking the lock for real; unset HEAVY_LOCK_HELD/);
  assert.strictEqual(lock.release(), true);
  assert.strictEqual(r.holder, null);
});

test('2026-11-05: the flag set + a provably dead holder is stale too: warned, the dead holder freed, the lock taken', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)` });
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'held');
  assert.match(r.log[0], /WARNING: HEAVY_LOCK_HELD=1 is set but the slot's holder is gone \(npm test \(pid 5000 start 777\) \(since 09:00:00\)\): a STALE variable/);
  assert.ok(r.log.some(m => /freed the slot of a dead holder/.test(m)));
});

test('2026-11-05: the flag set + a dead asker whose recorded work still runs is a LIVE holder: skip, named', () => {
  const r = rig({ holder: `${DEAD} (since 09:00:00)`, alive: { 6000: '900' }, work: WORK });
  r.env[ENV_VAR] = '1';
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
});

test('2026-11-05: HEAVY_LOCK_SCRIPT points the module at another script; a relative one is ignored', () => {
  const { SCRIPT_VAR } = require('../host/heavy-lock');
  assert.strictEqual(SCRIPT_VAR, 'HEAVY_LOCK_SCRIPT');
  const seen = [];
  const exists = (p) => { seen.push(p); return false; };
  const abs = path.join(tmpDir('hl-sv-'), 'nope.ps1');
  assert.strictEqual(acquire({ label: 'x', pid: 7, env: { [SCRIPT_VAR]: abs }, exists, log: () => {}, startsOf: () => new Map(), run: () => ({ status: 0 }) }).state, 'missing');
  assert.strictEqual(seen[0], abs);
  acquire({ label: 'x', pid: 7, env: { [SCRIPT_VAR]: 'rel\\x.ps1' }, exists, log: () => {}, startsOf: () => new Map(), run: () => ({ status: 0 }) });
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

test('#178 b: the watcher runs exactly around the wait, with the asker and its start, and is stopped whether the acquire holds or gives up', () => {
  for (const holder of [null, 'hub: probes (since 10:00:00)']) {
    const r = rig({ holder });
    const events = [];
    const deps = r.deps();
    const run = deps.run;
    deps.run = (args, o) => { if (args.includes('-Acquire')) events.push('acquire'); return run(args, o); };
    const watch = (cfg) => { events.push(['watch', cfg.parentPid, cfg.parentStart, cfg.waitMinutes, typeof cfg.startedAt]); return { stop: () => events.push('stop') }; };
    try { acquire({ label: 'x', pid: 7, waitMinutes: 20, watch, ...deps }); } catch (e) { assert.strictEqual(e.code, 'busy'); }
    assert.deepStrictEqual(events, [['watch', 7, '100', 20, 'number'], 'acquire', 'stop'], String(holder));
  }
});

test('#178 b: no watcher when nothing is waited for (re-entrant, script missing), and one that cannot start never stops the acquire', () => {
  let started = 0;
  const watch = () => { started++; return { stop() {} }; };
  const a = rig(); a.env[ENV_VAR] = '1'; a.holder = 'npm test (pid 1 start 100) (since 10:00:00)';
  acquire({ label: 'x', pid: 7, watch, ...a.deps() });
  const b = rig({ exists: false }); acquire({ label: 'x', pid: 7, watch, ...b.deps() });
  assert.strictEqual(started, 0);
  const c = rig();
  assert.strictEqual(acquire({ label: 'x', pid: 7, watch: () => { throw new Error('no node'); }, ...c.deps() }).state, 'held');
  const d = rig();
  assert.strictEqual(acquire({ label: 'x', pid: 7, watch: () => ({ stop() { throw new Error('gone'); } }), ...d.deps() }).state, 'held');
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

test('#178 b: the default watcher starts only on the real machine path: an injected run or spawn never starts a process', () => {
  // Both of these would spawn a real node if the default watcher ran; each finishes with no child left, and the fake spawn
  // sees only powershell calls.
  const cmds = [];
  const spawnFn = (cmd) => { cmds.push(cmd); return { status: 0, stdout: 'free' }; };
  acquire({ label: 'x', pid: 7, waitMinutes: 1, exists: () => true, env: {}, log: () => {}, spawnFn, startsOf: () => new Map(), work: createWorkStore(path.join(tmpDir('hl-nw-'), 'w.json')) });
  assert.ok(cmds.length > 0 && cmds.every(c => /powershell\.exe$/i.test(c)), JSON.stringify(cmds));
});

// ---- the watcher's one step (host/heavy-lock-watch.js) ----
const { watchTick } = require('../host/heavy-lock-watch');
function tickRig(over = {}) {
  const r = rig(over);
  const d = r.deps();
  return { r, d, tick: (extra = {}) => watchTick({ run: d.run, startsOf: d.startsOf, work: d.work, log: d.log, parentPid: 7, parentStart: '100', startedAt: 0, now: () => 3 * 60000 + 5000, ...extra }) };
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

test('#178 b watch: the asker gone (or its pid reused) ends the watcher before it reads or frees anything; "cannot tell" carries on', () => {
  for (const alive of [{ 7: undefined }, { 7: '999' }]) {
    const { r, tick } = tickRig({ holder: `${DEAD} (since 09:00:00)` });
    Object.assign(r.alive, alive);
    if (alive[7] === undefined) delete r.alive[7];
    assert.strictEqual(tick(), 'asker-gone');
    assert.strictEqual(r.calls.length, 0);
  }
  const t = tickRig({ holder: 'hub: probes (since 10:00:00)', startsFail: true });
  assert.strictEqual(t.tick(), 'waiting');
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
