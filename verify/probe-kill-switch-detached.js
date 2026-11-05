'use strict';
/**
 * BACKLOG #127 (Dexter F2, PR #210): does the kill switch end a process whose parent already exited?
 *
 * A stand-in "claude" (a Node sleeper under a real node-pty pty, like the host's) starts, 2.5 s in, an intermediate that starts a
 * DETACHED grandchild sleeper and exits at once. That grandchild has no live path back to claude, so `taskkill /T` from claude's
 * pid misses it. Three intermediates, the ways a session really does this:
 *   node-detached       node: spawn(..., { detached: true }) + unref, then exit
 *   bash-nohup          Git Bash: nohup <sleeper> & disown, then exit
 *   ps-start-process    Windows PowerShell: Start-Process -WindowStyle Hidden <sleeper>, then exit
 * The probe trips the stop exactly as the host does (host/pty-stop.js with kill-tree's killChildTree, then, where this checkout
 * has host/job-guard.js, the guard's kill) and reports, per case, whether claude and the grandchild survived.
 *
 *   node verify/probe-kill-switch-detached.js            the stop of THIS checkout; exit 1 if anything survived it (or a case failed to run)
 *   node verify/probe-kill-switch-detached.js --bare     the stop without the guard even where there is one (the bug, reproduced)
 *
 * Runs against a checkout without host/job-guard.js too (the code before #127): node-pty is required by name, so a checkout with
 * no node_modules runs with NODE_PATH pointing at one that has it.
 *
 * MEASURED: see verify/README.md and the #127 commits. Only sleepers are started, and only the pids this probe started are ended,
 * each proven by its start time. No Electron, no real claude, no host.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const pty = require('node-pty');
const kt = require('../host/kill-tree');
const { stopPty } = require('../host/pty-stop');
const { startTimes } = require('../host/proc-start');

let createJobGuard = null;
try { ({ createJobGuard } = require('../host/job-guard')); } catch { /* a checkout from before #127 */ }

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async (pid) => { const m = await startTimes([pid]); return !!m && m.has(pid); };
const fwd = (p) => p.replace(/\\/g, '/');
// Before #127, kill-tree had no trackedStart: read the pty's start the same way trackExit does.
const startOf = async (term) => (typeof kt.trackedStart === 'function' ? kt.trackedStart(term) : ((await startTimes([term.pid])) || new Map()).get(term.pid) || null);

// The intermediate each case starts: a [file, args] pair run by the stand-in, which must leave a detached sleeper and exit.
function intermediate(kind, sleeperJs, pidFile) {
  if (kind === 'node-detached') {
    const inter = `const g=require('child_process').spawn(process.execPath,[${JSON.stringify(sleeperJs)},${JSON.stringify(pidFile)}],{detached:true,stdio:'ignore'});g.unref();process.exit(0)`;
    return [process.execPath, ['-e', inter]];
  }
  if (kind === 'bash-nohup') {
    return [BASH, ['-c', `nohup "${fwd(process.execPath)}" "${fwd(sleeperJs)}" "${fwd(pidFile)}" >/dev/null 2>&1 & disown; exit 0`]];
  }
  if (kind === 'ps-start-process') {
    return [POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '"${sleeperJs}"','"${pidFile}"'`]];
  }
  throw new Error(`unknown case ${kind}`);
}

async function run(kind, { useGuard }) {
  const tag = `${process.pid}-${kind}-${useGuard ? 'guard' : 'bare'}`;
  const pidFile = path.join(os.tmpdir(), `cc-probe-detached-${tag}.pid`);
  const sleeperJs = path.join(os.tmpdir(), `cc-probe-detached-${tag}-sleeper.js`);
  fs.writeFileSync(sleeperJs, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 600000);\n");
  const [file, args] = intermediate(kind, sleeperJs, pidFile);
  // The intermediate starts 2.5 s in, after the guard has had time to put claude in its job (as claude's real children start later).
  const standIn = `setTimeout(()=>{require('child_process').spawn(${JSON.stringify(file)},${JSON.stringify(args)},{stdio:'ignore',windowsHide:true})},2500);setTimeout(()=>{},600000)`;

  const term = pty.spawn(process.execPath, ['-e', standIn], { name: 'xterm', cols: 80, rows: 24 });
  kt.trackExit(term);
  const claudeStart = await startOf(term);
  const result = { kind, guard: useGuard, attachMs: null, claudeSurvived: null, grandchildSurvived: null, endedAfterMs: null, error: null };
  let gpid = null;
  let gStart = null;
  let guard = null;
  try {
    if (useGuard) {
      guard = createJobGuard({ log: () => {} });
      const t0 = Date.now();
      const r = await guard.attach({ pid: term.pid, startOf: () => startOf(term), exited: () => kt.childExited(term) });
      if (!r.ok) throw new Error(`the guard did not arm: ${r.reason}`);
      result.attachMs = Date.now() - t0;
    }
    for (let i = 0; i < 150 && !fs.existsSync(pidFile); i++) await sleep(100);
    if (!fs.existsSync(pidFile)) throw new Error('the grandchild never ran (its intermediate failed to start it)');
    await sleep(200);   // the intermediate has exited by now: the grandchild's parent is gone
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    gStart = ((await startTimes([gpid])) || new Map()).get(gpid);
    if (typeof gStart !== 'string') throw new Error('the grandchild is not running');

    // The trip, as host.js's boundedStopPty runs it.
    const t1 = Date.now();
    stopPty(term, { killChildTree: kt.killChildTree });
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
    if (guard) guard.disarm();
    // Only what this probe started, proven by start time.
    if (gpid && gStart && await alive(gpid)) kt.killProven(gpid, gStart);
    if (claudeStart && await alive(term.pid)) kt.killProven(term.pid, claudeStart);
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(sleeperJs, { force: true });
  }
  return result;
}

(async () => {
  if (process.platform !== 'win32') { console.log('Windows only'); process.exit(0); }
  const useGuard = !process.argv.includes('--bare') && typeof createJobGuard === 'function';
  console.log(`checkout: ${path.join(__dirname, '..')}`);
  console.log(`stop under test: ${useGuard ? 'tree kill + job guard' : (createJobGuard ? 'tree kill only (--bare)' : 'tree kill only (this checkout has no host/job-guard.js)')}`);
  let failed = false;
  for (const kind of ['node-detached', 'bash-nohup', 'ps-start-process']) {
    if (kind === 'bash-nohup' && !fs.existsSync(BASH)) { console.log(`${kind}: skipped, no ${BASH}`); continue; }
    const r = await run(kind, { useGuard });
    console.log(`${kind.padEnd(17)}: ${JSON.stringify(r)}`);
    if (r.error !== null || r.grandchildSurvived !== false || r.claudeSurvived !== false) failed = true;
  }
  console.log(failed ? 'FAIL: something the session started survived the stop (or a case could not run)' : 'PASS: claude and every detached grandchild ended with the stop');
  process.exit(failed ? 1 : 0);
})();
