'use strict';
/**
 * host/job-guard.js (BACKLOG #127) against a real Job Object: real PowerShell, real sleepers, seconds per case. Split from
 * job-guard.test.js (the pure tests) like the other *-process tests: kept out of Stryker's command (a timeout there counts as a
 * kill and a hung child is left behind). Run it by hand: node --test test/job-guard-process.test.js
 *
 * Every sleeper writes its OWN pid to a file and is ended in a finally by that pid, proven by its start time. No timers decide
 * when a process starts: the stand-ins wait for go-files the test writes (PR #235 hub H1: a fixed timer raced the arm under load).
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJobGuard } = require('../host/job-guard');
const { startTimes } = require('../host/proc-start');
const { killProven } = require('../host/kill-tree');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function alive(pid) { const m = await startTimes([pid]); return !!m && m.has(pid); }
async function waitFile(f, ms = 15000) { for (let t = 0; t < ms && !fs.existsSync(f); t += 100) await sleep(100); return fs.existsSync(f); }
const readPid = (f) => Number(fs.readFileSync(f, 'utf8'));
const sleeperSrc = (pidFile) => `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},600000)`;
// An intermediate that leaves a detached sleeper behind and exits at once: the shape taskkill /T can't reach.
// kill-test-ok: the sleeper writes its own pid to pidFile, and each test's finally ends it by that pid, proven by its start time
const orphanerSrc = (pidFile) => `const g=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeperSrc(pidFile))}],{detached:true,stdio:'ignore'});g.unref();process.exit(0)`;
// Run `src` once `goFile` exists.
const onGo = (goFile, src) => `const t=setInterval(()=>{if(!require('fs').existsSync(${JSON.stringify(goFile)}))return;clearInterval(t);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(src)}],{stdio:'ignore'})},50)`;

// Ends what a case started: every pid it recorded, each through the proof of the start read while it ran.
async function cleanup(procs, files) {
  for (const { pid, start } of procs) if (pid && typeof start === 'string' && await alive(pid)) killProven(pid, start);
  for (const f of files) fs.rmSync(f, { force: true });
}
// The start read is a PowerShell query that can fail under load (it did: a null table); it is asked again before giving up.
async function record(procs, pid) {
  let start = null;
  for (let i = 0; i < 3 && typeof start !== 'string'; i++) { const m = await startTimes([pid]); start = m ? m.get(pid) : null; }
  procs.push({ pid, start });
  assert.strictEqual(typeof start, 'string', `the start of pid ${pid} could be read`);
  return start;
}
// The stand-in is this test's own ChildProcess: its handle holds the pid until it exits, so ending it by the handle can't reach a stranger.
const endOwn = (child) => { if (child && child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { /* gone */ } } };

// 'helper-killed' is what a tree kill of the HOST does (the watchdog's, *Stop that session*'s, the sweep's): taskkill /T reaches the
// helper, a child of the host. With kill-on-close that ended every process in the job; only a stop may.
test('real job: kill() ends a detached grandchild whose parent already exited; disarm() and a killed helper leave it alone', { skip: process.platform !== 'win32' && 'Windows only', timeout: 180000 }, async () => {
  for (const mode of ['kill', 'disarm', 'helper-killed']) {
    const tag = `${process.pid}-${mode}`;
    const pidFile = path.join(os.tmpdir(), `cc-jobguard-${tag}.pid`);
    const goFile = path.join(os.tmpdir(), `cc-jobguard-${tag}.go`);
    for (const f of [pidFile, goFile]) fs.rmSync(f, { force: true });
    const standIn = `${onGo(goFile, orphanerSrc(pidFile))};setTimeout(()=>{},600000)`;
    const claude = spawn(process.execPath, ['-e', standIn], { stdio: 'ignore', windowsHide: true });
    const procs = [];
    let helperChild = null;
    const g = createJobGuard({ spawnFn: (...a) => (helperChild = spawn(...a)) });
    try {
      const claudeStart = await record(procs, claude.pid);
      const r = await g.attach({ pid: claude.pid, startOf: async () => claudeStart });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.start, claudeStart, 'the helper opened the process we meant');
      fs.writeFileSync(goFile, 'go');   // armed: now the stand-in may start the grandchild
      assert.ok(await waitFile(pidFile), 'the grandchild ran');
      const gpid = readPid(pidFile);
      await record(procs, gpid);
      if (mode === 'kill') {
        assert.strictEqual(g.kill(), 'sent');
        assert.strictEqual(await g.settled(15000), 'killed');
        for (let i = 0; i < 50 && (await alive(gpid) || await alive(claude.pid)); i++) await sleep(100);
        assert.strictEqual(await alive(gpid), false, 'the detached grandchild died with the job');
        assert.strictEqual(await alive(claude.pid), false, 'and so did claude');
      } else {
        if (mode === 'disarm') g.disarm();
        else helperChild.kill();   // the helper this test's guard spawned, by its own handle
        for (let i = 0; i < 50 && helperChild.exitCode === null && helperChild.signalCode === null; i++) await sleep(100);
        await sleep(1500);
        assert.strictEqual(await alive(gpid), true, `${mode}: the grandchild is left alone`);
        assert.strictEqual(await alive(claude.pid), true, `${mode}: and claude`);
      }
    } finally {
      if (helperChild && helperChild.exitCode === null && helperChild.signalCode === null) g.disarm();
      await cleanup(procs, [pidFile, goFile]);
      endOwn(claude);
    }
  }
});

