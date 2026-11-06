'use strict';
/**
 * BACKLOG #127 (Dexter F2, PR #210): does the kill switch end a process whose parent already exited?
 *
 * A stand-in "claude" (a Node sleeper under a real node-pty pty, like the host's) starts an intermediate that starts a DETACHED
 * grandchild sleeper and exits at once. That grandchild has no live path back to claude, so `taskkill /T` from claude's pid misses
 * it. The intermediates, the ways a session really does this:
 *   node-detached       node: spawn(..., { detached: true }) + unref, then exit
 *   bash-nohup          Git Bash: nohup <sleeper> & disown, then exit
 *   ps-start-process    Windows PowerShell: Start-Process -WindowStyle Hidden <sleeper>, then exit
 *   launcher            the node-detached intermediate, but the pty runs Git's bin\bash.exe launcher, which starts usr\bin\bash,
 *                       which runs the stand-in (CLAUDE_CUSTOM_SHELL=Git\bin\bash.exe): the stand-in is NOT the pty's own process,
 *                       it is alive at the arm and must be adopted for its later children to be in the job (PR #235 Dexter 7)
 * The intermediate starts only once the probe says so (a go-file written after the guard armed, or at once with no guard), never on
 * a timer (PR #235 hub H1). The probe trips the stop as the host does (host/pty-stop.js with kill-tree's killChildTree, then, where
 * this checkout has host/job-guard.js, the guard's kill and its answer) and reports, per case, whether claude and the grandchild survived.
 *
 *   node verify/probe-kill-switch-detached.js            the stop of THIS checkout; exit 1 if anything survived it (or a case failed to run)
 *   node verify/probe-kill-switch-detached.js --bare     the stop without the guard even where there is one (the bug, reproduced)
 *   node verify/probe-kill-switch-detached.js --window-only   the guard proves each pty by its spawn window alone (no exact start)
 *
 * Runs against a checkout without host/job-guard.js too (the code before #127): node-pty is required by name, so a checkout with
 * no node_modules runs with NODE_PATH pointing at one that has it.
 *
 * MEASURED: see verify/README.md. Only sleepers are started, and only the pids this probe started are ended, each proven by its start
 * time; the pty and every grandchild are registered with verify/lib/process-hygiene.js, so Ctrl+C or an uncaught error ends them too
 * (PR #235 Miguel I7). No Electron, no real claude, no host.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const pty = require('node-pty');
const kt = require('../host/kill-tree');
const { stopPty } = require('../host/pty-stop');
const { startTimes } = require('../host/proc-start');
const { createHygieneRegistry } = require('./lib/process-hygiene');

let createJobGuard = null;
try { ({ createJobGuard } = require('../host/job-guard')); } catch { /* a checkout from before #127 */ }

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let WINDOW_ONLY = false;   // --window-only: the guard gets no exact start, as when proc-start times out under load
const hygiene = createHygieneRegistry();
hygiene.install();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// true running, false not running, null the query failed (it does under load): never read as "ended" (the absence-as-zero trap).
const alive = async (pid) => { const m = await startTimes([pid]); return m ? m.has(pid) : null; };
const fwd = (p) => p.replace(/\\/g, '/');
async function startOfPid(pid) {
  for (let i = 0; i < 3; i++) { const m = await startTimes([pid]); const s = m && m.get(pid); if (typeof s === 'string') return s; }
  return null;
}
// Before #127, kill-tree had no trackedStart: read the pty's start the same way trackExit does.
const startOf = async (term) => (typeof kt.trackedStart === 'function' ? (await kt.trackedStart(term)) || startOfPid(term.pid) : startOfPid(term.pid));

