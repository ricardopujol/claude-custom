'use strict';
/**
 * claude-custom :: Electron main  (SPIKE — step 0 walking skeleton)
 *
 * Deliberately thin. The window is a pure view; all session state lives in the
 * host process. Main's only jobs are: make sure a host is listening, and open a
 * window pointed at it.
 */

const { app, BrowserWindow, shell } = require('electron');
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
    },
  });

  win.loadFile(path.join(__dirname, 'renderer.html'), {
    query: { port: String(PORT), cwd: PROJECT_CWD },
  });

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
