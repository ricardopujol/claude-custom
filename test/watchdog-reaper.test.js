'use strict';
// BACKLOG #228 step 4: test/watchdog-reaper.js, the after-hook that ends every shutdown watchdog a test started and reports a leak.
// PR #259 Miguel R1/Y3: a pid is ours only while its handle runs, or when it was created while our child lived. Y1: a failed listing throws.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createReaper, parseRows, MARK, SPAWN_SLACK_MS } = require('./watchdog-reaper');

function fakeTable(rows) {
  const killed = [];
  const table = { rows, killed };
  table.list = () => table.rows.slice();
  table.kill = (pid) => { killed.push(pid); table.rows = table.rows.filter((r) => r.pid !== pid); };
  return table;
}
const noSleep = async () => {};
const handle = (pid, alive = true) => { const h = () => {}; h.pid = pid; h.running = () => alive; return h; };
// A fake spawned child: alive until exit(); `exit()` emits 'exit' like a ChildProcess.
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.exitCode = null; c.signalCode = null;
  c.exit = () => { c.exitCode = 0; c.emit('exit', 0, null); };
  return c;
}

test('reap: a tracked watchdog whose handle still runs after the grace is killed by pid and reported', async () => {
  const t = fakeTable([{ pid: 10, ppid: 1, created: 5 }, { pid: 11, ppid: 1, created: 5 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep });
  r.track(handle(10));
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), [10]);
  assert.deepStrictEqual(t.killed, [10], 'an untracked watchdog (another run\'s) is left alone');
});

test('R1: a tracked watchdog whose handle says it exited is never killed, though a MARK row now holds its pid', async () => {
  const t = fakeTable([{ pid: 10, ppid: 1, created: 5 }]);   // a stranger's watchdog that got the freed pid
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep });
  r.track(handle(10, false));
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), []);
  assert.deepStrictEqual(t.killed, []);
});

test('R1: a handle that stops running during the grace stops being a candidate', async () => {
  const t = fakeTable([{ pid: 10, ppid: 1, created: 5 }]);
  let alive = true;
  const h = handle(10); h.running = () => alive;
  let polls = 0;
  const r = createReaper({ list: () => { if (++polls === 2) alive = false; return t.list(); }, kill: t.kill, sleep: noSleep });
  r.track(h);
  assert.deepStrictEqual(await r.reap({ graceMs: 60000 }), []);
  assert.deepStrictEqual(t.killed, []);
});

test('the parent route: a watchdog created while our child lived is ours, alive parent or not', async () => {
  let clock = 1000;
  const t = fakeTable([{ pid: 20, ppid: 500, created: 1500 }, { pid: 21, ppid: 501, created: 1500 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep, now: () => clock });
  const child = fakeChild(500);
  r.trackParent(child);
  clock = 2000; child.exit();
  clock = 9000;
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), [20]);
  assert.deepStrictEqual(t.killed, [20]);
});

test('R1: a watchdog created AFTER our child exited is not ours, though its stale parent pid matches', async () => {
  let clock = 1000;
  const t = fakeTable([{ pid: 20, ppid: 500, created: 2001 }]);   // a stranger took pid 500 after the exit and armed a watchdog
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep, now: () => clock });
  const child = fakeChild(500);
  r.trackParent(child);
  clock = 2000; child.exit();
  clock = 9000;
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), []);
  assert.deepStrictEqual(t.killed, []);
});

test('R1: a watchdog created BEFORE our child was spawned (an older holder of the pid) is not ours', async () => {
  const clock = 10000;
  const t = fakeTable([{ pid: 20, ppid: 500, created: clock - SPAWN_SLACK_MS - 1 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep, now: () => clock });
  r.trackParent(fakeChild(500));
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), []);
});

test('the parent route without a creation time counts only while the parent is alive; a child already gone at track counts never', async () => {
  let clock = 1000;
  const t = fakeTable([{ pid: 20, ppid: 500, created: NaN }, { pid: 22, ppid: 502, created: 1500 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep, now: () => clock });
  const child = fakeChild(500);
  r.trackParent(child);
  const gone = fakeChild(502); gone.exitCode = 1;
  r.trackParent(gone);
  clock = 2000; child.exit();
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), []);
  const r2 = createReaper({ list: t.list, kill: t.kill, sleep: noSleep, now: () => clock });
  r2.trackParent(fakeChild(500));
  assert.deepStrictEqual(await r2.reap({ graceMs: 0 }), [20], 'alive parent: its pid cannot have been reused');
});

test('reap: a watchdog that leaves on its own within the grace is no leak', async () => {
  const t = fakeTable([{ pid: 30, ppid: 1, created: 5 }]);
  let polls = 0;
  const r = createReaper({ list: () => (++polls > 2 ? [] : t.list()), kill: t.kill, sleep: noSleep });
  r.track(handle(30));
  assert.deepStrictEqual(await r.reap({ graceMs: 60000 }), []);
  assert.deepStrictEqual(t.killed, []);
});

test('reap: nothing tracked lists nothing and kills nothing; junk is not tracked', async () => {
  let listed = 0;
  const r = createReaper({ list: () => { listed += 1; return [{ pid: 1, ppid: 0, created: 0 }]; }, kill: () => assert.fail('no kill'), sleep: noSleep });
  for (const junk of [null, undefined, 7, { pid: 7 }, { pid: 0, running: () => true }, { pid: 1.5, running: () => true }]) { r.track(junk); r.trackParent(junk); }
  assert.deepStrictEqual(await r.reap(), []);
  assert.strictEqual(listed, 0);
});