// The intermediate each case starts: a [file, args] pair run by the stand-in, which must leave a detached sleeper and exit.
function intermediate(kind, sleeperJs, pidFile) {
  if (kind === 'node-detached' || kind === 'launcher') {
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
  const tmp = (ext) => path.join(os.tmpdir(), `cc-probe-detached-${tag}${ext}`);
  const pidFile = tmp('.pid');
  const goFile = tmp('.go');
  const sleeperJs = tmp('-sleeper.js');
  const standInJs = tmp('-standin.js');
  const upFile = tmp('.up');
  const files = [pidFile, goFile, sleeperJs, standInJs, upFile];
  for (const f of files) fs.rmSync(f, { force: true });
  fs.writeFileSync(sleeperJs, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 600000);\n");
  const [file, args] = intermediate(kind, sleeperJs, pidFile);
  // The stand-in says it's running (upFile), then waits for the go.
  fs.writeFileSync(standInJs, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(upFile)},String(process.pid));const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(goFile)}))return;clearInterval(t);require('child_process').spawn(${JSON.stringify(file)},${JSON.stringify(args)},{stdio:'ignore',windowsHide:true})},50);setTimeout(()=>{},600000);\n`);

  // The launcher's paths go through the environment, and the -c argument must not START with a quote: node-pty's command line mangles
  // one that does (measured: bash saw `\C:/Program Files/...` and exited 2, then "unexpected EOF while looking for matching `"'").
  // The bundled ConPTY and the clock around the spawn, as host.js has them (the guard's spawn window).
  const before = Date.now();
  const term = kind === 'launcher'
    ? pty.spawn(BASH, ['-c', 'true; "$CC_PROBE_NODE" "$CC_PROBE_STANDIN"'], { name: 'xterm', cols: 80, rows: 24, useConptyDll: true, env: { ...process.env, CC_PROBE_NODE: process.execPath, CC_PROBE_STANDIN: standInJs } })
    : pty.spawn(process.execPath, [standInJs], { name: 'xterm', cols: 80, rows: 24, useConptyDll: true });
  const spawnWindow = { before, after: Date.now() };
  hygiene.registerChild(term);   // tracks its exit (kill-tree's trackExit) and ends it on Ctrl+C or an uncaught error
  let ptyOut = '';   // what the pty printed: a stand-in that failed to start says why here
  term.onData((d) => { ptyOut = (ptyOut + d).slice(-400); });
  const said = () => ptyOut.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ').trim();
  const claudeStart = await startOf(term);
  const result = { kind, guard: useGuard, attachMs: null, job: null, claudeSurvived: null, grandchildSurvived: null, endedAfterMs: null, error: null };
  let gpid = null;
  let gStart = null;
  let guard = null;
  let endGrandchild = null;
  try {
    // The launcher case is about adoption (PR #235 Dexter 7): its stand-in, a grandchild of the pty, must be ALIVE at the arm, so the
    // guard attaches only once it runs. Measured 2026-11-06: attached at once, Git's launcher had not started it yet, so it joined the
    // job by inheritance and the case passed with 0 adopted, proving nothing about adoption.
    if (kind === 'launcher') {
      for (let i = 0; i < 150 && !fs.existsSync(upFile); i++) await sleep(100);
      if (!fs.existsSync(upFile)) throw new Error('the launcher never started the stand-in');
    }
    if (useGuard) {
      const lines = [];
      guard = createJobGuard({ log: (l) => lines.push(l) });
      const t0 = Date.now();
      const exact = WINDOW_ONLY ? null : claudeStart;
      const r = await guard.attach({ pid: term.pid, startOf: async () => exact, spawnWindow });
      result.proof = typeof exact === 'string' ? 'exact start' : 'spawn window';
      if (!r.ok) throw new Error(`the guard did not arm: ${r.reason}; ${lines.join(' | ')}`);
      result.attachMs = Date.now() - t0;
      // The launcher's stand-in is a grandchild of the pty: wait for the walk that adopts it before the go.
      if (kind === 'launcher') for (let i = 0; i < 150 && !lines.some((l) => /descendant\(s\)/.test(l)); i++) await sleep(100);
      result.adopted = (lines.find((l) => /descendant\(s\)/.test(l)) || '').replace(/^\[job-guard\] /, '') || null;
      if (kind === 'launcher' && !/^[1-9]\d* descendant/.test(result.adopted || '')) throw new Error(`the stand-in alive at the arm was not adopted: ${result.adopted}`);
    }
    fs.writeFileSync(goFile, 'go');
    for (let i = 0; i < 150 && !fs.existsSync(pidFile); i++) await sleep(100);
    if (!fs.existsSync(pidFile)) throw new Error('the grandchild never ran (its intermediate failed to start it)');
    await sleep(200);   // the intermediate has exited by now: the grandchild's parent is gone
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    gStart = await startOfPid(gpid);
    if (typeof gStart !== 'string') throw new Error('the grandchild is not running');
    endGrandchild = () => kt.killProven(gpid, gStart);
    hygiene.addCleanup(endGrandchild);

    // The trip, as the host runs it: the bounded tree kill, then the stopper's endJob, whose answer the host waits for.
    const t1 = Date.now();
    stopPty(term, { killChildTree: kt.killChildTree });
    if (guard) { guard.kill(); result.job = await guard.settled(15000); }
    // Only a real answer counts: a query that failed (null) says nothing, and is asked again.
    for (let i = 0; i < 40; i++) {
      const g = await alive(gpid);
      const c = await alive(term.pid);
      if (g !== null) result.grandchildSurvived = g;
      if (c !== null) result.claudeSurvived = c;
      if (g === false && c === false) break;
      await sleep(100);
    }
    result.endedAfterMs = Date.now() - t1;
    if (result.grandchildSurvived === null || result.claudeSurvived === null) throw new Error('the process table could not be read, so whether they ended is unknown');
  } catch (err) {
    result.error = `${err.message}${said() ? `; the pty printed: ${said()}` : ''}`;
  } finally {
    if (guard) guard.disarm();
    // Only what this probe started, proven by start time; unless the table says it's gone, it's ended (a failed query is no answer:
    // measured 2026-11-06, a --bare grandchild read as ended was still running).
    if (gpid && gStart && await alive(gpid) !== false) kt.killProven(gpid, gStart);
    if (endGrandchild) hygiene.removeCleanup(endGrandchild);
    if (claudeStart && await alive(term.pid) !== false) kt.killProven(term.pid, claudeStart);
    for (const f of files) fs.rmSync(f, { force: true });
  }
  return result;
}

(async () => {
  if (process.platform !== 'win32') { console.log('Windows only'); process.exit(0); }
  const useGuard = !process.argv.includes('--bare') && typeof createJobGuard === 'function';
  WINDOW_ONLY = process.argv.includes('--window-only');
  console.log(`checkout: ${path.join(__dirname, '..')}`);
  console.log(`stop under test: ${useGuard ? 'tree kill + job guard' : (createJobGuard ? 'tree kill only (--bare)' : 'tree kill only (this checkout has no host/job-guard.js)')}`);
  let failed = false;
  for (const kind of ['node-detached', 'bash-nohup', 'ps-start-process', 'launcher']) {
    if ((kind === 'bash-nohup' || kind === 'launcher') && !fs.existsSync(BASH)) { console.log(`${kind}: skipped, no ${BASH}`); continue; }
    const r = await run(kind, { useGuard });
    console.log(`${kind.padEnd(17)}: ${JSON.stringify(r)}`);
    if (r.error !== null || r.grandchildSurvived !== false || r.claudeSurvived !== false) failed = true;
  }
  console.log(failed ? 'FAIL: something the session started survived the stop (or a case could not run)' : 'PASS: claude and every detached grandchild ended with the stop');
  process.exit(failed ? 1 : 0);
})();
