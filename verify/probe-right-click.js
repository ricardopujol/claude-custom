'use strict';
/* A right click in the terminal pastes nothing; Ctrl+V still pastes (BACKLOG #194).

     node verify/probe-right-click.js

   Opens the real renderer with no host behind it (nothing reaches a pty, nothing is billed) and records, in the
   page, everything that could carry a paste: every WebSocket frame the page sends, every `paste` DOM event, and
   every read of the clipboard bridge. Then, with text on the clipboard:

     right-click    a real right button press and release over the terminal (webContents.sendInputEvent)
     ctrl-v         Ctrl+V, the one paste that must keep working

   Each case logs `frames=<n> pasteEvents=<n> clipboardReads=<n>`. PASS = both right-click cases all zeros (the second with the CLI's
   mouse reporting on, where a left click IS still reported), ctrl-v has a read.

   Safety: the OS clipboard is Ricardo's: its text is snapshotted first and put back at the end, even on failure.
   ELECTRON_RUN_AS_NODE is deleted (CLAUDE.md). Electron starts through verify/lib/launch-electron.js (heavy lock). */
const { spawnElectron } = require('./lib/launch-electron');
const path = require('path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnElectron(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env }, {});
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, clipboard } = require('electron');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const savedText = clipboard.readText();
const results = {};
let win = null;

async function finish(code) {
  try { clipboard.clear(); if (savedText) clipboard.writeText(savedText); } catch (err) { console.error('CLIPBOARD RESTORE FAILED:', err.message); }
  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  await sleep(500);
  process.exitCode = code;
  app.quit();
}
setTimeout(() => { console.error('TIMED OUT'); finish(2); }, 90000);

app.on('ready', async () => {
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-right-click-'));
    win = new BrowserWindow({
      width: 1200, height: 760, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        preload: path.join(REPO, 'app', 'preload.js') },
    });
    const bridge = require(path.join(REPO, 'app', 'clipboard-bridge.js'));
    let reads = 0;
    const countingClipboard = new Proxy(clipboard, {
      get(t, k) { const v = t[k]; return typeof v === 'function' && /^read/.test(String(k)) ? (...a) => { reads++; return v.apply(t, a); } : (typeof v === 'function' ? v.bind(t) : v); },
    });
    bridge.registerClipboardHandlers({ ipcMain: require('electron').ipcMain, clipboard: countingClipboard, win });
    win.loadFile(path.join(REPO, 'app', 'renderer.html'),
      { query: { port: '1', token: crypto.randomBytes(8).toString('hex'), cwd: scratch } }).catch(() => {});
    const js = (src) => win.webContents.executeJavaScript(src);
    for (let i = 0; i < 60; i++) { try { if (await js(`typeof term !== 'undefined' && !!term.element`)) break; } catch {} await sleep(500); }

    await js(`window.__n = { frames: 0, paste: 0 };
      const __send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.__n.frames++; try { return __send.call(this, d); } catch {} };
      document.addEventListener('paste', () => { window.__n.paste++; }, true);
      term.onData((d) => { window.__n.frames++; window.__lastData = JSON.stringify(d); });
      true`);
    const rect = JSON.parse(await js(`(() => { const r = term.element.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
    const measure = async (name, act) => {
      clipboard.writeText('PASTE-PROBE first\nPASTE-PROBE second');
      await js(`window.__n = { frames: 0, paste: 0 }; term.focus(); true`);
      reads = 0;
      await act();
      await sleep(1200);
      const n = JSON.parse(await js(`JSON.stringify(window.__n)`));
      results[name] = { frames: n.frames, pasteEvents: n.paste, clipboardReads: reads };
      console.log(`${name} frames=${n.frames} pasteEvents=${n.paste} clipboardReads=${reads}`);
    };
    win.focus(); win.webContents.focus();
    await measure('right-click', async () => {
      const ev = { x: rect.x, y: rect.y, button: 'right', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...ev });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...ev });
    });
    // The CLI may switch xterm's mouse reporting on (DECSET 1000 + 1006). A right click then becomes a report the CLI
    // reads, and a CLI that pastes on a right click would fire. Measured here: the report is what reaches the pty.
    await js(`term.write('\\x1b[?1000h\\x1b[?1006h'); true`);
    await sleep(400);
    await measure('right-click-mouse-reporting', async () => {
      const ev = { x: rect.x, y: rect.y, button: 'right', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...ev });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...ev });
    });
    results['right-click-mouse-reporting'].reported = await js(`window.__lastData || null`);
    await measure('left-click-mouse-reporting', async () => {
      const ev = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...ev });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...ev });
    });
    console.log(`left click, for contrast: frames=${results['left-click-mouse-reporting'].frames} (a left click is still reported)`);
    await js(`term.write('\\x1b[?1000l\\x1b[?1006l'); true`);
    await measure('ctrl-v', async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    });
    const rc = results['right-click'];
    const rm = results['right-click-mouse-reporting'];
    const ok = rc.frames === 0 && rc.pasteEvents === 0 && rc.clipboardReads === 0 && rm.frames === 0 && rm.pasteEvents === 0 && rm.clipboardReads === 0
      && results['left-click-mouse-reporting'].frames > 0 && results['ctrl-v'].clipboardReads > 0;
    console.log(ok ? 'PASS' : 'FAIL');
    await finish(ok ? 0 : 1);
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    await finish(1);
  }
});
