'use strict';
/**
 * claude-custom :: Electron main  (SPIKE — step 0 walking skeleton)
 *
 * Deliberately thin. The window is a pure view; all session state lives in the
 * host process. Main's only jobs are: make sure a host is listening, and open a
 * window pointed at it.
 */

const { app, BrowserWindow, Notification, clipboard, ipcMain, safeStorage, shell } = require('electron');
const { createVault } = require('./secret-vault');
const { createSecretService } = require('./secret-service');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CLAUDE_CUSTOM_PORT) || 7681;
const PROJECT_CWD = process.env.CLAUDE_CUSTOM_CWD || process.cwd();

function isHostListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function spawnHost() {
  const hostPath = path.join(__dirname, '..', 'host', 'host.js');
  // detached:true is the point — the host must outlive this window so a session
  // driven from Remote Control survives the GUI being closed.
  // Log to a FILE, not to pipes. Pipes belong to this Electron process, so
  // when the window closes they close with it -- and the next time the detached
  // host writes to stdout it takes EPIPE and dies. The host logs on every hook
  // event, so "detached" sessions were dying almost immediately, which is
  // exactly the detach property this spawn exists to provide.
  const logPath = path.join(__dirname, '..', '.harness', 'host.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, [hostPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: PROJECT_CWD,
    },
  });
  console.log('[main] host log:', logPath);
  child.unref();
  return child;
}

