'use strict';
/* Drives the live TUI through the real host path and observes state changes.
   Answers: does Shift+Tab cycle permission modes? does Shift+Enter insert a
   newline instead of submitting? */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

const PORT = 7702, COLS = 100, ROWS = 30;
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const { Unicode11Addon } = require('@xterm/addon-unicode11');
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
host.stderr.on('data', d => process.stderr.write('[host!] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = () => {
  const b = term.buffer.active, out = [];
  for (let y = 0; y < ROWS; y++) {
    const l = b.getLine(y);
    if (l) out.push(l.translateToString(true).replace(/\s+$/, ''));
  }
  return out;
};
const modeLine = () => lines().find(s => /permissions|plan mode|accept edits|bypass/i.test(s)) || '(none)';
const inputBox = () => lines().filter(s => /^[❯>]|^\s{2}\S/.test(s) && !/permissions|bypass|⚠|▌/.test(s));

// Widths of the horizontal rules — the alignment check that matters.
const ruleWidths = () => lines()
  .filter(s => /^─{10,}/.test(s))
  .map(s => [...s].length);

(async () => {
  let ws;
  for (let i = 0; i < 40; i++) {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const ok = await new Promise(r => {
      ws.once('open', () => r(true));
      ws.once('error', () => r(false));
    });
    if (ok) break;
    await sleep(250);
  }
  const send = d => ws.send(JSON.stringify({ type: 'input', data: d }));
  ws.on('message', d => term.write(d.toString('utf8')));
  ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }));
  await sleep(9000);

  console.log('\n--- ALIGNMENT ---');
  console.log('terminal cols   :', COLS);
  console.log('rule widths     :', JSON.stringify(ruleWidths()));

  console.log('\n--- SHIFT+TAB (CSI Z = \x1b[Z) ---');
  console.log('0 baseline :', modeLine());
  for (let i = 1; i <= 3; i++) {
    send('\x1b[Z');
    await sleep(900);
    console.log(`${i} after tab:`, modeLine());
  }

  console.log('\n--- SHIFT+ENTER ---');
  send('AAA');
  await sleep(700);
  console.log('typed AAA   :', JSON.stringify(inputBox()));

  for (const [name, seq] of [['ESC+CR \x1b\r', '\x1b\r'], ['CSI-u \x1b[13;2u', '\x1b[13;2u']]) {
    send(seq);
    await sleep(400);
    send('BBB');
    await sleep(900);
    const box = inputBox();
    const submitted = !box.some(s => s.includes('AAA'));
    console.log(`${name.padEnd(18)} -> submitted=${submitted} box=${JSON.stringify(box)}`);
    if (submitted) break;
  }

  send('\x1b'); await sleep(300); send('\x1b'); await sleep(500);
  try { ws.close(); } catch {}
  try { host.kill(); } catch {}
  process.exit(0);
})();
