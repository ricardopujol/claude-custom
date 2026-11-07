'use strict';
/**
 * PR #235 M1: does Electron still run from a session in the kill switch's job (host/job-guard.js)? The job sets no limits, so no
 * BREAKAWAY_OK: a process that insists on CREATE_BREAKAWAY_FROM_JOB gets access denied. Chromium starts sandboxed renderers, a GPU
 * process, utility processes and crashpad's handler; if any of them breaks away, an Electron probe run from a claude-custom tab
 * (Ricardo does this every day) would fail to start, or start crippled. This measures it instead of assuming it.
 *
 * A node stand-in for claude is spawned and put in a real job by createJobGuard, exactly as the host does (an exact start and the
 * spawn window). Only once it's armed does the stand-in (this same file, `--inner`) start anything, so everything it starts is in
 * the job from birth:
 *   quit    the lane's Electron with a trivial main: a window (sandboxed renderer) loads a page, the GPU and utility processes start,
 *           crashReporter starts crashpad; it reports app.getAppMetrics() and every child-process-gone, then quits. PASS: the page
 *           loaded, a sandboxed Tab and a GPU process ran, nothing failed to launch, Electron exited 0.
 *   hold    the same Electron, left running; then the job is ended (guard.kill(), as a stop does). PASS: every process in the
 *           stand-in's tree (Electron's renderer, GPU, utility, crashpad included) is gone. That's Ricardo's design answer (2):
 *           a test window the session launched closes with the stop.
 *   probe   one real Electron probe (REAL_PROBE below: the app window and a host, whose own job sits inside this one), run by the
 *           stand-in. PASS: it exits 0. Judge it against the same probe run outside any job: a probe that fails there says nothing.
 *
 *   node scripts/with-heavy-lock.js node verify/probe-kill-switch-electron.js [quit|hold|probe ...]   (all three by default)
 *
 * Takes the heavy lock (it starts Electron). ELECTRON_RUN_AS_NODE is stripped (launch-electron's probeEnv). Only what this probe
 * started is ended: the stand-in by its own handle, anything else by pid AND start time, through process-hygiene on Ctrl+C or an
 * uncaught error too. Exit 1 if any mode fails or can't be judged.
 */
const { spawnElectron, noteChild } = require('./lib/launch-electron');   // first: it takes the heavy lock (test/probe-lock-order.test.js)
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INNER = process.argv[2] === '--inner';
// The real probe: the lane's own app window and a real host (its claude is cmd.exe), so that host arms its OWN job guard inside this
// one, as a probe run from a claude-custom tab does. (probe-renderer-origin.js was the first pick; measured 2026-11-06 it fails
// outside any job too, "NO HANDSHAKE OBSERVED": its 4 s window is too short under load, so it can't tell the job's effect.)
const REAL_PROBE = 'probe-shortcuts-page.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The trivial main Electron runs (quit / hold). Its result goes to CC_M1_OUT.
const MAIN_JS = `
const { app, BrowserWindow, crashReporter } = require('electron');
const fs = require('fs');
const out = process.env.CC_M1_OUT;
const gone = [];
app.setPath('crashDumps', process.env.CC_M1_DUMPS);
crashReporter.start({ uploadToServer: false });
app.on('child-process-gone', (e, d) => gone.push({ type: d.type, reason: d.reason, exitCode: d.exitCode }));
app.on('render-process-gone', (e, wc, d) => gone.push({ type: 'renderer', reason: d.reason, exitCode: d.exitCode }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let loaded = false;
  try { await win.loadURL('data:text/html,<p>m1</p>'); loaded = true; } catch (err) { gone.push({ type: 'load', reason: String(err && err.message) }); }
  await new Promise((r) => setTimeout(r, 2000));   // the GPU and utility processes are up by now
  const metrics = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, sandboxed: m.sandboxed === true }));
  fs.writeFileSync(out, JSON.stringify({ loaded, metrics, gone, electronPid: process.pid }));
  if (process.env.CC_M1_MODE === 'quit') app.quit();
});
`;

