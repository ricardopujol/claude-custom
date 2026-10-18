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
const {
  acquire, release, createProcessLock, HeavyLockError, ENV_VAR, WAIT_VAR, DEFAULT_SCRIPT, DEFAULT_WAIT_MINUTES,
  ownerFor, parseOwner, defaultRun, queryStarts, createWorkStore,
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
    add: (owner, pid, start) => { if (!r.work || r.work.owner !== owner) r.work = { owner, work: [] }; r.work.work.push({ pid, start }); },
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

test('re-entrant: the flag is exactly "1", so nothing is asked of the script and release is a no-op', () => {
  const r = rig();
  r.env[ENV_VAR] = '1';
  const lock = acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(lock.state, 'reentrant');
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(lock.release(), false);
  assert.strictEqual(r.env[ENV_VAR], '1', 'a lock we did not take is not cleared');
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

test('Dexter 1: wait defaults to 7 minutes, under the Bash tool\'s 10-minute cap, and HEAVY_LOCK_WAIT_MINUTES changes it', () => {
  assert.strictEqual(DEFAULT_WAIT_MINUTES, 7);
  assert.ok(DEFAULT_WAIT_MINUTES < 10);
  const a = rig(); acquire({ label: 'x', pid: 7, ...a.deps() });
  assert.strictEqual(flagValue(of(a, '-Acquire')[0], '-WaitMinutes'), '7');
  const b = rig(); b.env[WAIT_VAR] = '3'; acquire({ label: 'x', pid: 7, ...b.deps() });
  assert.strictEqual(flagValue(of(b, '-Acquire')[0], '-WaitMinutes'), '3');
  for (const bad of ['0', '-2', 'abc', '1.5', '']) {
    const c = rig(); c.env[WAIT_VAR] = bad; acquire({ label: 'x', pid: 7, ...c.deps() });
    assert.strictEqual(flagValue(of(c, '-Acquire')[0], '-WaitMinutes'), '7', bad);
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

test('Miguel r2 N3: acquire\'s spawn timeout is the wait plus one minute (its own deadline, then a margin)', () => {
  const opts = [];
  const spawnFn = (cmd, args, o) => { opts.push(o.timeout); return { status: 0, stdout: 'free' }; };
  acquire({ label: 'x', pid: 7, waitMinutes: 3, exists: () => true, env: {}, log: () => {}, spawnFn, startsOf: () => new Map() });
  assert.ok(opts.length >= 1);
  assert.ok(opts.every(t => t === 4 * 60000), JSON.stringify(opts));
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
  const a = procRig(); a.r.env[ENV_VAR] = '1'; a.lock.ensure();
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
  const a = rig(); a.env[ENV_VAR] = '1';
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
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hl-work-'));
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    assert.strictEqual(acquire({ label: 'x', pid: 7, ...deps }).state, 'held');
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
test('Dexter r2 5: HEAVY_LOCK_HELD=1 prints one line saying the lock is not being taken', () => {
  const r = rig();
  r.env[ENV_VAR] = '1';
  acquire({ label: 'x', pid: 7, ...r.deps() });
  assert.strictEqual(r.log.length, 1);
  assert.match(r.log[0], /HEAVY_LOCK_HELD=1 is set: not taking the lock/);
});
