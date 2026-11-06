'use strict';
/**
 * scripts/with-heavy-lock.js (BACKLOG #100 d): `npm test` runs through it. Pinned with a fake lock and a fake child:
 * the lock is taken before the command, released on every way it can end, and a busy lock means the command never runs.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { main } = require('../scripts/with-heavy-lock');
const { HeavyLockError, ENV_VAR, NOT_RUN_EXIT } = require('../host/heavy-lock');

function rig({ acquireThrows = null, state = 'held' } = {}) {
  const events = [];
  const child = new EventEmitter();
  child.pid = 4242;
  const proc = new EventEmitter();
  let spawned = null;
  const deps = {
    acquire: (o) => {
      events.push('acquire:' + o.label);
      if (acquireThrows) throw acquireThrows;
      let done = false;
      return { state, addWork: (pid, start) => { events.push('work:' + pid); if (start === null) events.push('provisional:' + pid); return true; }, release: () => { if (done) return false; done = true; events.push('release'); return state === 'held'; } };
    },
    spawn: (cmd, args, opts) => { events.push('spawn'); spawned = { cmd, args, opts }; return child; },
    killFn: (pid) => events.push('kill:' + pid),
    proc, log: (m) => events.push('log:' + m), env: { A: 'a' },
  };
  return { events, child, proc, deps, spawned: () => spawned };
}
const plain = (r) => r.events.filter(e => !e.startsWith('log:') && !e.startsWith('work:') && !e.startsWith('provisional:'));

test('runs the command under the lock, passes the re-entrancy flag, returns its exit code, releases after', async () => {
  const r = rig();
  const p = main(['node', '--test', 'x'], r.deps);
  r.child.emit('exit', 3, null);
  assert.strictEqual(await p, 3);
  assert.deepStrictEqual(plain(r), ['acquire:npm test', 'spawn', 'release']);
  assert.strictEqual(r.spawned().cmd, 'node');
  assert.deepStrictEqual(r.spawned().args, ['--test', 'x']);
  assert.strictEqual(r.spawned().opts.env[ENV_VAR], '1');
  assert.strictEqual(r.spawned().opts.env.A, 'a');
  assert.strictEqual(r.spawned().opts.stdio, 'inherit');
});

test('exit code 0 passes through', async () => {
  const r = rig();
  const p = main(['node', '-v'], r.deps);
  r.child.emit('exit', 0, null);
  assert.strictEqual(await p, 0);
});

test('a child killed by a signal is a non-zero result, and the lock is released', async () => {
  const r = rig();
  const p = main(['node'], r.deps);
  r.child.emit('exit', null, 'SIGKILL');
  assert.notStrictEqual(await p, 0);
  assert.ok(r.events.includes('release'));
});

test('error path: the command cannot start, the lock is released and the result is non-zero', async () => {
  const r = rig();
  const p = main(['nope'], r.deps);
  r.child.emit('error', new Error('ENOENT'));
  assert.strictEqual(await p, 1);
  assert.ok(r.events.includes('release'));
  assert.ok(r.events.some(e => e.startsWith('log:') && /ENOENT/.test(e)));
});

test('a spawn that throws releases the lock and is non-zero', async () => {
  const r = rig();
  r.deps.spawn = () => { throw new Error('boom'); };
  assert.strictEqual(await main(['node'], r.deps), 1);
  assert.ok(r.events.includes('release'));
});

test('SIGINT: the child tree is killed by its pid, the lock is released once, the result is 130', async () => {
  const r = rig();
  const p = main(['node'], r.deps);
  r.proc.emit('SIGINT');
  assert.ok(r.events.includes('kill:4242'));
  r.child.emit('exit', null, 'SIGTERM');
  assert.strictEqual(await p, 130);
  assert.strictEqual(r.events.filter(e => e === 'release').length, 1);
});

test('SIGTERM gives 143', async () => {
  const r = rig();
  const p = main(['node'], r.deps);
  r.proc.emit('SIGTERM');
  r.child.emit('exit', null, 'SIGTERM');
  assert.strictEqual(await p, 143);
});

test('the signal listeners are removed when the run ends', async () => {
  const r = rig();
  const p = main(['node'], r.deps);
  r.child.emit('exit', 0, null);
  await p;
  assert.strictEqual(r.proc.listenerCount('SIGINT'), 0);
});

test('busy: says who holds it, returns NOT_RUN_EXIT, and never runs the command', async () => {
  const r = rig({ acquireThrows: new HeavyLockError('busy', 'busy: hub: probes (since 10:00:00)') });
  assert.strictEqual(await main(['node'], r.deps), NOT_RUN_EXIT);
  assert.ok(!r.events.includes('spawn'));
  assert.ok(r.events.some(e => e.startsWith('log:') && /hub: probes/.test(e)));
  assert.ok(!r.events.includes('release'));
});

test('re-entrant (already under the lock): runs the command and passes its code through', async () => {
  const r = rig({ state: 'reentrant' });
  const p = main(['node'], r.deps);
  r.child.emit('exit', 0, null);
  assert.strictEqual(await p, 0);
  assert.ok(r.events.includes('spawn'));
});

test('no command given: usage, non-zero, no lock taken', async () => {
  const r = rig();
  assert.strictEqual(await main([], r.deps), 2);
  assert.ok(!r.events.some(e => e.startsWith('acquire')));
});

// Dexter 2 / 5, Miguel S3 / S5
test('SIGHUP (a closed console): the tree is killed, THEN the slot is released, both before the child\'s exit event; result 129', async () => {
  const r = rig();
  const p = main(['node'], r.deps);
  r.proc.emit('SIGHUP');
  assert.deepStrictEqual(plain(r), ['acquire:npm test', 'spawn', 'kill:4242', 'release']);
  r.child.emit('exit', null, 'SIGTERM');
  assert.strictEqual(await p, 129);
  assert.strictEqual(r.events.filter(e => e === 'release').length, 1);
});

test('SIGINT and SIGTERM also kill first and release at once', async () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const r = rig();
    const p = main(['node'], r.deps);
    r.proc.emit(sig);
    assert.deepStrictEqual(plain(r).slice(-2), ['kill:4242', 'release'], sig);
    r.child.emit('exit', null, null);
    await p;
  }
});

test('the process exiting under it (no child exit seen) still releases', async () => {
  const r = rig();
  main(['node'], r.deps);
  r.proc.emit('exit', 1);
  assert.ok(r.events.includes('release'));
});

test('a busy lock says what to do next and the command never runs', async () => {
  const r = rig({ acquireThrows: new HeavyLockError('busy', 'busy: hub. Wait and retry; if you hold the lock by hand, set HEAVY_LOCK_HELD=1') });
  assert.strictEqual(await main(['node'], r.deps), NOT_RUN_EXIT);
  assert.ok(r.events.some(e => e.startsWith('log:') && /HEAVY_LOCK_HELD=1/.test(e)));
});

test('#178 b: a lock that stays busy ends with the NOT RUN line LAST and exit 75, distinct from a failing suite\'s 1', async () => {
  const err = new HeavyLockError('busy', 'busy: npm test (pid 5 start 6) (since 10:00:00). Wait and retry', { holder: 'npm test (pid 5 start 6) (since 10:00:00)', waitedMs: 20 * 60000 });
  const r = rig({ acquireThrows: err });
  const code = await main(['node'], r.deps);
  assert.strictEqual(code, 75);
  assert.notStrictEqual(code, 1);
  const logs = r.events.filter(e => e.startsWith('log:'));
  assert.strictEqual(logs[logs.length - 1], 'log:[heavy-lock] lock busy for 20 min, held by npm test (pid 5 start 6) (since 10:00:00): NOT RUN');
  assert.ok(!r.events.includes('spawn'));
});

test('#178 b: too loaded, a script failure, or any other throw from acquire is NOT RUN too (75), never a test failure', async () => {
  for (const err of [new HeavyLockError('loaded', 'machine too loaded', { detail: '4 GB free, 90% CPU', waitedMs: 60000 }), new HeavyLockError('error', 'heavy-lock.ps1 failed (exit 1): x'), new Error('weird')]) {
    const r = rig({ acquireThrows: err });
    assert.strictEqual(await main(['node'], r.deps), 75, err.message);
    const logs = r.events.filter(e => e.startsWith('log:'));
    assert.match(logs[logs.length - 1], /: NOT RUN$/);
  }
});

test('#178 b (hub): a load-gated give-up ends "machine busy", a held slot "lock busy": the last line tells them apart, both exit 75', async () => {
  const loaded = rig({ acquireThrows: new HeavyLockError('loaded', 'machine too loaded: 4 GB free, 90% CPU', { detail: '4 GB free, 90% CPU', waitedMs: 20 * 60000 }) });
  assert.strictEqual(await main(['node'], loaded.deps), 75);
  const busy = rig({ acquireThrows: new HeavyLockError('busy', 'busy: hub', { holder: 'hub (since 10:00:00)', waitedMs: 20 * 60000 }) });
  assert.strictEqual(await main(['node'], busy.deps), 75);
  const last = (r) => { const logs = r.events.filter(e => e.startsWith('log:')); return logs[logs.length - 1].slice(4); };
  assert.match(last(loaded), /^\[heavy-lock\] machine busy after a 20 min wait: the lock is free, but its load gate needs 8 GB free RAM and under 70% CPU \(now 4 GB free, 90% CPU\): NOT RUN$/);
  assert.match(last(busy), /^\[heavy-lock\] lock busy for 20 min, held by hub \(since 10:00:00\): NOT RUN$/);
});

test('#178 b: the wrapper\'s header documents the NOT RUN exit code, and verify/README.md does too', () => {
  const fs = require('fs');
  const path = require('path');
  const header = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'with-heavy-lock.js'), 'utf8').split('*/')[0];
  assert.match(header, /NOT RUN: EXIT 75/);
  assert.match(header, /lock busy for <n> min, held by <owner>: NOT RUN/);
  assert.match(header, /machine busy after a <n> min wait/);
  assert.match(header, /load gate's time counts against the same\s+\*?\s*wait/);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'verify', 'README.md'), 'utf8');
  assert.match(readme, /exit code is \*\*75\*\*/);
  assert.match(readme, /\[heavy-lock\] machine busy after a 20 min wait: the lock is free/);
});