// --- the stand-in, inside the job ------------------------------------------------------------------------------------------------
async function inner(mode, goFile, outFile, tmp) {
  for (let i = 0; i < 1200 && !fs.existsSync(goFile); i++) await sleep(50);   // nothing starts before the arm
  if (!fs.existsSync(goFile)) process.exit(3);
  if (mode === 'probe') {
    const child = spawn(process.execPath, [path.join(__dirname, REAL_PROBE)], { stdio: 'inherit' });
    noteChild(child);
    child.on('exit', (code) => { fs.writeFileSync(outFile, JSON.stringify({ probeExit: code })); process.exit(0); });
    return;
  }
  const mainJs = path.join(tmp, 'main.js');
  fs.writeFileSync(mainJs, MAIN_JS);
  const electron = require('electron');
  const child = spawnElectron(electron, [mainJs, `--user-data-dir=${path.join(tmp, 'ud')}`],
    { stdio: 'ignore', env: { ...process.env, CC_M1_OUT: outFile + '.electron', CC_M1_MODE: mode, CC_M1_DUMPS: path.join(tmp, 'dumps') } },
    { label: 'kill-switch M1', ledgerFile: null });
  child.on('exit', (code, signal) => {
    let report = null;
    try { report = JSON.parse(fs.readFileSync(outFile + '.electron', 'utf8')); } catch { /* none */ }
    fs.writeFileSync(outFile, JSON.stringify({ electronExit: code, electronSignal: signal, report }));
    process.exit(0);
  });
  setTimeout(() => {}, 600000);
}

// --- the outer probe -----------------------------------------------------------------------------------------------------------------
const run = (file, args, ms = 60000) => new Promise((resolve) => {
  // lock-ok: a process-table query the probe awaits, bounded by execFile's own timeout
  execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
});
// The tree under root, by parent links, a child accepted only if it wasn't created before its parent (the guard's own rule).
async function treeOf(rootPid) {
  const out = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { if ($_.CreationDate) { '' + $_.ProcessId + ' ' + $_.ParentProcessId + ' ' + $_.CreationDate.ToFileTimeUtc() + ' ' + $_.Name } }; 'END'"]);
  if (!out || !out.includes('END')) return null;
  // The name is optional in the parse: a row whose Name is empty is still a process (measured: without Name in -Property every row
  // ended in a bare space, and a parse that required a name dropped them all).
  const rows = out.split(/\r?\n/).map((l) => /^(\d+) (\d+) (\d+)(?: (.*))?$/.exec(l.trim())).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), ft: BigInt(m[3]), name: m[4] || '?' }));
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const root = byPid.get(rootPid);
  if (!root) return [];
  const found = [];
  const queue = [root];
  const seen = new Set([rootPid]);
  while (queue.length) {
    const cur = queue.shift();
    for (const r of rows) {
      if (r.ppid !== cur.pid || seen.has(r.pid) || r.ft + 20000n < cur.ft) continue;
      seen.add(r.pid);
      found.push(r);
      queue.push(r);
    }
  }
  return found;
}

