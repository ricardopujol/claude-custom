'use strict';
/**
 * host/job-guard.js (BACKLOG #127) against a real Job Object: real PowerShell, real sleepers, seconds per case. Split from
 * job-guard.test.js (the pure tests) like the other *-process tests: kept out of Stryker's command (a timeout there counts as a
 * kill and a hung child is left behind). Run it by hand: node --test test/job-guard-process.test.js
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

// A stand-in "claude" (a Node sleeper) that, once the job is in place, starts a detached grandchild through an intermediate that
// exits at once: exactly what taskkill /T cannot reach. Sleepers only, ended by their own pid proven by start time.
// 'helper-killed' is what a tree kill of the HOST does (the watchdog's, *Stop that session*'s, the sweep's): taskkill /T reaches the
// helper, a child of the host. Before the job gave up kill-on-close that ended every process in the job; only a stop may.
test('real job: kill() ends a detached grandchild whose parent already exited; disarm() and a killed helper leave it alone', { skip: process.platform !== 'win32' && 'Windows only', timeout: 120000 }, async () => {
  for (const mode of ['kill', 'disarm', 'helper-killed']) {
    const pidFile = path.join(os.tmpdir(), `cc-jobguard-${process.pid}-${mode}.pid`);
    const sleeper = `setTimeout(()=>{},600000)`;
    // kill-test-ok: the grandchild reports its pid in pidFile, and the finally below ends it by that pid, proven by its start time
    const inter = `const g=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{detached:true,stdio:'ignore'});g.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));process.exit(0)`;
    // The stand-in starts the intermediate only once the test says the job is armed (goFile), never on a timer: on a loaded
    // machine the arm took longer than a fixed 2.5 s, the grandchild was born outside the job and survived (PR #235 hub H1).
    const goFile = path.join(os.tmpdir(), `cc-jobguard-${process.pid}-${mode}.go`);
    fs.rmSync(goFile, { force: true });
    const standIn = `const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(goFile)}))return;clearInterval(t);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(inter)}],{stdio:'ignore'})},50);setTimeout(()=>{},600000)`;
    const claude = spawn(process.execPath, ['-e', standIn], { stdio: 'ignore', windowsHide: true });
    const claudeStart = (await startTimes([claude.pid])).get(claude.pid);
    let helperChild = null;
    const g = createJobGuard({ spawnFn: (...a) => (helperChild = spawn(...a)) });
    let gpid = null;
    let gStart = null;
    try {
      const r = await g.attach({ pid: claude.pid, startOf: async () => claudeStart, exited: () => claude.exitCode !== null });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.start, claudeStart, 'the helper opened the process we meant');
      fs.writeFileSync(goFile, 'go');   // armed: now the stand-in may start the grandchild
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
        if (mode === 'disarm') g.disarm();
        else helperChild.kill();   // the helper this test's guard spawned, by its own handle
        for (let i = 0; i < 50 && helperChild.exitCode === null && helperChild.signalCode === null; i++) await sleep(100);
        await sleep(1500);
        assert.strictEqual(await alive(gpid), true, `${mode}: the grandchild is left alone`);
        assert.strictEqual(await alive(claude.pid), true, `${mode}: and claude`);
      }
    } finally {
      if (helperChild && helperChild.exitCode === null && helperChild.signalCode === null) g.disarm();
      // Only the two pids this test started, each proven by the start time read when it was running.
      if (gpid && gStart && await alive(gpid)) killProven(gpid, gStart);
      if (claude.exitCode === null && await alive(claude.pid)) killProven(claude.pid, claudeStart);
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(goFile, { force: true });
    }
  }
});