test('Dexter r2 1: the suite\'s child pid is recorded as work right after it starts, before it can end', async () => {
  const r = rig();
  const p = main(['node', '--test'], r.deps);
  r.child.emit('exit', 0, null);
  await p;
  assert.deepStrictEqual(r.events.filter(e => !e.startsWith('log:')), ['acquire:npm test', 'spawn', 'work:4242', 'provisional:4242', 'work:4242', 'release']);
});

test('Dexter r2 1: a lock without addWork (or one that throws) does not stop the command', async () => {
  const r = rig();
  const real = r.deps.acquire;
  r.deps.acquire = (o) => { const l = real(o); l.addWork = () => { throw new Error('disk'); }; return l; };
  const p = main(['node'], r.deps);
  r.child.emit('exit', 0, null);
  assert.strictEqual(await p, 0);
});

test('BACKLOG #112: a hard kill during the start-time query still leaves the suite listed (provisional record first)', async () => {
  const { acquire, createWorkStore } = require('../host/heavy-lock');
  const { tmpDir } = require('./tmp-dir');
  const path = require('path');
  const r = rig();
  const store = createWorkStore(path.join(tmpDir('hl-gap-'), 'w.json'));
  let seen = null, owner = null;
  r.deps.acquire = (o) => acquire({
    ...o, scriptPath: 'x', exists: () => true, work: store,
    run: (args) => (args.includes('-Acquire') ? (owner = args[args.indexOf('-Owner') + 1], { status: 0, stdout: 'acquired' }) : { status: 0, stdout: 'ok' }),
    // The slow start query: this is the moment a hard kill of the wrapper would land. The record then is what a later asker sees.
    startsOf: (pids) => {
      if (pids.includes(4242)) seen = store.read(owner);
      return new Map(pids.map(p => [p, '100']));
    },
  });
  const p = main(['node', '--test'], r.deps);
  r.child.emit('exit', 0, null);
  await p;
  assert.deepStrictEqual(seen, [{ pid: 4242, start: null }], 'listed with an unknown start before the query returned');
});
