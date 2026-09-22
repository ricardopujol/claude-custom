// @ts-nocheck
'use strict';
/**
 * Host smoke test — verifies the pty actually boots `claude` and that a
 * WebSocket client receives real TUI output. Runs without Electron.
 *
 *   node host/smoke-test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 7699; // isolated from the default dev port
const TIMEOUT_MS = 20000;

let received = '';
let host;

function finish(code, msg) {
  console.log('\n' + msg);
  try { host && host.kill(); } catch {}
  process.exit(code);
}

host = spawn(process.execPath, [path.join(__dirname, 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

host.stdout.on('data', (d) => process.stdout.write('[host] ' + d));
host.stderr.on('data', (d) => process.stderr.write('[host!] ' + d));

const deadline = setTimeout(() => {
  finish(1, 'FAIL: timed out with ' + received.length + ' bytes received');
}, TIMEOUT_MS);

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

  ws.on('open', () => {
    console.log('[test] attached');
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  });

  ws.on('message', (data) => {
    received += data.toString('utf8');

    // Wait for the Ink TUI itself, NOT merely for bytes. Startup emits plain
    // warning text with ANSI colour before Ink ever draws, so a byte-count
    // threshold passes while proving nothing about terminal fidelity. The
    // prompt glyph and a box rule together mean the TUI is genuinely drawing.
    const hasPrompt = /❯/.test(received);
    const hasBoxDrawing = /[─│╭╮╯╰┌┐└┘━┃]/.test(received);
    if (hasPrompt && hasBoxDrawing) {
      clearTimeout(deadline);

      const hasAnsi = /\x1b\[/.test(received);

      console.log('\n--- first 300 bytes (escaped) ---');
      console.log(JSON.stringify(received.slice(0, 300)));
      console.log('---------------------------------');
      console.log('bytes received :', received.length);
      console.log('ANSI sequences :', hasAnsi ? 'yes' : 'NO');
      console.log('box drawing    :', hasBoxDrawing ? 'yes' : 'not yet');

      ws.close();
      finish(hasAnsi ? 0 : 1, hasAnsi
        ? 'PASS: pty is hosting a live TUI and streaming to the client'
        : 'FAIL: no ANSI output — pty may not be running a TUI');
    }
  });

  ws.on('error', (e) => finish(1, 'FAIL: websocket error — ' + e.message));
}, 1200);
