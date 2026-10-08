'use strict';
/**
 * What Origin does the REAL Electron renderer put on a WebSocket handshake?
 *
 * This was an assumption, and a load-bearing one. host/gatekeeper.js accepts
 * `['file://', 'null', '']` as local origins, and the string `'null'` is
 * exactly what a document with an OPAQUE origin sends -- any `<iframe sandbox>`
 * without allow-same-origin serialises its origin that way. If the renderer
 * does not need `'null'`, accepting it weakens the origin gate (the one the
 * module calls "the one that closes the actual hole") to no purpose. If the
 * renderer DOES send it, removing it breaks attach completely.
 *
 * verify/probe-control-channel.js already encodes the guess -- it tests
 * `origin: 'file://'` under the label "renderer" -- but a probe asserting an
 * assumption is not a measurement of it. Nothing here had ever observed the
 * real handshake.
 *
 * Deliberately isolated: this launches Electron against a throwaway page and a
 * throwaway server, and never touches the host or spawns `claude`.
 *
 *   node verify/probe-renderer-origin.js
 */

const { WebSocketServer } = require('ws');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-origin-'));

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

wss.on('listening', () => {
  const { port } = wss.address();

  // A page loaded from file://, which is what app/main.js does.
  fs.writeFileSync(path.join(tmp, 'page.html'),
    `<!doctype html><meta charset="utf-8"><title>origin probe</title>
     <script>new WebSocket('ws://127.0.0.1:${port}/');<\/script>`);

  fs.writeFileSync(path.join(tmp, 'main.js'), `
const { app, BrowserWindow } = require('electron');
app.on('ready', () => {
  const win = new BrowserWindow({
    show: false,
    // The SAME webPreferences app/main.js uses, because these decide the
    // renderer's origin serialisation.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(${JSON.stringify(path.join(tmp, 'page.html'))});
  setTimeout(() => app.quit(), 4000);
});
`);

  let seen = false;
  wss.on('headers', (headers, req) => {
    seen = true;
    const raw = req.headers.origin;
    console.log('');
    console.log('  MEASURED renderer handshake');
    console.log('  ---------------------------');
    console.log('  Origin header present :', Object.prototype.hasOwnProperty.call(req.headers, 'origin'));
    console.log('  Origin value          :', JSON.stringify(raw));
    console.log('  typeof                :', typeof raw);
    console.log('');
    const { LOCAL_ORIGINS } = require('../host/gatekeeper');
    console.log('  gatekeeper LOCAL_ORIGINS:', JSON.stringify(LOCAL_ORIGINS));
    console.log('  would this origin pass? :',
      raw === undefined || LOCAL_ORIGINS.includes(raw));
    console.log('  does it need "null"?    :', raw === 'null');
    console.log('');
  });

  // ELECTRON_RUN_AS_NODE MUST BE STRIPPED, and this cost two failed runs to
  // find. Claude Code is itself an Electron app, so a probe launched from
  // inside a session inherits ELECTRON_RUN_AS_NODE=1 -- which makes the child
  // Electron start as PLAIN NODE. The symptom is not a clear error: the first
  // run said `Cannot find module 'electron'`, and once NODE_PATH was added to
  // "fix" that, `require('electron')` resolved to the npm package's exported
  // BINARY PATH STRING, so `app` was undefined. Neither message mentions the
  // env var that caused it. Anything in this repo that spawns Electron from a
  // tool session needs this line.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const electron = require('electron');
  const child = spawnElectron(electron, [path.join(tmp, 'main.js')], {
    stdio: 'inherit',
    windowsHide: true,
    env,
  });

  child.on('exit', () => {
    if (!seen) console.log('\n  NO HANDSHAKE OBSERVED — the page never connected.\n');
    wss.close();
    cleanup();
    process.exit(seen ? 0 : 1);
  });

  setTimeout(() => {
    try { child.kill(); } catch { /* already gone */ }
  }, 15000);
});
