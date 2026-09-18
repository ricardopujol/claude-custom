'use strict';
/* Draw the quota meters in the REAL header and photograph them.
 *
 *     node verify/probe-quota-header.js [outDir]
 *
 * WHY THIS EXISTS. The meters are the first thing in this app whose numbers
 * come off the network, and their display rules -- absence draws no bars, an
 * unknown percent draws an em dash, a locked window is critical whatever the
 * percentage says -- are exactly the rules that read as correct in a unit test
 * and still look wrong on screen. So this renders app/renderer.html itself:
 * same CSS, same markup path, same escapeHtml, driven through every state.
 *
 * It never connects to a host and never spawns `claude`. The renderer's own
 * WebSocket fails to connect and retries in the background; nothing here
 * depends on it.
 *
 * TWO TRAPS, both paid for:
 *   ELECTRON_RUN_AS_NODE  Claude Code is itself Electron, so a probe launched
 *                         from a session inherits it and the child starts as
 *                         plain Node. See verify/probe-renderer-origin.js.
 *   offscreen: true       hung capturePage indefinitely here. A normal visible
 *                         window captures reliably; the window is small and
 *                         closes itself.
 */

const { spawn } = require('child_process');
const path = require('path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', '.harness', 'quota-shots');

const CASES = [
  ['live', null],
  ['reading', null],
  ['absent', { ok: false, state: 'absent', windows: [], error: 'usage endpoint returned 401' }],
  ['mixed', { ok: true, state: 'fresh', windows: [
    { key: 'session', label: '5h', percent: 84, severity: 'normal',
      resetsAt: new Date(Date.now() + 42 * 60000).toISOString(), isActive: true, lockedReason: null },
    { key: 'weekly_all', label: 'week', percent: 97, severity: 'normal',
      resetsAt: new Date(Date.now() + 3 * 86400000).toISOString(), isActive: false, lockedReason: null },
    { key: 'weekly_scoped', label: 'Fable', percent: null, severity: 'normal',
      resetsAt: null, isActive: false, lockedReason: null },
  ] }],
  ['locked', { ok: true, state: 'fresh', windows: [
    { key: 'session', label: '5h', percent: 100, severity: 'critical',
      resetsAt: new Date(Date.now() + 11 * 60000).toISOString(), isActive: true,
      lockedReason: 'limit_reached' },
  ] }],
];

// A probe that can hang is a probe nobody runs twice.
const bail = setTimeout(() => { console.error('TIMED OUT'); process.exit(2); }, 90000);

app.on('ready', async () => {
  try {
    const { readQuota } = require('../host/quota');
    CASES[0][1] = await readQuota({});
    console.log('live read:', CASES[0][1].state,
      CASES[0][1].windows.map(w => `${w.label} ${w.percent}%`).join(', '));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = new BrowserWindow({
      width: 1400, height: 120, show: true, frame: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(path.join(__dirname, '..', 'app', 'renderer.html'));
    await new Promise(r => setTimeout(r, 1200));

    for (const [name, payload] of CASES) {
      await win.webContents.executeJavaScript(
        `renderQuota(${JSON.stringify(payload)}); document.getElementById('cwd').textContent = ${JSON.stringify(name)}; true;`
      );
      await new Promise(r => setTimeout(r, 350));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1400, height: 32 });
      const file = path.join(OUT_DIR, `quota-${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      // ASSERT the capture is not blank, because a blank PNG is the failure
      // mode that survives every check keyed on the probe's own output.
      const drawn = await win.webContents.executeJavaScript(
        `document.getElementById('quota').textContent.trim()`);
      console.log(String(name).padEnd(10), String(img.getSize().width).padStart(5) + 'px',
        String(fs.statSync(file).size).padStart(6) + 'B', '->', JSON.stringify(drawn).slice(0, 90));
    }
    console.log('\nwrote', path.resolve(OUT_DIR));
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(bail);
    app.quit();
  }
});
