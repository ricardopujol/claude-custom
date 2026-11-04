'use strict';
/**
 * host/job-guard.js (BACKLOG #127): the PowerShell helper that keeps every process the session starts in a kill-on-close Job Object.
 * Pure here: a fake spawn stands in for the helper. The real job is measured by verify/probe-kill-switch-detached.js and the
 * real-process test at the bottom of this file.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createJobGuard, helperScript } = require('../host/job-guard');

// A fake helper: stdout/stdin are emitters, `kill()` records and exits it, `say()` prints a line.
function fakeHelper() {
  const h = new EventEmitter();
  h.pid = 4242;
  h.exitCode = null;
  h.signalCode = null;
  h.stdout = new EventEmitter();
  h.stdout.unref = () => {};
  h.stdin = Object.assign(new EventEmitter(), { written: [], ended: false, unref() {}, write(s) { this.written.push(s); }, end() { this.ended = true; } });
  h.killed = 0;
  h.kill = () => { h.killed++; h.exitCode = 1; h.emit('exit', 1, null); return true; };
  h.unref = () => {};
  h.say = (line) => h.stdout.emit('data', Buffer.from(line + '\n'));
  return h;
}
function guardWith(h, extra = {}) {
  const spawned = [];
  const g = createJobGuard({ spawnFn: (...a) => { spawned.push(a); return h; }, platform: 'win32', powershell: 'PS.exe', timeoutMs: 50, ...extra });
  return { g, spawned };
}
const tick = () => new Promise((r) => setImmediate(r));

test('helperScript: names the pid, creates a kill-on-close job, and disarms on DISARM or end of input', () => {
  const s = helperScript(777);
  assert.match(s, /\[CcJob\]::Make\(777\)/);
  assert.match(s, /0x2000/, 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
  assert.match(s, /\$null -eq \$line -or \$line -eq 'DISARM'/, 'end of input (the host is gone) disarms, it never kills');
  for (const bad of [0, -1, 1.5, '7', null, NaN]) assert.throws(() => helperScript(bad), /pid/, String(bad));
});

test('attach: runs PowerShell with the script encoded (no quoting to get wrong) and arms on READY with the start proven', async () => {
  const h = fakeHelper();
  const { g, spawned } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234', exited: () => false });
  const [exe, args, opts] = spawned[0];
  assert.strictEqual(exe, 'PS.exe');
  assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.strictEqual(Buffer.from(args[3], 'base64').toString('utf16le'), helperScript(777));
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(g.state(), 'attaching');
  h.say('READY 286 1234');
  assert.deepStrictEqual(await p, { ok: true, ms: 286, start: '1234' });
  assert.strictEqual(g.state(), 'armed');
});

test('attach: a start time the pty does not have means the helper opened a stranger: the job is disarmed, never armed', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '9999', exited: () => false });
  h.say('READY 286 1234');
  assert.deepStrictEqual(await p, { ok: false, reason: 'start-mismatch' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  assert.strictEqual(g.kill(), false, 'a disarmed job is never killed');
  assert.strictEqual(h.killed, 0);
});

test('attach: a pty that already exited is disarmed (its pid may be someone else\'s now)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234', exited: () => true });
  h.say('READY 10 1234');
  assert.deepStrictEqual(await p, { ok: false, reason: 'target-exited' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
});

test('attach: a start time that could not be read does not stop the guard (the pty was spawned a moment ago and has not exited)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => null, exited: () => false });
  h.say('READY 10 1234');
  assert.strictEqual((await p).ok, true);
  assert.strictEqual(g.state(), 'armed');
});

test('attach: FAILED from the helper is not armed, and says why', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777 });
  h.say('FAILED AssignProcessToJobObject 5');
  assert.deepStrictEqual(await p, { ok: false, reason: 'failed: AssignProcessToJobObject 5' });
  assert.strictEqual(g.state(), 'failed');
  assert.strictEqual(g.kill(), false);
});

test('attach: a helper that never answers is told to DISARM, never killed (it may have armed the job already)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const r = await g.attach({ pid: 777 });
  assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  assert.strictEqual(h.killed, 0);
});

test('attach: a helper that exits before it answers, or cannot start, is not armed', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777 });
  h.exitCode = 1; h.emit('exit', 1, null);
  assert.deepStrictEqual(await p, { ok: false, reason: 'helper-exited' });
  const g2 = createJobGuard({ spawnFn: () => { throw new Error('ENOENT'); }, platform: 'win32' });
  assert.deepStrictEqual(await g2.attach({ pid: 777 }), { ok: false, reason: 'spawn-failed' });
});

test('attach: off Windows, or with a bad pid, nothing is spawned', async () => {
  let spawns = 0;
  const spawnFn = () => { spawns++; return fakeHelper(); };
  assert.deepStrictEqual(await createJobGuard({ spawnFn, platform: 'linux' }).attach({ pid: 5 }), { ok: false, reason: 'not-windows' });
  for (const pid of [0, -3, 2.5, '5', undefined]) assert.deepStrictEqual(await createJobGuard({ spawnFn, platform: 'win32' }).attach({ pid }), { ok: false, reason: 'bad-pid' }, String(pid));
  assert.strictEqual(spawns, 0);
});

test('kill: ends the helper by its own handle, once; the job closing with it ends every process in it', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  await p;
  assert.strictEqual(g.kill(), true);
  assert.strictEqual(h.killed, 1);
  assert.strictEqual(g.state(), 'ended');
  assert.strictEqual(g.kill(), false, 'a second ask (the stopper\'s retry) does nothing');
  assert.strictEqual(h.killed, 1);
});

test('kill: before anything was attached it does nothing', () => {
  assert.strictEqual(createJobGuard({ platform: 'win32' }).kill(), false);
});

test('disarm: writes DISARM and closes stdin, so the job lets everything live; kill after that does nothing', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  await p;
  g.disarm();
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  assert.strictEqual(h.stdin.ended, true);
  assert.strictEqual(g.state(), 'released');
  assert.strictEqual(g.kill(), false);
  assert.strictEqual(h.killed, 0);
});

test('a second attach releases the first helper instead of killing it', async () => {
  const first = fakeHelper();
  const second = fakeHelper();
  const helpers = [first, second];
  const g = createJobGuard({ spawnFn: () => helpers.shift(), platform: 'win32', timeoutMs: 50 });
  const p1 = g.attach({ pid: 1, startOf: async () => '1', exited: () => false });
  first.say('READY 5 1');
  await p1;
  const p2 = g.attach({ pid: 2, startOf: async () => '2', exited: () => false });
  assert.deepStrictEqual(first.stdin.written, ['DISARM\n']);
  assert.strictEqual(first.killed, 0);
  second.say('READY 5 2');
  assert.strictEqual((await p2).ok, true);
  await tick();
});

test('a logger that throws never breaks the guard', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h, { log: () => { throw new Error('log'); } });
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  assert.strictEqual((await p).ok, true);
});

// --- the real thing -------------------------------------------------------------------------------------------------------------

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTimes } = require('../host/proc-start');
const { killProven } = require('../host/kill-tree');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function alive(pid) { const m = await startTimes([pid]); return !!m && m.has(pid); }

// A stand-in "claude" (a Node sleeper) that, once the job is in place, starts a detached grandchild through an intermediate that
// exits at once: exactly what taskkill /T cannot reach. Sleepers only, ended by their own pid proven by start time.
test('real job: kill() ends a detached grandchild whose parent already exited; disarm() leaves it alone', { skip: process.platform !== 'win32' && 'Windows only', timeout: 90000 }, async () => {
  for (const mode of ['kill', 'disarm']) {
    const pidFile = path.join(os.tmpdir(), `cc-jobguard-${process.pid}-${mode}.pid`);
    const sleeper = `setTimeout(()=>{},600000)`;
    const inter = `const g=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{detached:true,stdio:'ignore'});g.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));process.exit(0)`;
    const standIn = `setTimeout(()=>{require('child_process').spawn(process.execPath,['-e',${JSON.stringify(inter)}],{stdio:'ignore'})},2500);setTimeout(()=>{},600000)`;
    const claude = spawn(process.execPath, ['-e', standIn], { stdio: 'ignore', windowsHide: true });
    const claudeStart = (await startTimes([claude.pid])).get(claude.pid);
    const g = createJobGuard();
    let gpid = null;
    let gStart = null;
    try {
      const r = await g.attach({ pid: claude.pid, startOf: async () => claudeStart, exited: () => claude.exitCode !== null });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.start, claudeStart, 'the helper opened the process we meant');
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100);
      gpid = Number(fs.readFileSync(pidFile, 'utf8'));
      gStart = (await startTimes([gpid])).get(gpid);
      assert.ok(gpid > 0 && typeof gStart === 'string', 'the grandchild is running');
      if (mode === 'kill') {
        assert.strictEqual(g.kill(), true);
        for (let i = 0; i < 50 && (await alive(gpid) || await alive(claude.pid)); i++) await sleep(100);
        assert.strictEqual(await alive(gpid), false, 'the detached grandchild died with the job');
        assert.strictEqual(await alive(claude.pid), false, 'and so did claude');
      } else {
        g.disarm();
        await sleep(1500);
        assert.strictEqual(await alive(gpid), true, 'a disarmed job leaves the grandchild alone');
        assert.strictEqual(await alive(claude.pid), true, 'and claude');
      }
    } finally {
      // Only the two pids this test started, each proven by the start time read when it was running.
      if (gpid && gStart && await alive(gpid)) killProven(gpid, gStart);
      if (claude.exitCode === null && await alive(claude.pid)) killProven(claude.pid, claudeStart);
      fs.rmSync(pidFile, { force: true });
    }
  }
});