// The spawn window, against the real helper: no exact start (proc-start failed under load), only the clock around the spawn. libuv's
// spawn calls CreateProcess synchronously, like ConPTY's connect, so the creation lies inside. A window that ended before the process
// was created (a stranger that took the pid later) is refused by the helper before anything is assigned.
test('real job: with no exact start, the spawn window arms it and kill() ends it; a window that excludes it is refused', { skip: process.platform !== 'win32' && 'Windows only', timeout: 120000 }, async () => {
  for (const mode of ['inside', 'outside']) {
    const before = Date.now();
    const claude = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore', windowsHide: true });
    const after = Date.now();
    const procs = [];
    const lines = [];
    const g = createJobGuard({ log: (l) => lines.push(l) });
    try {
      await record(procs, claude.pid);   // for the cleanup only: the guard is never given it
      const spawnWindow = mode === 'inside' ? { before, after } : { before: before - 60000, after: before - 10000 };
      const r = await g.attach({ pid: claude.pid, startOf: async () => null, spawnWindow });
      if (mode === 'inside') {
        assert.strictEqual(r.ok, true, `${JSON.stringify(r)} ${lines.join(' | ')}`);
        assert.ok(lines.some((l) => /proven by the spawn window/.test(l)), lines.join(' | '));
        assert.strictEqual(g.kill(), 'sent');
        assert.strictEqual(await g.settled(15000), 'killed');
        for (let i = 0; i < 50 && await alive(claude.pid); i++) await sleep(100);
        assert.strictEqual(await alive(claude.pid), false, 'ended by the job');
      } else {
        assert.deepStrictEqual(r, { ok: false, reason: 'start-mismatch' }, lines.join(' | '));
        assert.strictEqual(g.kill(), 'not-armed');
        await sleep(500);
        assert.strictEqual(await alive(claude.pid), true, 'never in a job, never ended');
      }
    } finally {
      g.disarm();
      await cleanup(procs, []);
      endOwn(claude);
    }
  }
});

// PR #235 Dexter 10: what the arm adopts, and the limit, both pinned so neither is rediscovered as a flake.
//   early     a child started BEFORE the arm that stays alive (an MCP server, a hook): adopted at the arm, and a detached
//             grandchild it starts LATER (through an intermediate that exits) dies with the job.
//   orphan    a grandchild started AND orphaned before the arm (its intermediate already exited): nothing links it to the pty at
//             the arm, so it is not adopted and SURVIVES kill(). Asserted on purpose: it is the documented limit.
test('real job: a child alive at the arm is adopted and its later detached grandchild dies; one orphaned before the arm survives (the limit)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 180000 }, async () => {
  const tag = `${process.pid}-adopt`;
  const f = (n) => path.join(os.tmpdir(), `cc-jobguard-${tag}-${n}`);
  const earlyPid = f('early.pid');
  const lateGrandPid = f('late.pid');
  const orphanPid = f('orphan.pid');
  const go2 = f('go2');
  const files = [earlyPid, lateGrandPid, orphanPid, go2];
  for (const x of files) fs.rmSync(x, { force: true });
  // The early child is started detached so only OUR job can catch what it starts (libuv would otherwise put it in the stand-in's own job).
  const earlySrc = `require('fs').writeFileSync(${JSON.stringify(earlyPid)},String(process.pid));${onGo(go2, orphanerSrc(lateGrandPid))};setTimeout(()=>{},600000)`;
  // kill-test-ok: the early child writes its own pid to earlyPid, and the finally ends it by that pid, proven by its start time
  const standIn = `const cp=require('child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(earlySrc)}],{detached:true,stdio:'ignore'}).unref();cp.spawn(process.execPath,['-e',${JSON.stringify(orphanerSrc(orphanPid))}],{stdio:'ignore'});setTimeout(()=>{},600000)`;
  const claude = spawn(process.execPath, ['-e', standIn], { stdio: 'ignore', windowsHide: true });
  const procs = [];
  const lines = [];
  const g = createJobGuard({ log: (l) => lines.push(l) });
  try {
    const claudeStart = await record(procs, claude.pid);
    assert.ok(await waitFile(earlyPid) && await waitFile(orphanPid), 'both were started before the arm');
    const early = readPid(earlyPid);
    const orphan = readPid(orphanPid);
    await record(procs, early);
    await record(procs, orphan);
    await sleep(500);   // the orphan's intermediate has exited by now
    const r = await g.attach({ pid: claude.pid, startOf: async () => claudeStart });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    for (let i = 0; i < 200 && !lines.some((l) => /descendant\(s\) of pid/.test(l)); i++) await sleep(100);
    const adopted = lines.find((l) => /descendant\(s\) of pid/.test(l));
    assert.ok(adopted && /^\[job-guard\] [1-9]\d* descendant/.test(adopted), `the early child was adopted: ${lines.join(' | ')}`);
    fs.writeFileSync(go2, 'go');
    assert.ok(await waitFile(lateGrandPid), 'the early child started its grandchild after the arm');
    const late = readPid(lateGrandPid);
    await record(procs, late);
    assert.strictEqual(g.kill(), 'sent');
    assert.strictEqual(await g.settled(15000), 'killed');
    for (let i = 0; i < 50 && (await alive(early) || await alive(late) || await alive(claude.pid)); i++) await sleep(100);
    assert.strictEqual(await alive(claude.pid), false, 'claude ended');
    assert.strictEqual(await alive(early), false, 'the child alive at the arm was adopted and ended');
    assert.strictEqual(await alive(late), false, 'the grandchild it detached after the arm ended with the job');
    assert.strictEqual(await alive(orphan), true, 'THE LIMIT: a grandchild orphaned before the arm is not reached');
  } finally {
    g.disarm();
    await cleanup(procs, files);
    endOwn(claude);
  }
});
