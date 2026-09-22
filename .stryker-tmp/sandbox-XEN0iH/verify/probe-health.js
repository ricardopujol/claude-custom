// @ts-nocheck
'use strict';
/* Project HP and cooldowns, through the real host.

   The unit tests cover detection and parsing against the real reporter's bytes.
   What they cannot cover is the part that matters most here: that running the
   suite does NOT stall the host's event loop. The hook helper gives up
   connecting after 80ms, and a test run is SECONDS -- so if the run were
   synchronous it would drop every hook event for its whole duration.

   This measures the loop while a real `npm test` runs in the background. */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

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
const PORT = 7807;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

(async () => {
  await sleep(11000);
  const ws = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
  const control = [];
  await new Promise(r => ws.on('open', r));
  ws.on('message', (d, bin) => {
    if (bin !== true) { try { control.push(JSON.parse(d.toString())); } catch {} }
  });
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(1500);

  const hello = control.find(m => m.type === 'hello');
  check('hello carries project health', !!(hello && hello.health),
    hello && hello.health && `${hello.health.state}, runner=${hello.health.runner}`);
  check('the runner for this project was detected',
    !!(hello && hello.health && hello.health.runner === 'npm'),
    hello && hello.health && String(hello.health.runner));

  // Ask for a real run, and watch the loop while it happens.
  const pipe = (log.match(/hook bridge listening on (\S+)/) || [])[1];
  check('hook bridge is up', !!pipe, pipe);

  ws.send(JSON.stringify({ type: 'health' }));
  await sleep(300);
  check('the host reports it started running',
    control.some(m => m.type === 'health' && m.health && m.health.running));

  // THE MEASUREMENT. Fire hooks at the bridge WHILE the suite runs. If the run
  // were synchronous in the host, these would be refused -- that is the exact
  // failure that once cost 31 of 35 events.
  const helper = path.join(REPO, '.harness', 'hook-helper.exe');
  const before = (log.match(/\[hook\] PreToolUse/g) || []).length;
  let fired = 0;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline
         && !control.some(m => m.type === 'health' && m.health && m.health.ranAt)) {
    spawnSync(helper, ['--pipe', pipe, '--event', 'PreToolUse'], {
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'probe-agent' } }),
      windowsHide: true,
    });
    fired++;
    await sleep(400);
  }

  // Wait for the run to land if it has not already.
  for (let i = 0; i < 60; i++) {
    if (control.some(m => m.type === 'health' && m.health && m.health.ranAt)) break;
    await sleep(1000);
  }

  const delivered = (log.match(/\[hook\] PreToolUse/g) || []).length - before;
  check('hooks kept arriving WHILE the suite ran',
    fired > 0 && delivered >= fired,
    `${delivered}/${fired} delivered during the run`);

  const done = control.filter(m => m.type === 'health' && m.health && m.health.ranAt).pop();
  check('the run finished and reported a result', !!done,
    done && `${done.health.state} ${done.health.passed}/${done.health.total} in ${done.health.tookMs}ms`);
  check('the result is a real pass count, not zero or unknown',
    !!(done && done.health.total > 100 && done.health.state !== 'unknown'),
    done && JSON.stringify({ passed: done.health.passed, failed: done.health.failed }));

  try { ws.close(); host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
