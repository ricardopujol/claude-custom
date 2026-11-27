'use strict';
// BACKLOG #228 step 4: test/watchdog-reaper.js, the after-hook that ends every shutdown watchdog a test started and reports a leak.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createReaper, parsePairs, MARK } = require('./watchdog-reaper');

function fakeTable(rows) {
  const killed = [];
  const table = { rows, killed };
  table.list = () => table.rows.slice();
  table.kill = (pid) => { killed.push(pid); table.rows = table.rows.filter((r) => r.pid !== pid); };
  return table;
}
const noSleep = async () => {};

test('reap: a tracked watchdog still alive after the grace is killed by pid and reported', async () => {
  const t = fakeTable([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 1 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep });
  r.track(10);
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), [10]);
  assert.deepStrictEqual(t.killed, [10], 'an untracked watchdog (another run\'s) is left alone');
});

test('reap: a watchdog armed inside a spawned child is found by its parent pid', async () => {
  const t = fakeTable([{ pid: 20, ppid: 500 }, { pid: 21, ppid: 501 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep });
  r.trackParent(500);
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), [20]);
  assert.deepStrictEqual(t.killed, [20]);
});

test('reap: a watchdog that leaves on its own within the grace is no leak', async () => {
  const t = fakeTable([{ pid: 30, ppid: 1 }]);
  let polls = 0;
  const r = createReaper({ list: () => (++polls > 2 ? [] : t.list()), kill: t.kill, sleep: noSleep });
  r.track(30);
  assert.deepStrictEqual(await r.reap({ graceMs: 60000 }), []);
  assert.deepStrictEqual(t.killed, []);
});

test('reap: nothing tracked lists nothing and kills nothing; junk pids are not tracked', async () => {
  let listed = 0;
  const r = createReaper({ list: () => { listed += 1; return [{ pid: 1, ppid: 0 }]; }, kill: () => assert.fail('no kill'), sleep: noSleep });
  for (const p of [0, -1, 1.5, '7', null, undefined]) { r.track(p); r.trackParent(p); }
  assert.deepStrictEqual(await r.reap(), []);
  assert.strictEqual(listed, 0);
});

test('reap: the tracked set is cleared, so a second reap does not re-kill', async () => {
  const t = fakeTable([{ pid: 40, ppid: 1 }]);
  const r = createReaper({ list: t.list, kill: t.kill, sleep: noSleep });
  r.track(40);
  await r.reap({ graceMs: 0 });
  t.rows.push({ pid: 40, ppid: 1 });   // a new process that got the pid
  assert.deepStrictEqual(await r.reap({ graceMs: 0 }), []);
  assert.deepStrictEqual(t.killed, [40]);
});

test('parsePairs reads "pid ppid" lines and skips the rest', () => {
  assert.deepStrictEqual(parsePairs('12 34\r\n  56 78 node x\nnoise\n\n9'), [{ pid: 12, ppid: 34 }, { pid: 56, ppid: 78 }]);
  assert.deepStrictEqual(parsePairs(undefined), []);
});

test('a REAL watchdog still guarding a live host when its test ends is found, killed by pid and reported as a leak', async () => {
  const { armWatchdog } = require('../host/bounded-shutdown');
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const disarm = armWatchdog({ boundMs: 60000, pid: guarded.pid, killTree: () => {} });   // never disarmed: the leak
    const r = createReaper();
    r.track(disarm.pid);
    await new Promise((res) => setTimeout(res, 300));   // let it start
    assert.deepStrictEqual(await r.reap({ graceMs: 300 }), [disarm.pid]);
    const until = Date.now() + 5000;
    while (disarm.running() && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(disarm.running(), false, 'the leaked watchdog is gone');
  } finally {
    guarded.kill();   // kill-ok(own-spawn): the child this test spawned
  }
});

test('real processes: a live process naming bounded-watchdog.js that this file tracks is killed; one that does not name it is not', async () => {
  const keep = 'setTimeout(() => {}, 60000)';
  const fake = spawn(process.execPath, ['-e', keep, MARK], { stdio: 'ignore', windowsHide: true });
  const plain = spawn(process.execPath, ['-e', keep], { stdio: 'ignore', windowsHide: true });
  try {
    const r = createReaper();
    r.track(fake.pid);
    r.track(plain.pid);
    const fakeExit = new Promise((res) => fake.on('exit', res));
    assert.deepStrictEqual(await r.reap({ graceMs: 300 }), [fake.pid]);
    await fakeExit;
    assert.strictEqual(plain.exitCode, null, 'a tracked pid whose command line is not a watchdog is never killed');
  } finally {
    fake.kill();    // kill-ok(own-spawn): the child this test spawned
    plain.kill();   // kill-ok(own-spawn): the child this test spawned
  }
});
