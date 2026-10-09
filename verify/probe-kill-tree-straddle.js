'use strict';
/**
 * PROBE (re-runnable): does host/kill-tree.js killPidTree leave a process behind that its tree started DURING the kill?
 * (BACKLOG #73; the shape of #72, which the status relay's own sweep already fixed.)
 *
 *   node verify/probe-kill-tree-straddle.js [trials] [interval ms] [cmd]       (default 12 trials, 25 ms; Windows only; exit 0 = measured)
 *   `cmd` puts the spawner UNDER cmd.exe (spawn with shell:true), the shape of the status relay's user command (#72).
 *
 * Each trial starts a root node process whose job is to start a new process every 25 ms, then kills the root with
 * killPidTree (the call under test) and counts, by a per-trial marker in argv, the processes still running. `taskkill /T`
 * reads the tree once and ends it: a process started after that read survives. Survivors are then ended by
 * verify/lib/reap-marked (marker + start-time proof; never by name). Prints `SURVIVORS: <n> over <trials> trials`.
 *
 * No Electron: a plain node tree, so no heavy lock is needed beyond the usual care about CPU.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { killPidTree } = require('../host/kill-tree');
const { markedPids, reapMarked, SLEEPER_SRC } = require('./lib/reap-marked');
const { runTrial } = require('./lib/straddle-trial');

if (process.platform !== 'win32') { console.log('SKIP: Windows only (taskkill /T)'); process.exit(0); }

const trials = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 12;
const INTERVAL = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 25;
const UNDER_CMD = process.argv[4] === 'cmd';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function trial(i, dir) {
  const marker = `cc73-${process.pid}-${Date.now()}x${i}`;        // the sleepers carry this
  const spawnerMarker = `cc73s-${process.pid}-${Date.now()}x${i}`; // the spawner carries this one, so a scan for sleepers cannot match it
  const ready = path.join(dir, `ready-${i}`);
  const src = `const { spawn } = require('child_process'); let n = 0; const t0 = Date.now();
setInterval(() => {
  spawn(process.execPath, ['-e', ${JSON.stringify(SLEEPER_SRC)}, ${JSON.stringify(marker)}], { stdio: 'ignore', windowsHide: true });
  if (++n === 3) require('fs').writeFileSync(${JSON.stringify(ready)}, 'ok');
  if (Date.now() - t0 > 600000) process.exit();   // far past any trial: a spawner nobody kills still ends, but never inside one
}, ${INTERVAL});`;
  const spawnerFile = path.join(dir, `spawner-${i}.js`);
  fs.writeFileSync(spawnerFile, src);
  const root = UNDER_CMD
    ? spawn(`"${process.execPath}" "${spawnerFile}" ${spawnerMarker}`, { shell: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.execPath, [spawnerFile, spawnerMarker], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise(r => root.once('exit', r));
  try {
    for (let w = 0; w < 600 && !fs.existsSync(ready); w++) await sleep(50);
    if (!fs.existsSync(ready)) return { inconclusive: 'the tree never started' };
    const r = await runTrial({
      root, exited, sleep,
      jitterMs: Math.floor(Math.random() * 40),            // vary where in the spawning cycle the kill lands
      scanSleepers: () => markedPids(marker),
      kill: (pid) => killPidTree(pid),   // kill-ok: the call under test, on a root this probe spawned; runTrial checks it has not exited in the same tick
    });
    return { ...r, marker, spawnerMarker };
  } finally {
    try { reapMarked(marker); reapMarked(spawnerMarker); } catch { /* the exit hook below tries again */ }
    if (root.exitCode === null && root.signalCode === null) root.kill();
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc73-'));
  const markers = [];
  process.on('exit', () => { for (const m of markers) { try { reapMarked(m); } catch { /* best effort */ } } });
  let survivors = 0; let straddled = 0; let measured = 0;
  for (let i = 0; i < trials; i++) {
    const r = await trial(i, dir);
    if (r.inconclusive) { console.log(`trial ${i}: inconclusive (${r.inconclusive})`); if (r.marker) markers.push(r.marker, r.spawnerMarker); continue; }
    markers.push(r.marker, r.spawnerMarker);
    measured++; survivors += r.left; if (r.left) straddled++;
    console.log(`trial ${i}: ${r.left} left running`);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`SURVIVORS: ${survivors} over ${measured} trials (${straddled} trials left at least one)`);
})();
