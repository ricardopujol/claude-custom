'use strict';
/* BACKLOG #74 A -- do Electron processes linger after their app has exited, and is it this app or Electron/Windows?

   Measured before this probe (2026-10-07/08, from the real app and scratch launches): after app.exit(0) the tree's
   processes stay listed as 1-thread/0-handle shells for 8-13 s on a quiet machine and 60-90 s+ on a busy one (one
   renderer 17+ min), their last threads in state Ready with Defender (MsMpEng) busy; a force kill of a live tree
   (taskkill /T /F) leaves nothing within a second.

   This probe runs the comparison that decides where the cause is: a TRIVIAL Electron with the app's own lifecycle
   shape and none of its code (one window, a few WebContentsViews loading data: pages, views closed with
   webContents.close() the way app/main.js's destroyTabView does, then the window, then app.exit(0)). If a trivial
   tree lingers the same way, the cause is Electron/Windows-side and there is no app fix to make.

   Each cycle: launch through verify/lib/launch-electron.js (clean env, ledger entry, kill by pid), wait for the
   tree to come up, read every process's type from its command line (unreadable after the close), close, then poll
   the process table every POLL_S seconds for up to WATCH_S, and record when each process left and how long it was
   seen zombie-shaped. Anything still listed at the end is killed by pid, only if its start time still matches.

   Usage:  node verify/probe-electron-zombies.js [--cycles 5] [--views 3] [--close exit|kill] [--watch 60] [--linger 5]
   --close exit  the app's own way out (views closed, window closed, app.exit(0)).  --close kill  taskkill /T /F.
   Heavy work: take ~/.claude/scripts/heavy-lock.ps1 first; one Electron at a time (cycles are sequential).
   PASS/FAIL is on "every cycle ran and was measured", never on the linger numbers: they are the finding. */

if (process.versions.electron && process.type === 'browser') {
  trivialMain();
} else if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err && err.stack || err); process.exit(1); });
}

// ---- the trivial Electron ---------------------------------------------------------------------------------------
function trivialMain() {
  const { app, BrowserWindow, WebContentsView } = require('electron');
  const VIEWS = Number(process.env.CC_ZOMBIE_VIEWS) || 3;
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 640, height: 480, show: true });
    await win.loadURL('data:text/html,<h1>window</h1>');
    const views = [];
    for (let i = 0; i < VIEWS; i++) {
      const v = new WebContentsView();
      win.contentView.addChildView(v);
      v.setBounds({ x: 10 + i * 20, y: 10 + i * 20, width: 300, height: 200 });
      await v.webContents.loadURL(`data:text/html,<h2>view ${i}</h2>`);
      views.push(v);
    }
    process.stdout.write('TREE-UP\n');
    process.stdin.on('data', () => {
      // destroyTabView's order: off the window, then the webContents closed.
      for (const v of views) { win.contentView.removeChildView(v); v.webContents.close(); }
      win.close();
      setTimeout(() => app.exit(0), 200);
    });
  });
}

// ---- the launcher -----------------------------------------------------------------------------------------------
function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

async function main() {
  if (process.platform !== 'win32') { console.log('SKIP: reads the Windows process table'); return 0; }
  const census = require('./lib/proc-census');
  const { launchElectron, stopElectron, sleep } = require('./lib/launch-electron');
  const { killPidTree } = require('../host/kill-tree');

  const CYCLES = Number(argOf('cycles', 5));
  const VIEWS = Number(argOf('views', 3));
  const CLOSE = argOf('close', 'exit');
  const WATCH_S = Number(argOf('watch', 60));
  const LINGER_S = Number(argOf('linger', 5));
  const POLL_S = 2;
  if (!['exit', 'kill'].includes(CLOSE)) { console.error('--close is exit or kill'); return 2; }

  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures++;
  };

  const results = [];
  for (let c = 1; c <= CYCLES; c++) {
    const h = await launchElectron({
      args: [__filename], extraEnv: { CC_ZOMBIE_VIEWS: String(VIEWS) }, label: `probe-electron-zombies#${c}`,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const up = await new Promise((resolve) => {
        let out = '';
        const t = setTimeout(() => resolve(false), 30000);
        h.child.stdout.on('data', (d) => { out += d; if (/TREE-UP/.test(out)) { clearTimeout(t); resolve(true); } });
        h.child.once('exit', () => { clearTimeout(t); resolve(false); });
      });
      if (!up) { check(`cycle ${c}: the tree came up`, false); continue; }
      await sleep(1000);   // let the GPU / utility children settle into the table

      const before = census.queryRows();
      const tracked = before ? census.descendantsOf(before, h.pid, h.start) : [];
      if (!tracked.length) { check(`cycle ${c}: the tree was read before the close`, false); continue; }

      const t0 = Date.now();
      if (CLOSE === 'exit') h.child.stdin.write('quit\n');
      else killPidTree(h.pid);
      const polls = [];
      while ((Date.now() - t0) / 1000 < WATCH_S) {
        await sleep(POLL_S * 1000);
        const rows = census.queryRows();
        if (!rows) continue;
        const t = Math.round((Date.now() - t0) / 1000);
        polls.push({ t, rows });
        if (!tracked.some(p => rows.some(r => r.pid === p.pid && r.start === p.start))) break;
      }
      const sum = census.summarize(tracked, polls);
      results.push(sum);
      const left = sum.filter(r => r.goneAfterS === null);
      check(`cycle ${c}: measured ${tracked.length} processes`, polls.length > 0,
        sum.map(r => `${r.type}:${r.goneAfterS === null ? `>${WATCH_S}` : r.goneAfterS}s`).join(' '));
      if (CLOSE === 'exit') {
        const root = sum.find(r => r.pid === h.pid);
        check(`cycle ${c}: the app exited when asked`, h.exited === true || (root && root.goneAfterS !== null));
      }
      // Still listed after the watch: ours by pid AND start time at the last poll, so kill each ONE by pid
      // (TerminateProcess, no /T: a tree walk from a pid we only watch could take recycled-pid orphans with it).
      const last = polls.length ? polls[polls.length - 1].rows : [];
      for (const r of left) {
        const p = tracked.find(x => x.pid === r.pid);
        if (p && last.some(x => x.pid === p.pid && x.start === p.start)) { try { process.kill(p.pid); } catch { /* gone */ } }
      }
    } finally {
      await stopElectron(h, { politeMs: 0, graceMs: 5000 });
    }
  }

  console.log(`\n== ${CYCLES} cycles, close=${CLOSE}, ${VIEWS} views, lingering = listed > ${LINGER_S}s after the close`);
  for (const [type, v] of Object.entries(census.byType(results, { lingerS: LINGER_S }))) {
    console.log(`   ${type.padEnd(16)} x${v.count}  lingered ${v.lingered} (still there at ${WATCH_S}s: ${v.stillThere})` +
      `  longest ${v.maxGoneAfterS === null ? '-' : `${v.maxGoneAfterS}s`}  zombie-shaped up to ${v.maxZombieSeenS}s`);
  }
  check('every cycle was measured', results.length === CYCLES, `${results.length}/${CYCLES}`);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
