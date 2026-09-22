// @ts-nocheck
'use strict';
/* The one link no other probe covers: does the REAL claude CLI, spawned by the
   host with our --settings file, actually run the hook helper?

   Every other check fires the helper by hand, which proves the bridge, the mood
   machine and the roster all work -- and proves nothing about whether Claude
   Code ever calls them. This drives the real CLI with a real prompt. */
const { spawn } = require('child_process');
const fs = require('fs');
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


const REPO = path.join(__dirname, '..');
const PORT = 7799;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBin = b => b === true;

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  await sleep(12000);
  const ws = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
  const control = [];
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  await new Promise(r => ws.on('open', r));
  ws.on('message', (d, bin) => { if (isBin(bin)) term.write(Buffer.from(d).toString('utf8'));
    else { try { control.push(JSON.parse(d.toString())); } catch {} } });
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(2000);

  // A prompt that forces exactly one Bash tool call -- the cheapest real tool
  // use that the PreToolUse matcher covers.
  ws.send(Buffer.from('Run the bash command: echo harness-hook-probe\r', 'utf8'));

  for (let i = 0; i < 40 && !/\[hook\] PreToolUse/.test(log); i++) await sleep(3000);

  check('the real CLI ran the PreToolUse hook',
    /\[hook\] PreToolUse/.test(log),
    (log.match(/\[hook\].*/g) || ['(no hook events at all)']).slice(0, 6).join(' | '));
  // A Bash call is a PROCESS, not an agent: the mood machine is driven by Task.
  // Asserting a mood here was wrong about the harness, not about the hook.
  check('the client saw the tool call appear in the process panel',
    control.some(m => m.type === 'processes'),
    control.filter(m => m.type === 'processes')
      .flatMap(m => (m.running || []).map(r => r.label || r.tool || '?')).join(', ') || '(none)');
  check('the session id arrived, so token spend can be read',
    /\[hook\] SessionStart/.test(log));

  const b = term.buffer.active;
  const rows = [];
  for (let y = 0; y < 30; y++) { const l = b.getLine(b.baseY + y); if (l) rows.push(l.translateToString(true).trimEnd()); }
  console.log('--- what the CLI actually showed ---');
  for (const r of rows.filter(Boolean)) console.log('  ' + r);
  try { ws.close(); host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
