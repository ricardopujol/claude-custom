'use strict';
/**
 * BACKLOG #127 (Dexter F2, PR #210): does the kill switch end a process whose parent already exited?
 *
 * A stand-in "claude" (a Node sleeper under a real node-pty pty, like the host's) starts an intermediate process, which starts a
 * DETACHED grandchild sleeper and exits at once. That grandchild has no live path back to claude, so `taskkill /T` from claude's
 * pid misses it. The probe trips the stop exactly as the host does (host/pty-stop.js with kill-tree's killChildTree, then, with the
 * guard, host/job-guard.js's kill) and reports whether the grandchild survived.
 *
 *   node verify/probe-kill-switch-detached.js            both runs: without the guard (the bug), with it (the fix); exit 1 if the fix leaves a survivor
 *   node verify/probe-kill-switch-detached.js --baseline only the run without the guard
 *
 * MEASURED 2026-11-03 (this machine, develop 25a9cbd + this lane):
 *   without the guard   claude ended, grandchild SURVIVED (taskkill /T cannot reach it)
 *   with the guard      the job is armed ~1 s after spawn (PowerShell start + Add-Type; the helper alone reports ~290 ms); claude and the
 *                       grandchild were both gone by the first check after the trip (checks are ~0.6 s apart: each is a PowerShell call)
 *   a polled descendant snapshot (the other approach), back to back at ~670 ms per sample: a parent that exited at once was never
 *   recorded, one that lived 1.5 s was. A snapshot can't reach this case, which is why the fix is a job object.
 *
 * Only sleepers are started, and only the pids this probe started are ended, each proven by its start time. No Electron, no real claude.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pty = require(path.join(ROOT, 'node_modules', 'node-pty'));
const { killChildTree, killProven, trackExit, trackedStart, childExited } = require('../host/kill-tree');
const { stopPty } = require('../host/pty-stop');
const { createJobGuard } = require('../host/job-guard');
const { startTimes } = require('../host/proc-start');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async (pid) => { const m = await startTimes([pid]); return !!m && m.has(pid); };

async function run({ withGuard }) {
  const pidFile = path.join(os.tmpdir(), `cc-probe-detached-${process.pid}-${withGuard ? 'guard' : 'bare'}.pid`);
  const sleeper = 'setTimeout(()=>{},600000)';
  const inter = `const g=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{detached:true,stdio:'ignore'});g.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));process.exit(0)`;
  // The intermediate starts 2.5 s in, after the guard has had time to put claude in its job (as claude's real children start later).
  const standIn = `setTimeout(()=>{require('child_process').spawn(process.execPath,['-e',${JSON.stringify(inter)}],{stdio:'ignore'})},2500);setTimeout(()=>{},600000)`;

  const term = pty.spawn(process.execPath, ['-e', standIn], { name: 'xterm', cols: 80, rows: 24 });
  trackExit(term);
  const claudeStart = await trackedStart(term);
  const result = { withGuard, attachMs: null, grandchildSurvived: null, claudeSurvived: null, endedAfterMs: null, error: null };
  let gpid = null;
  let gStart = null;
  try {
    const guard = withGuard ? createJobGuard({ log: () => {} }) : null;
    if (guard) {
      const t0 = Date.now();
      const r = await guard.attach({ pid: term.pid, startOf: () => trackedStart(term), exited: () => childExited(term) });
      if (!r.ok) throw new Error(`the guard did not arm: ${r.reason}`);
      result.attachMs = Date.now() - t0;
    }
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100);
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    gStart = (await startTimes([gpid])).get(gpid);
    if (typeof gStart !== 'string') throw new Error('the grandchild never ran');

    // The trip, as host.js's boundedStopPty runs it.
    const t1 = Date.now();
    stopPty(term, { killChildTree });
    if (guard) guard.kill();
    for (let i = 0; i < 40; i++) {
      result.grandchildSurvived = await alive(gpid);
      result.claudeSurvived = await alive(term.pid);
      if (!result.grandchildSurvived && !result.claudeSurvived) break;
      await sleep(100);
    }
    result.endedAfterMs = Date.now() - t1;
  } catch (err) {
    result.error = err.message;
  } finally {
    // Only what this probe started, proven by start time.
    if (gpid && gStart && await alive(gpid)) killProven(gpid, gStart);
    if (claudeStart && await alive(term.pid)) killProven(term.pid, claudeStart);
    fs.rmSync(pidFile, { force: true });
  }
  return result;
}

(async () => {
  const baselineOnly = process.argv.includes('--baseline');
  const bare = await run({ withGuard: false });
  console.log('without the guard:', JSON.stringify(bare));
  let failed = bare.error !== null;
  if (!baselineOnly) {
    const guarded = await run({ withGuard: true });
    console.log('with the guard   :', JSON.stringify(guarded));
    failed = failed || guarded.error !== null || guarded.grandchildSurvived !== false || guarded.claudeSurvived !== false;
    console.log(guarded.grandchildSurvived === false ? 'PASS: the detached grandchild died with the session' : 'FAIL: the detached grandchild survived');
  } else {
    console.log(bare.grandchildSurvived ? 'BUG REPRODUCED: the detached grandchild survived the stop' : 'the grandchild did not survive');
  }
  process.exit(failed ? 1 : 0);
})();