test('reap: the tracked set is cleared, so a second reap does not re-kill', async () => {
  const t = fakeTable([{ pid: 40, ppid: 1, created: 5 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep });
  r.track(handle(40));
  await r.reap({ graceMs: 0 });
  t.rows.push({ pid: 40, ppid: 1, created: 5 });
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), []);
  assert.deepStrictEqual(t.killed, [40]);
});

test('Y1: a listing that fails is an error, never "no leak"; nothing is killed and the tracked set is still cleared', async () => {
  const kills = [];
  const r = createReaper({ list: () => { throw new Error('watchdog listing failed: ETIMEDOUT'); }, kill: (p) => kills.push(p), sleep: noSleep });
  r.track(handle(10));
  await assert.rejects(r.reap({ graceMs: 0 }), /listing failed: ETIMEDOUT/);
  assert.deepStrictEqual(kills, []);
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), [], 'cleared');
});

test('Y1: listWatchdogs throws on a spawn error, a timeout, a non-zero exit; it reads the rows of a clean one', () => {
  const { listWatchdogs } = require('./watchdog-reaper');
  const answers = [
    [{ error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '' }, /ETIMEDOUT/],
    [{ status: 1, stdout: '', stderr: 'This script contains malicious content and has been blocked' }, /exited 1: This script contains malicious content/],
    [{ status: null, signal: 'SIGTERM', stdout: '' }, /exited on SIGTERM/],
  ];
  for (const [r, why] of answers) assert.throws(() => listWatchdogs({ spawnSyncImpl: () => r }), why);
  const ok = process.platform === 'win32' ? '12 34 1700000000123\r\n' : `12 34 node ${MARK} 1 2 x\n99 1 node other.js\n`;
  const rows = listWatchdogs({ spawnSyncImpl: () => ({ status: 0, stdout: ok }) });
  assert.deepStrictEqual(rows.map((x) => [x.pid, x.ppid]), [[12, 34]]);
});

test('parseRows reads "pid ppid [created]" lines and skips the rest', () => {
  assert.deepStrictEqual(parseRows('12 34 1700000000123\r\n  56 78\nnoise\n9\n1 2 3 4'),
    [{ pid: 12, ppid: 34, created: 1700000000123 }, { pid: 56, ppid: 78, created: NaN }]);
  assert.deepStrictEqual(parseRows(undefined), []);
});

test('a REAL watchdog still guarding a live host when its test ends is found, killed by pid and reported as a leak', async () => {
  const { armWatchdog } = require('../host/bounded-shutdown');
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const disarm = armWatchdog({ boundMs: 60000, pid: guarded.pid, killTree: () => {} });   // never disarmed: the leak
    const r = createReaper();
    r.track(disarm);
    await new Promise((res) => setTimeout(res, 300));   // let it start
    assert.deepStrictEqual(await r.reap({ graceMs: 300 }), [disarm.pid]);
    const until = Date.now() + 5000;
    while (disarm.running() && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(disarm.running(), false, 'the leaked watchdog is gone');
  } finally {
    guarded.kill();   // kill-ok(own-spawn): the child this test spawned
  }
});

test('a REAL watchdog armed inside a child that then exited is found by its creation inside that child\'s life', async () => {
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const mod = JSON.stringify(path.join(__dirname, '..', 'host', 'bounded-shutdown'));
    // The child arms a watchdog over `guarded` (alive for a minute) and exits at once: the watchdog outlives it, detached.
    const script = `require(${mod}).armWatchdog({ boundMs: 60000, pid: ${guarded.pid}, killTree: () => {} }); setTimeout(() => process.exit(0), 300);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
    const r = createReaper();
    r.trackParent(child);
    await new Promise((res) => child.on('exit', res));
    const leaked = await r.reap({ graceMs: 300 });
    assert.strictEqual(leaked.length, 1, `one watchdog, found through its dead parent: ${leaked}`);
  } finally {
    guarded.kill();   // kill-ok(own-spawn): the child this test spawned
  }
});

test('real processes: a live process naming bounded-watchdog.js is killed only while its handle runs', async () => {
  const keep = 'setTimeout(() => {}, 60000)';
  const fake = spawn(process.execPath, ['-e', keep, MARK], { stdio: 'ignore', windowsHide: true });
  const plain = spawn(process.execPath, ['-e', keep], { stdio: 'ignore', windowsHide: true });
  const running = (c) => () => c.exitCode === null && c.signalCode === null;
  try {
    const r = createReaper();
    r.track({ pid: fake.pid, running: running(fake) });
    r.track({ pid: plain.pid, running: running(plain) });
    const fakeExit = new Promise((res) => fake.on('exit', res));
    assert.deepStrictEqual(await r.reap({ graceMs: 300 }), [fake.pid]);
    await fakeExit;
    assert.strictEqual(plain.exitCode, null, 'a tracked pid whose command line is not a watchdog is never killed');
  } finally {
    fake.kill();    // kill-ok(own-spawn): the child this test spawned
    plain.kill();   // kill-ok(own-spawn): the child this test spawned
  }
});