async function waitForHost(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostListening(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#11131a',
    title: 'claude-custom — spike/terminal-fidelity',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'renderer.html'), {
    query: { port: String(PORT), cwd: PROJECT_CWD,
             tab: process.env.CLAUDE_CUSTOM_SIDE_TAB || '' },
  });

  // Attention raised from main, not from the page. The renderer's own
  // Notification is subject to page permission and can neither flash the
  // taskbar nor focus the window when clicked; this can do all three.
  ipcMain.on('attention', (event, surfaces) => {
    if (event.sender !== win.webContents || !surfaces) return;
    // Logged even when nothing is shown. "Suppressed because you are looking at
    // it" and "never arrived" are the same silence otherwise, and telling those
    // two apart is what took two wrong diagnoses to learn.
    if (!surfaces.toast) console.log('[main] attention: suppressed (window focused)');
    if (surfaces.toast && Notification.isSupported()) {
      const n = new Notification({
        title: String(surfaces.toast.title || 'claude-custom'),
        body: String(surfaces.toast.body || ''),
        silent: !!surfaces.toast.silent,
      });
      n.on('click', () => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    }
    // Survives the toast: on Windows the taskbar button keeps flashing until
    // the window is looked at, which is the whole point for a blocked session.
    if (surfaces.flashTaskbar && !win.isFocused()) win.flashFrame(true);
    if (surfaces.toast) {
      console.log(`[main] attention: ${surfaces.toast.title}` +
        ` (silent=${surfaces.toast.silent}, flash=${!!surfaces.flashTaskbar})`);
    }
    if (surfaces.toast) console.log(`[main] attention body: ${surfaces.toast.body}`);
  });

  win.on('focus', () => win.flashFrame(false));

  // The secret store lives HERE, in main. Not in the host: the host owns the
  // pty, so keeping secrets out of it means no wiring mistake can put one into
  // the session. Not in the renderer: the window would then hold the file and
  // every value in it.
  const secrets = createSecretService({
    vault: createVault({
      file: path.join(__dirname, '..', '.harness', 'secrets.enc'),
      crypto: safeStorage,
    }),
    clipboard: {
      writeText: (t) => clipboard.writeText(t),
      readText: () => clipboard.readText(),
      clear: () => clipboard.writeText(''),
    },
  });

  const fromWindow = (event) => event.sender === win.webContents;
  ipcMain.handle('secrets:available', (e) => fromWindow(e) && secrets.available());
  ipcMain.handle('secrets:list', (e, query) => (fromWindow(e) ? secrets.list({ query }) : []));
  ipcMain.handle('secrets:add', (e, entry) => (fromWindow(e) ? secrets.add(entry || {}) : { ok: false }));
  ipcMain.handle('secrets:remove', (e, id) => (fromWindow(e) ? secrets.remove(id) : { ok: false }));
  ipcMain.handle('secrets:reveal', (e, id) => (fromWindow(e) ? secrets.reveal(id) : { ok: false }));
  ipcMain.handle('secrets:copy', (e, id) => (fromWindow(e) ? secrets.copy(id) : { ok: false }));

  // Headless verification of the secret store. The unit tests inject a fake
  // cipher, so they say nothing about whether DPAPI actually works here; this
  // exercises the real safeStorage and the real OS clipboard. It prints only
  // BOOLEANS -- never the secret, which would defeat the thing being tested.
  if (process.env.CLAUDE_CUSTOM_VAULT_PROBE) {
    const value = process.env.CLAUDE_CUSTOM_VAULT_PROBE;
    setTimeout(() => {
      console.log('[vault-probe] available:', secrets.available());
      const added = secrets.add({ label: 'probe entry', secret: value });
      console.log('[vault-probe] stored:', added.ok, added.error || '');
      const listed = secrets.list();
      console.log('[vault-probe] listed:', listed.length);
      console.log('[vault-probe] list-leaks:', JSON.stringify(listed).includes(value));
      if (added.ok) {
        const shown = secrets.reveal(added.entry.id);
        console.log('[vault-probe] revealed-matches:', shown.ok && shown.secret === value);
        secrets.copy(added.entry.id);
        console.log('[vault-probe] clipboard-matches:', clipboard.readText() === value);
        // Deliberately NOT removed. The probe's strongest assertion is that the
        // file holds no plaintext, and deleting the entry first made that
        // assertion pass against an empty 25-byte vault -- vacuously true.
        console.log('[vault-probe] left-on-disk: true');
      }
    }, 2500);
  }

  // Any external link opens in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async () => {
  if (!(await isHostListening(PORT))) {
    console.log('[main] no host on port', PORT, '— spawning one');
    spawnHost();
    const up = await waitForHost(PORT);
    if (!up) console.error('[main] host did not come up in time');
  } else {
    console.log('[main] host already listening on', PORT, '— reattaching');
  }

  const win = createWindow();

  // Headless verification path. CLAUDE_CUSTOM_SCREENSHOT=<file> renders the
  // real window, waits for the TUI to draw, writes a PNG and exits. The GUI is
  // the one surface the headless probes cannot reach, so this is how it gets
  // checked at all rather than assumed to look right.
  if (process.env.CLAUDE_CUSTOM_SCREENSHOT) {
    const outFile = process.env.CLAUDE_CUSTOM_SCREENSHOT;
    const waitMs = Number(process.env.CLAUDE_CUSTOM_SCREENSHOT_DELAY) || 12000;

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['verbose', 'info', 'warn', 'error'][level] || level;
      console.log(`[renderer:${tag}] ${message} (${String(sourceId).split('/').pop()}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.error('[main] renderer gone:', d.reason));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[main] load failed:', code, desc));

    // Optional keystroke drive. The renderer's custom key handler -- above all
    // the hardcoded Shift+Enter -- is the one piece of the input path that the
    // headless probes cannot reach, because it lives in xterm's browser-side
    // event handling rather than on the wire.
    if (process.env.CLAUDE_CUSTOM_INPUT_TEST) {
      const type = text => {
        for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      };
      const key = (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      };
      setTimeout(() => {
        win.focus();
        type('LINE-ONE');
        // If Shift+Enter is mishandled this SUBMITS instead of inserting a
        // newline, which the screenshot shows unmistakably.
        key('Enter', ['shift']);
        type('LINE-TWO');
      }, Math.max(1000, waitMs - 3000));
    }

    setTimeout(async () => {
      try {
        const fsMod = require('fs');
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        if (!png || png.length === 0) throw new Error('capturePage returned an empty image');
        fsMod.writeFileSync(outFile, png);
        // Verify before exiting. app.exit() is a hard exit that has been
        // observed truncating the file to zero bytes even after a synchronous
        // write, and a 0-byte PNG reads as "the GUI rendered nothing" rather
        // than as the write race it actually is.
        const onDisk = fsMod.statSync(outFile).size;
        if (onDisk !== png.length) throw new Error(`wrote ${png.length}B but file is ${onDisk}B`);
        console.log(`[main] screenshot written: ${outFile} (${onDisk} bytes)`);
      } catch (err) {
        console.error('[main] screenshot failed:', err.message);
      }
      // Let the filesystem settle before the hard exit.
      setTimeout(() => app.exit(0), 400);
    }, waitMs);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window detaches; it does not end the session.
app.on('window-all-closed', () => {
  app.quit();
});
