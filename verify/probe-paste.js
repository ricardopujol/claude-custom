'use strict';
/* Ctrl+V in the REAL window, against a REAL `claude` (BACKLOG #12 and #8).
   No prompt is ever submitted, so no tokens are spent.

     node verify/probe-paste.js

   What it measures, each case logged with the exact bytes on the wire:

     text/keys   Ctrl+V pressed in the window (webContents.sendInputEvent) with
                 two lines of text on the clipboard. Records every frame the
                 renderer sends to the host -- that is exactly what the host
                 writes to the pty -- and what the prompt box shows afterwards.
     text/menu   webContents.paste(), which is what the default Edit menu's
                 Ctrl+V accelerator calls. sendInputEvent may or may not reach
                 the menu accelerator, so this case measures that path directly.
     image/altv  A small PNG on the clipboard, then ESC+v (Alt+V, what Claude
                 Code documents for image paste on Windows) written to the pty.
                 Did `claude` attach it ("[Image #N]")?
     image/ctrlv The same with the raw Ctrl+V byte (\x16).

     image/keys  (with app/clipboard-bridge.js present) Ctrl+V pressed with an
                 image on the clipboard, through the shipped wiring.

   RESULTS, 2026-09-27, this machine:
     before #12  text/keys sent "\x1b[I" (focus-in) then "\x16" -- the raw Ctrl+V
                 byte -- and NOTHING was pasted. text/menu sent one bracketed
                 frame. image/altv: "[Image #1]" (claude attached it).
                 image/ctrlv: nothing.
     after #12   text/keys sends exactly one frame, "\x1b[200~PASTE-A first
                 line\rPASTE-B second line\x1b[201~" -- no \x16, no second copy,
                 not submitted. image/keys sends "\x1bv" and "[Image #1]" shows.

   Is sendInputEvent a fair stand-in for a real key press? For the one thing
   that matters here -- does an UNHANDLED key reach the application menu's
   accelerator -- yes: a separate check (a menu item on Ctrl+K, a blank page,
   sendInputEvent Ctrl+K) fired the accelerator. So "no paste before #12" means
   xterm cancelled the keydown and the default Edit menu's Ctrl+V never ran,
   not that the probe could not reach it.

   Each prompt draft is cleared with ONE Ctrl+C (clears a non-empty draft; the
   session is not exited) before the next case.

   Safety: the OS clipboard is Ricardo's. Its text and image are snapshotted
   first and put back at the end, even on failure. ANTHROPIC_API_KEY is deleted
   from the host's env so claude uses the Max login. ELECTRON_RUN_AS_NODE is
   deleted for this process and set only for the host child, as app/main.js
   does (CLAUDE.md: it is inherited from Claude Code). The host runs on its own
   port with its own token and only the host PID this probe spawned is killed. */
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

