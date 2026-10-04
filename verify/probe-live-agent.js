'use strict';
/* Does the REAL CLI fire a PreToolUse hook when it deploys an AGENT?

   Every check so far proved it fires for Bash, and the roster was driven by
   hand-fired Task hooks. Those are different code paths in Claude Code, and
   the roster staying empty in real sessions says so. */
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


const REPO = path.join(__dirname, '..');
const PORT = 7802;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  ws.on('message', (d, bin) => {
    if (bin === true) term.write(Buffer.from(d).toString('utf8'));
    else { try { control.push(JSON.parse(d.toString())); } catch {} }
  });
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(2500);

  // The newline goes SEPARATELY. Sent in one chunk with the text, Claude Code
  // treats a longer line as a paste and swallows the carriage return, so the
  // prompt sits in the box unsubmitted -- which looks exactly like the CLI
  // ignoring the request.
  ws.send(Buffer.from('Use the Task tool to launch the code-reviewer agent, prompt: say OK', 'utf8'));
  await sleep(1500);
  ws.send(Buffer.from(String.fromCharCode(13), 'utf8'));

  // Wait for the agent to FINISH, not just to start: SubagentStop is what
  // returns the roster entry to sleeping, and stopping at PreToolUse reported
  // it missing when it simply had not happened yet.
  for (let i = 0; i < 60 && !/\[hook\] SubagentStop/.test(log); i++) {
    await sleep(3000);
  }

  for (const raw of (log.match(/\[hook:raw\].*/g) || [])) console.log(raw);
  const hooks = (log.match(/\[hook\].*/g) || []);
  check('a PreToolUse hook fired for the agent launch',
    hooks.some(h => /PreToolUse (Task|code-reviewer)/.test(h)),
    hooks.join(' | ') || '(no hook events at all)');
  check('the host broadcast a mood, so the roster would light up',
    control.some(m => m.type === 'mood'),
    control.filter(m => m.type === 'mood').map(m => `${m.agent}:${m.state}`).join(', ') || '(none)');
  check('a SubagentStop arrived when it finished',
    hooks.some(h => /SubagentStop/.test(h)));

  const b = term.buffer.active;
  console.log('--- what the CLI showed ---');
  for (let y = 0; y < 30; y++) {
    const l = b.getLine(b.baseY + y);
    if (l) { const t = l.translateToString(true).trimEnd(); if (t) console.log('  ' + t); }
  }
  try { ws.close(); host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
