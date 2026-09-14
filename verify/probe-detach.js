'use strict';
/* Does the claude session survive with no viewer attached, and is it still
   responsive on reattach? Also enumerates the full shift+tab mode cycle. */
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


const PORT = 7703, COLS = 100, ROWS = 30;
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '';
host.stdout.on('data', d => { hostLog += d; });
host.stderr.on('data', d => { hostLog += d; });

let ptyPid = null;
function newTerm() {
  const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
const rows = t => {
  const b = t.buffer.active, out = [];
  for (let y = 0; y < ROWS; y++) { const l = b.getLine(y); if (l) out.push(l.translateToString(true).replace(/\s+$/, '')); }
  return out.filter(s => s !== '');
};
const statusOf = t => rows(t).find(s => /⏵⏵|⏸|plan mode|accept edits|bypass/i.test(s)) || '(no mode indicator)';

async function attach(t) {
  let ws;
  for (let i = 0; i < 40; i++) {
    ws = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
    const ok = await new Promise(r => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); });
    if (ok) break;
    await sleep(250);
  }
  ws.on('message', d => t.write(d.toString('utf8')));
  ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }));
  return { ws, send: d => ws.send(JSON.stringify({ type: 'input', data: d })) };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  const t1 = newTerm();
  const a = await attach(t1);
  await sleep(9000);
  ptyPid = (hostLog.match(/pty pid\s*:\s*(\d+)/) || [])[1];
  console.log('pty pid            :', ptyPid, '| alive:', alive(Number(ptyPid)));

  console.log('\n--- FULL SHIFT+TAB CYCLE ---');
  console.log('0 :', statusOf(t1));
  for (let i = 1; i <= 4; i++) { a.send('\x1b[Z'); await sleep(900); console.log(i, ':', statusOf(t1)); }

  console.log('\n--- DETACH ---');
  a.send('MARKER-BEFORE-DETACH');
  await sleep(800);
  console.log('typed marker, input shows:', JSON.stringify(rows(t1).find(s => s.startsWith('❯'))));
  a.ws.close();
  await sleep(4000);
  console.log('host proc alive    :', !host.killed && host.exitCode === null);
  console.log('pty alive detached :', alive(Number(ptyPid)));
  console.log('host log tail      :', hostLog.trim().split('\n').slice(-2).join(' | '));

  console.log('\n--- REATTACH (fresh client, no replay buffer in spike) ---');
  const t2 = newTerm();
  const b = await attach(t2);
  await sleep(1500);
  console.log('fresh client rows before input:', rows(t2).length);
  b.send('X');                 // any keystroke forces a redraw
  await sleep(2000);
  const line = rows(t2).find(s => s.startsWith('❯'));
  console.log('after keystroke, input line   :', JSON.stringify(line));
  console.log('state preserved across detach :', !!(line && line.includes('MARKER-BEFORE-DETACH')));

  b.send('\x1b'); await sleep(300); b.send('\x1b'); await sleep(400);
  try { b.ws.close(); } catch {}
  try { host.kill(); } catch {}
  process.exit(0);
})();
