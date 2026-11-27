'use strict';
/* A right click in a claude terminal pastes nothing; Ctrl+V still pastes (BACKLOG #194).

     node verify/probe-right-click.js

   Opens the real renderer with no host behind it (nothing reaches a pty, nothing is billed) and records what reaches the pty path
   (the renderer's own `sentInputs`), every `paste` DOM event, and every read of the clipboard bridge. Then, with text on the clipboard:

     right-click                   a real right button press and release over the terminal (webContents.sendInputEvent)
     right-click-mouse-reporting   the same with the CLI's mouse reporting on (DECSET 1000 + 1006): xterm WOULD send a report
     left-click-mouse-reporting    a left click with reporting on: still reported (the contrast)
     shell-tab-right-click         reporting on, the tab a plain shell (hostKind 'shell'): its right-button report is KEPT (mc, vim, htop)
     menu-closes-on-right-press    the layout menu is open, a right press in the terminal still closes it (nothing is stopped in the page)
     ctrl-v                        Ctrl+V, the one paste that must keep working

   Each case logs `sent=<n> pasteEvents=<n> clipboardReads=<n>`. PASS = every expectation above holds.

   Safety: the OS clipboard is Ricardo's: its text, HTML, RTF and image are snapshotted first and put back at the end, even on failure; a
   clipboard that holds anything else (files, ...) makes the probe SKIP without touching it. The scratch folder is removed.
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
const results = {};
let win = null;
let scratch = null;

// What the clipboard holds that this probe can put back; anything else means "don't touch it".
const KNOWN = /^(text\/plain|text\/html|text\/rtf|image\/png|image\/bmp|image\/jpeg|image\/tiff)$/i;
const formats = clipboard.availableFormats();
const restorable = formats.every((f) => KNOWN.test(f));
const saved = restorable ? { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() } : null;

function restoreClipboard() {
  if (!saved) return;
  try {
    clipboard.clear();
    const data = {};
    if (saved.text) data.text = saved.text;
    if (saved.html) data.html = saved.html;
    if (saved.rtf) data.rtf = saved.rtf;
    if (!saved.image.isEmpty()) data.image = saved.image;
    if (Object.keys(data).length) clipboard.write(data);
  } catch (err) { console.error('CLIPBOARD RESTORE FAILED:', err.message); }
}

async function finish(code) {
  restoreClipboard();
  try { if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.error('could not remove', scratch, e.message); }
  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  await sleep(500);
  process.exitCode = code;
  app.quit();
}
setTimeout(() => { console.error('TIMED OUT'); finish(2); }, 90000);

app.on('ready', async () => {
  try {
    if (!restorable) { console.log(`SKIP: the clipboard holds ${formats.join(', ')}, which this probe can't put back`); process.exitCode = 0; app.quit(); return; }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-right-click-'));
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

    await js(`window.__n = { paste: 0 }; document.addEventListener('paste', () => { window.__n.paste++; }, true); true`);
    const rect = JSON.parse(await js(`(() => { const r = term.element.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
    const click = (button) => {
      const ev = { x: rect.x, y: rect.y, button, clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...ev });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...ev });
    };
    const measure = async (name, act, extra) => {
      clipboard.writeText('PASTE-PROBE first\nPASTE-PROBE second');
      await js(`window.__n = { paste: 0 }; sentInputs.length = 0; term.focus(); true`);
      reads = 0;
      await act();
      await sleep(1200);
      const n = JSON.parse(await js(`JSON.stringify({ paste: window.__n.paste, sent: sentInputs.slice() })`));
      results[name] = { sent: n.sent.length, pasteEvents: n.paste, clipboardReads: reads, reported: n.sent.length ? n.sent : undefined, ...(extra ? await extra() : {}) };
      console.log(`${name} sent=${n.sent.length} pasteEvents=${n.paste} clipboardReads=${reads}${n.sent.length ? ' ' + JSON.stringify(n.sent) : ''}`);
    };
    win.focus(); win.webContents.focus();
    await measure('right-click', async () => click('right'));
    await js(`term.write('\\x1b[?1000h\\x1b[?1006h'); true`);
    await sleep(400);
    await measure('right-click-mouse-reporting', async () => click('right'));
    await measure('left-click-mouse-reporting', async () => click('left'));
    await js(`hostKind = 'shell'; true`);
    await measure('shell-tab-right-click', async () => click('right'));
    await js(`hostKind = null; true`);
    await measure('menu-closes-on-right-press', async () => {
      await js(`document.getElementById('layout-btn').click(); true`);
      await sleep(300);
      results.menuOpenedFirst = await js(`document.getElementById('layout-menu').hidden === false`);
      click('right');
    }, async () => ({ menuStillOpen: await js(`document.getElementById('layout-menu').hidden === false`) }));
    await js(`term.write('\\x1b[?1000l\\x1b[?1006l'); true`);
    await measure('ctrl-v', async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    });
    const zero = (r) => r.sent === 0 && r.pasteEvents === 0 && r.clipboardReads === 0;
    const ok = zero(results['right-click']) && zero(results['right-click-mouse-reporting'])
      && results['left-click-mouse-reporting'].sent > 0
      && results['shell-tab-right-click'].sent > 0
      && results.menuOpenedFirst === true && results['menu-closes-on-right-press'].menuStillOpen === false
      && results['ctrl-v'].clipboardReads > 0;
    console.log(ok ? 'PASS' : 'FAIL');
    await finish(ok ? 0 : 1);
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    await finish(1);
  }
});
