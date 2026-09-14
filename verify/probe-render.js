'use strict';
/* Renders the live claude TUI through @xterm/headless and dumps the grid. */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

// The host refuses any connection without the session token -- see
// host/gatekeeper.js. A local tool reads it from the file the host writes,
// which is precisely what a web page cannot do.
function sessionToken() {
  try {
    return require('fs').readFileSync(
      require('path').join(__dirname, '..', '.harness', 'session-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const withToken = (url) => url + '?token=' + encodeURIComponent(sessionToken());


const PORT = 7701;
const COLS = 100, ROWS = 30;
const SETTLE_MS = Number(process.env.SETTLE_MS) || 9000;
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

let unicodeActive = 'not loaded';
try {
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  unicodeActive = term.unicode.activeVersion;
} catch (e) { unicodeActive = 'FAILED: ' + e.message; }

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
host.stderr.on('data', d => process.stderr.write('[host!] ' + d));

let bytes = 0;
function dump(label) {
  const buf = term.buffer.active;
  console.log(`\n===== ${label} (unicode=${unicodeActive}, ${bytes} bytes) =====`);
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const s = line.translateToString(true);
    if (s.trim() !== '') console.log(String(y).padStart(2) + '|' + s + '|');
  }
  console.log('='.repeat(60));
}

setTimeout(() => {
  const ws = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS })));
  ws.on('message', d => { const s = d.toString('utf8'); bytes += s.length; term.write(s); });
  ws.on('error', e => { console.log('WS ERROR', e.message); process.exit(1); });

  setTimeout(() => {
    dump('STARTUP RENDER');
    try { ws.close(); } catch {}
    try { host.kill(); } catch {}
    process.exit(0);
  }, SETTLE_MS);
}, 1500);