const { app, BrowserWindow, clipboard, nativeImage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const PORT = 7851;
const TOKEN = crypto.randomBytes(16).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const at = () => `${Math.round((Date.now() - T0) / 1000)}s`;

const HELPER = [path.join(REPO, '.harness', 'hook-helper.exe'),
  path.join(REPO, '..', '..', '..', '.harness', 'hook-helper.exe')].find(p => fs.existsSync(p));

// A 16x16 opaque red PNG, built in memory -- no file on disk to clean up.
function probeImage() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf.writeUInt32BE(0x0000ffff, i * 4); // BGRA red
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const saved = { text: clipboard.readText(), image: clipboard.readImage() };
function restoreClipboard() {
  clipboard.clear();
  if (!saved.image.isEmpty()) clipboard.writeImage(saved.image);
  if (saved.text) clipboard.writeText(saved.text);
  const ok = clipboard.readText() === saved.text;
  console.log(`\nclipboard restored: text ${ok ? 'matches' : 'DIFFERS'}, ` +
    `image ${saved.image.isEmpty() ? 'none before' : 'put back'}`);
}

let host = null;
let hostLog = '';
const results = {};
const bail = setTimeout(() => { console.error(`TIMED OUT at ${at()}`); finish(2); }, 240000);

async function finish(code) {
  clearTimeout(bail);
  try { restoreClipboard(); } catch (err) { console.error('CLIPBOARD RESTORE FAILED:', err.message); }
  try { if (host) host.kill(); } catch {}
  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  await sleep(1000);
  process.exitCode = code;
  app.quit();
}

app.on('ready', async () => {
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: REPO, CLAUDE_CUSTOM_TOKEN: TOKEN };
    if (HELPER) env.CLAUDE_CUSTOM_HELPER = HELPER;
    delete env.ANTHROPIC_API_KEY;
    host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout.on('data', d => { hostLog += d; });
    host.stderr.on('data', d => { hostLog += d; });

    const win = new BrowserWindow({
      width: 1200, height: 760, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        preload: path.join(REPO, 'app', 'preload.js') },
    });
    // The paste handlers app/main.js registers, when this checkout has them,
    // so the probe measures the shipped wiring rather than a copy of it.
    let bridge = null;
    try { bridge = require(path.join(REPO, 'app', 'clipboard-bridge.js')); } catch { /* not built yet */ }
    if (bridge) {
      bridge.registerClipboardHandlers({ ipcMain: require('electron').ipcMain, clipboard, win });
      console.log('paste bridge: registered (app/clipboard-bridge.js)');
    } else {
      console.log('paste bridge: none in this checkout (measuring the pre-#12 app)');
    }
    await sleep(2500);
    win.loadFile(path.join(REPO, 'app', 'renderer.html'),
      { query: { port: String(PORT), token: TOKEN, cwd: REPO } }).catch(() => {});
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 2) console.log(`      [page ${level === 3 ? 'error' : 'warn'}] ${String(message).slice(0, 300)}`);
    });

    const js = src => Promise.race([
      win.webContents.executeJavaScript(src),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`page call hung: ${src.slice(0, 60)}`)), 10000)),
    ]);
    async function until(pred, ms, step = 250) {
      for (let t = 0; t < ms; t += step) { const v = await pred(); if (v) return v; await sleep(step); }
      return null;
    }
    await until(async () => { try { return await js(`typeof screenLines === 'function'`); } catch { return false; } }, 30000, 500);

    // Every frame the page sends to the host, recorded in the page.
    await js(`window.__frames = [];
      const __send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.__frames.push(String(d)); return __send.call(this, d); };
      true`);
    const frames = async () => js(`window.__frames.splice(0)`);
    const screen = async () => (await js(`screenLines().join('\\n')`));
    const box = async () => (await screen()).split('\n').filter(l => /PASTE-|\[Image|\[Pasted/.test(l));
    const typeRaw = d => js(`send(${JSON.stringify(d)}); true`);
    const clearDraft = async () => { await typeRaw('\x03'); await sleep(900); await frames(); };

    const ready = await until(async () => /─{10,}/.test(await screen()), 60000, 500);
    console.log(`[${at()}] claude ${ready ? 'is up' : 'DID NOT COME UP'}`);
    if (!ready) throw new Error('claude never drew its input box');
    await sleep(3000);
    await frames();

    const esc = s => JSON.stringify(s).replace(/\\u001b/g, '\\x1b');
    const TEXT = 'PASTE-A first line\nPASTE-B second line';

    // --- text/keys: Ctrl+V as the user presses it ------------------------------
    clipboard.writeText(TEXT);
    win.focus(); win.webContents.focus();
    await js(`term.focus(); true`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'v', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    await sleep(1500);
    const keysFrames = await frames();
    const keysBox = await box();
    results.textKeys = { frames: keysFrames.map(esc), box: keysBox,
      pasteCount: keysFrames.join('').split('PASTE-A').length - 1,
      bracketed: keysFrames.some(f => f.startsWith('\x1b[200~')) };
    console.log(`[${at()}] text/keys  frames=${results.textKeys.frames.join(' ')} box=${JSON.stringify(keysBox)}`);
    await clearDraft();

    // --- text/menu: what the default Edit menu's Ctrl+V accelerator runs -------
    await js(`term.focus(); true`);
    win.webContents.paste();
    await sleep(1500);
    const menuFrames = await frames();
    const menuBox = await box();
    results.textMenu = { frames: menuFrames.map(esc), box: menuBox,
      pasteCount: menuFrames.join('').split('PASTE-A').length - 1,
      bracketed: menuFrames.some(f => f.startsWith('\x1b[200~')) };
    console.log(`[${at()}] text/menu  frames=${results.textMenu.frames.join(' ')} box=${JSON.stringify(menuBox)}`);
    await clearDraft();

    // --- image: does claude read the clipboard itself? -------------------------
    for (const [name, bytes] of [['imageAltV', '\x1bv'], ['imageCtrlV', '\x16']]) {
      clipboard.clear();
      clipboard.writeImage(probeImage());
      const hasImage = !clipboard.readImage().isEmpty();
      await typeRaw(bytes);
      const attached = await until(async () => (await box()).find(l => /\[Image/.test(l)), 8000, 400);
      results[name] = { sent: esc(bytes), clipboardHadImage: hasImage, attached: !!attached,
        evidence: attached || (await screen()).split('\n').filter(l => l.trim()).slice(-6) };
      console.log(`[${at()}] ${name} attached=${!!attached} ${attached ? JSON.stringify(attached) : ''}`);
      await clearDraft();
    }

    // --- shipped wiring, when present: Ctrl+V with an image on the clipboard ---
    if (bridge) {
      clipboard.clear();
      clipboard.writeImage(probeImage());
      await js(`term.focus(); true`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      const attached = await until(async () => (await box()).find(l => /\[Image/.test(l)), 8000, 400);
      const f = await frames();
      results.imageKeys = { frames: f.map(esc), attached: !!attached, evidence: attached || null };
      console.log(`[${at()}] image/keys attached=${!!attached} frames=${results.imageKeys.frames.join(' ')}`);
      await clearDraft();
    }

    await finish(0);
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    console.error('--- host log tail ---\n' + hostLog.split('\n').slice(-30).join('\n'));
    await finish(1);
  }
});
