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
  const child = spawn(process.execPath, [hostPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: PROJECT_CWD,
    },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[host] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[host!] ${d}`));
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window detaches; it does not end the session.
app.on('window-all-closed', () => {
  app.quit();
});
