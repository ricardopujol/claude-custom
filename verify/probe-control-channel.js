'use strict';
/* Can a web page type into your session?

   THE HOLE: the host binds a WebSocket on 127.0.0.1, and `{type:'input'}`
   writes straight into the pty running `claude --dangerously-skip-permissions`.
   Browsers do NOT apply CORS to WebSocket handshakes, so before this fix any
   page the user visited could connect and run commands.

   This drives the real host and asserts the refusal, because a unit test on the
   gatekeeper proves the FUNCTION and nothing about whether it is wired into the
   handshake. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..');
const PORT = 7808;
const TOKEN = 'probe-token-' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// Resolves to how the handshake ended, never throwing: a refusal is the
// expected outcome for most of these.
function attempt({ origin, token }) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${PORT}` + (token ? `?token=${encodeURIComponent(token)}` : '');
    const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});
    const finish = (result) => { try { ws.close(); } catch {} resolve(result); };
    ws.on('open', () => finish('connected'));
    ws.on('error', (err) => finish('refused: ' + String(err.message).slice(0, 60)));
    setTimeout(() => finish('timeout'), 6000);
  });
}

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO,
         CLAUDE_CUSTOM_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

(async () => {
  await sleep(11000);

  // THE ATTACK. This is the connection a page you visited would make.
  const evil = await attempt({ origin: 'https://evil.example', token: TOKEN });
  check('a web page is REFUSED even holding the token',
    evil.startsWith('refused'), evil);

  const localPage = await attempt({ origin: 'http://localhost:5173', token: TOKEN });
  check('a page on localhost is refused too', localPage.startsWith('refused'), localPage);

  const noToken = await attempt({ origin: undefined, token: undefined });
  check('a tokenless client is refused', noToken.startsWith('refused'), noToken);

  const wrongToken = await attempt({ origin: undefined, token: 'not-the-token' });
  check('a wrong token is refused', wrongToken.startsWith('refused'), wrongToken);

  // And the harness itself must still work.
  const renderer = await attempt({ origin: 'file://', token: TOKEN });
  check('the Electron renderer IS allowed', renderer === 'connected', renderer);

  const tool = await attempt({ origin: undefined, token: TOKEN });
  check('a local tool with the token is allowed', tool === 'connected', tool);

  // The token is a local secret: a page cannot read a file, which is what
  // separates "a program on this machine" from "a page you visited".
  const tokenFile = path.join(REPO, '.harness', 'session-token');
  check('the token is written for local tools to read', fs.existsSync(tokenFile));
  check('the token never reaches the host log', !log.includes(TOKEN));

  check('every refusal was logged with a reason',
    (log.match(/refused a connection:/g) || []).length >= 4,
    (log.match(/refused a connection:.*/g) || []).slice(0, 2).join(' | '));

  try { host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
