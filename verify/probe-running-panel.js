'use strict';
/* Does a FAILED Bash call leave the Running panel?

   THE BUG (2026-09-25): three Bash calls that had exited non-zero stayed
   "running" in the panel. A failed call fires PostToolUseFailure, never
   PostToolUse, and the harness had not hooked it.

   test/processes.test.js proves the tracker; this proves the WIRING -- that the
   settings file actually subscribes the event, the helper forwards it, and the
   host broadcasts the cleared list -- by driving the real host and the real
   `claude` through one failing command and reading the `processes` broadcasts
   the GUI would render.

     node verify/probe-running-panel.js */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..');
const PORT = 7809;
const TOKEN = 'probe-token-' + Date.now();
const NEEDLE = 'panel-probe-' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// Claude Code is itself an Electron app; a child spawned from a session would
// otherwise inherit this and start as plain Node.
const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO,
              CLAUDE_CUSTOM_TOKEN: TOKEN };
delete env.ELECTRON_RUN_AS_NODE;

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

(async () => {
  await sleep(12000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(TOKEN)}`);
  const snapshots = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'processes') snapshots.push(msg.running || []);
    } catch {}
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(2500);

  // The newline goes separately: sent in one chunk, a longer line is treated as
  // a paste and the carriage return is swallowed.
  ws.send(Buffer.from(`Use the Bash tool to run exactly: ls /definitely/not/here/${NEEDLE}   then reply DONE`, 'utf8'));
  await sleep(1500);
  ws.send(Buffer.from(String.fromCharCode(13), 'utf8'));

  for (let i = 0; i < 60 && !/\[hook\] PostToolUseFailure/.test(log); i++) await sleep(2000);
  await sleep(2500);

  const mine = list => list.filter(p => String(p.label).includes(NEEDLE));
  check('the host received PostToolUseFailure', /\[hook\] PostToolUseFailure/.test(log));
  check('the failing call was shown running while it ran',
    snapshots.some(s => mine(s).some(p => p.state === 'running')),
    `${snapshots.length} processes broadcasts`);
  const last = snapshots[snapshots.length - 1] || [];
  check('after it failed, the panel no longer lists it', mine(last).length === 0,
    JSON.stringify(mine(last)));
  // Stale would mean the Stop backstop ended it, i.e. its own close was lost --
  // the fix would then be masking the bug rather than removing it.
  check('its OWN close ended it, not a backstop (never shown stale)',
    !snapshots.some(s => mine(s).some(p => p.state === 'stale')));

  try { ws.close(); host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  if (failures) console.log('\n--- host log tail ---\n' + log.slice(-2000));
  process.exit(failures === 0 ? 0 : 1);
})();
