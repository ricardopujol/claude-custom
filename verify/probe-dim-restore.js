'use strict';
/* Does the unfocused dim tell the truth after a minimize -> restore?

   Dexter, PR #47: app/main.js's `restore` handler sets `focused =
   win.isFocused()` -- and main.js's own header records (Naomi, PR #33, measured)
   that isFocused() returns TRUE while the window is minimized. If it also lies
   at `restore`, the page shows the wrong veil: a window you are typing into
   stays dark, or one you are not stays bright. Nothing measured it.

   How: this file is BOTH the launcher (run with node) and a driver loaded into
   the REAL app's Electron main process with NODE_OPTIONS=--require, so main.js
   runs unmodified. The driver waits for the app's window, then per trial:

     A  minimize -> restore                    (restore normally takes focus)
     B  minimize -> restore -> focus another   (must end DIMMED)
        window

   and after each settles reads three things: the page's actual veil state
   (body.unfocused), the state the last focus/blur EVENT implies, and
   BrowserWindow.getFocusedWindow(). PASS means the veil agreed with the events
   in every trial. win.restore() is programmatic; a real taskbar click is not
   reproduced here, so a PASS bounds the claim to programmatic restore.

   First run, 2026-09-26: PASS, 10/10. At `restore` isFocused() read FALSE in
   9 of 10 trials, so the handler briefly sends focused:false -- but a `focus`
   event follows within the same settle and corrects it. The veil can dip for
   a frame on restore; it does not stay wrong.

   Usage:  node verify/probe-dim-restore.js      (PORT=<n>, TRIALS=<n> optional)

   ELECTRON_RUN_AS_NODE is deleted from the child's env (CLAUDE.md trap). */

// NODE_OPTIONS reaches every Node in the chain -- including the plain-Node
// wrapper behind electron.cmd -- so the launcher runs only as the entry point.
if (process.versions.electron && process.type === 'browser') {
  // Preloaded before Electron's own init: `app` is undefined until it has run.
  setImmediate(driver);
} else if (require.main === module) {
  launcher();
}

function launcher() {
  const { spawn } = require('child_process');
  const { spawnElectron, noteChild } = require('./lib/launch-electron');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const REPO = path.join(__dirname, '..');
  const PORT = Number(process.env.PORT) || 7713;
  const OUT = path.join(os.tmpdir(), `cc-probe-dim-restore-${process.pid}.json`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-dim-'));
  const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: project };
  delete env.ELECTRON_RUN_AS_NODE;

  const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  noteChild(host);   // the lock's work record covers a host / claude this probe started by hand (BACKLOG #112)
  let hostLog = '';
  host.stdout.on('data', d => { hostLog += d.toString(); });
  host.stderr.on('data', d => { hostLog += d.toString(); });

  const cleanup = () => {
    try { host.kill(); } catch { /* already gone */ }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(OUT, { force: true }); } catch { /* best effort */ }
  };

  (async () => {
    await sleep(3500);
    if (!/listening/i.test(hostLog)) { console.error('host did not start:\n' + hostLog); cleanup(); process.exit(1); }

    const electron = spawnElectron(require('electron'), ['.'], {
      cwd: REPO,
      env: {
        ...env,
        // Forward slashes, unquoted: NODE_OPTIONS does its own splitting.
        NODE_OPTIONS: `--require ${__filename.replace(/\\/g, '/')}`,
        CC_PROBE_DIM_OUT: OUT,
        CC_PROBE_DIM_TRIALS: process.env.TRIALS || '5',
      },
      stdio: 'inherit',
    }, { keepEnv: ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT'] });

    electron.on('exit', () => {
      let result = null;
      try { result = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* no result */ }
      cleanup();
      if (!result) { console.error('FAIL: the driver wrote no result\nhost log:\n' + hostLog); process.exit(1); }
      if (result.error) { console.error('FAIL: driver error:', result.error); process.exit(1); }
      for (const t of result.trials) console.log(JSON.stringify(t));
      const bad = result.trials.filter(t => !t.agrees);
      if (bad.length) {
        console.log(`FAIL: the veil disagreed with the focus events in ${bad.length}/${result.trials.length} trials`);
        process.exit(1);
      }
      console.log(`PASS: the veil agreed with the focus events in all ${result.trials.length} trials (programmatic restore)`);
      process.exit(0);
    });
  })();
}

function driver() {
  const { app, BrowserWindow } = require('electron');
  const fs = require('fs');
  const OUT = process.env.CC_PROBE_DIM_OUT;
  const TRIALS = Number(process.env.CC_PROBE_DIM_TRIALS) || 5;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const finish = (result) => {
    try { fs.writeFileSync(OUT, JSON.stringify(result)); } catch { /* launcher reports no result */ }
    app.exit(0);
  };
  // A hung driver must not hang the probe.
  setTimeout(() => finish({ error: 'timed out' }), 120000).unref();

  let claimed = false;
  app.on('browser-window-created', (_e, win) => {
    if (claimed) return;          // the first window is the app's; later ones are ours
    claimed = true;

    // What the events imply, tracked the way main.js tracks them.
    let byEvents = win.isFocused();
    const events = [];
    win.on('focus', () => { byEvents = true; events.push('focus'); });
    win.on('blur', () => { byEvents = false; events.push('blur'); });
    win.on('minimize', () => { byEvents = false; events.push('minimize'); });
    win.on('restore', () => events.push(`restore(isFocused=${win.isFocused()})`));

    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(4000);        // the renderer registers its listener after load
        const veil = () => win.webContents.executeJavaScript(
          "document.body.classList.contains('unfocused')");
        const trials = [];
        for (let i = 0; i < TRIALS; i++) {
          for (const kind of ['A', 'B']) {
            events.length = 0;
            win.focus();
            await sleep(500);
            win.minimize();
            await sleep(800);
            win.restore();
            let other = null;
            if (kind === 'B') {
              await sleep(300);
              // Not wrapped in probeWindowOptions on purpose: the trial is about real focus moving to another visible window.
              other = new BrowserWindow({ width: 200, height: 120, show: true });
              other.focus();
            }
            await sleep(1200);
            const dimmed = await veil();
            const focusedWin = BrowserWindow.getFocusedWindow();
            trials.push({
              trial: i, kind,
              events: events.slice(),
              byEvents,
              dimmed,
              getFocusedWindowIsApp: focusedWin === win,
              agrees: dimmed === !byEvents,
            });
            if (other) { other.destroy(); await sleep(300); }
          }
        }
        finish({ trials });
      } catch (err) {
        finish({ error: String(err && err.stack || err) });
      }
    });
  });
}