async function outer(modes) {
  const { createJobGuard } = require('../host/job-guard');
  const { startTimes } = require('../host/proc-start');
  const { killProven } = require('../host/kill-tree');
  const { createHygieneRegistry } = require('./lib/process-hygiene');
  const hygiene = createHygieneRegistry();
  hygiene.install();
  const startOf = async (pid) => { for (let i = 0; i < 3; i++) { const m = await startTimes([pid]); const s = m && m.get(pid); if (typeof s === 'string') return s; } return null; };
  // true / false / null (the query failed: no answer, never "gone").
  const alive = async (pid) => { const m = await startTimes([pid]); return m ? m.has(pid) : null; };

  let failed = false;
  for (const mode of modes) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cc-m1-${mode}-`));
    const goFile = path.join(tmp, 'go');
    const outFile = path.join(tmp, 'out.json');
    const r = { mode, armed: null, proof: null, verdict: null, detail: null };
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const before = Date.now();
    const standIn = spawn(process.execPath, [__filename, '--inner', mode, goFile, outFile, tmp], { stdio: mode === 'probe' ? ['ignore', 'inherit', 'inherit'] : 'ignore', env, windowsHide: true });
    const spawnWindow = { before, after: Date.now() };
    noteChild(standIn);
    hygiene.registerChild(standIn);
    const ended = [];   // { pid, start } this mode's tree, for the cleanup
    const endTree = () => { for (const p of ended) { try { killProven(p.pid, p.start); } catch { /* gone */ } } };
    hygiene.addCleanup(endTree);
    const lines = [];
    const guard = createJobGuard({ log: (l) => lines.push(l) });
    try {
      const exact = await startOf(standIn.pid);
      const a = await guard.attach({ pid: standIn.pid, startOf: async () => exact, spawnWindow });
      r.armed = a.ok;
      r.proof = typeof exact === 'string' ? 'exact start' : 'spawn window';
      if (!a.ok) throw new Error(`the guard did not arm: ${a.reason}; ${lines.join(' | ')}`);
      fs.writeFileSync(goFile, 'go');

      if (mode === 'hold') {
        const eFile = outFile + '.electron';
        for (let i = 0; i < 1800 && !fs.existsSync(eFile); i++) await sleep(100);
        if (!fs.existsSync(eFile)) throw new Error('Electron never reported (did it start?)');
        const rep = JSON.parse(fs.readFileSync(eFile, 'utf8'));
        const tree = await treeOf(standIn.pid);
        if (!tree) throw new Error('the process table could not be read');
        for (const p of tree) { const s = await startOf(p.pid); if (typeof s === 'string') ended.push({ pid: p.pid, start: s }); }
        const names = tree.map((p) => p.name).sort();
        r.detail = { metrics: rep.metrics, gone: rep.gone, tree: names };
        if (guard.kill() !== 'sent') throw new Error('the stop was not sent');
        r.job = await guard.settled(15000);
        let left = null;
        for (let i = 0; i < 50; i++) {
          const states = await Promise.all(ended.map((p) => alive(p.pid)));
          if (states.some((s) => s === null)) { await sleep(200); continue; }
          left = ended.filter((p, k) => states[k]).map((p) => p.pid);
          if (left.length === 0) break;
          await sleep(200);
        }
        if (left === null) throw new Error('the process table could not be read after the stop');
        r.detail.leftAfterStop = left;
        r.verdict = r.job === 'killed' && left.length === 0 && tree.length >= 4 ? 'PASS' : 'FAIL';
      } else {
        for (let i = 0; i < 1800 && !fs.existsSync(outFile); i++) await sleep(100);
        if (!fs.existsSync(outFile)) throw new Error('the stand-in never reported');
        const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        r.detail = res;
        if (mode === 'probe') r.verdict = res.probeExit === 0 ? 'PASS' : 'FAIL';
        else {
          const rep = res.report;
          const ok = !!rep && rep.loaded === true && rep.gone.length === 0 && res.electronExit === 0
            && rep.metrics.some((m) => m.type === 'Tab' && m.sandboxed) && rep.metrics.some((m) => m.type === 'GPU');
          r.verdict = ok ? 'PASS' : 'FAIL';
        }
      }
    } catch (err) {
      r.verdict = 'FAIL';
      r.error = err.message;
    } finally {
      guard.disarm();
      endTree();
      hygiene.removeCleanup(endTree);
      if (standIn.exitCode === null && standIn.signalCode === null) { try { standIn.kill(); } catch { /* gone */ } }   // its own handle
      await sleep(500);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file Electron still holds: it's under the temp folder */ }
    }
    r.armLine = lines.find((l) => /armed for pid/.test(l)) || null;
    console.log(`${mode.padEnd(6)}: ${JSON.stringify(r)}`);
    if (r.verdict !== 'PASS') failed = true;
  }
  console.log(failed ? 'FAIL: Electron does not run (or end) as it should from a guarded session' : 'PASS: Electron runs from a guarded session, and a stop ends its whole tree');
  process.exit(failed ? 1 : 0);
}

if (process.platform !== 'win32') { console.log('Windows only'); process.exit(0); }
if (INNER) inner(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
else {
  const modes = process.argv.slice(2).filter((m) => ['quit', 'hold', 'probe'].includes(m));
  outer(modes.length ? modes : ['quit', 'hold', 'probe']);
}
