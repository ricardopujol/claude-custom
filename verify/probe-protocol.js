'use strict';
/* Exercises the full attach protocol against the real host, without Electron:
   hello handshake (theme + roster), binary replay of the CURRENT screen, a
   hook-driven mood broadcast, and replay-on-reattach after a detach.

   The GUI is a pure view, so everything it depends on is observable here. */
const { spawn, spawnSync } = require('child_process');
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
const PORT = 7706;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '';
host.stdout.on('data', d => { hostLog += d.toString(); });
host.stderr.on('data', d => { hostLog += d.toString(); });

function attach() {
  return new Promise((resolve, reject) => {
    // NOTE: deliberately NOT binaryType='arraybuffer'. On the Node ws client
    // that hands back an ArrayBuffer, whose .toString('utf8') is the useless
    // "[object ArrayBuffer]" -- which looked exactly like the host sending no
    // terminal data. The browser renderer sets it and decodes via Uint8Array.
    const ws = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
    const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const control = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) term.write(Buffer.from(data).toString('utf8'));
      else { try { control.push(JSON.parse(data.toString())); } catch {} }
    });
    ws.on('error', reject);
    setTimeout(() => resolve({ ws, term, control }), 300);
  });
}

const screen = term => {
  const b = term.buffer.active, out = [];
  for (let y = 0; y < 30; y++) { const l = b.getLine(y); if (l) out.push(l.translateToString(true).trimEnd()); }
  return out.filter(Boolean);
};

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  await sleep(2000);
  const a = await attach();
  await sleep(9000);

  const hello = a.control.find(m => m.type === 'hello');
  check('hello handshake received', !!hello);
  check('hello carries a theme', !!(hello && hello.theme && hello.theme.terminal.background),
    hello && hello.theme && hello.theme.name);
  check('theme font stack has glyph-complete fallbacks',
    !!(hello && /monospace/.test(hello.theme.font.family)));
  check('hello reports hook availability', !!hello && typeof hello.hooks === 'boolean',
    hello && `hooks=${hello.hooks}`);

  check('hello carries per-project background art', !!(hello && hello.background),
    hello && require('path').basename(hello.background));
  check('background file exists on disk',
    !!(hello && hello.background && require('fs').existsSync(hello.background)));
  // Reads the constant rather than pinning a number: the dim was lowered from
  // 0.9 to 0.72 because the art was invisible in practice, and a hardcoded 0.9
  // here would have failed for the wrong reason.
  const { DIM_OPACITY } = require('../host/background');
  check('background is dimmed so text stays readable',
    !!(hello && new RegExp(`opacity="${DIM_OPACITY}"`)
      .test(require('fs').readFileSync(hello.background, 'utf8'))),
    `dim ${DIM_OPACITY}`);
  check('hello carries token usage', !!(hello && hello.usage && hello.usage.project),
    hello && hello.usage && `project ${hello.usage.project.total} over ${hello.usage.project.sessions} session(s)`);
  check('project usage exceeds this session, i.e. spans the folder',
    !!(hello && hello.usage.project.total >= hello.usage.session.total));

  const first = screen(a.term);
  check('TUI rendered through the binary channel', first.some(l => l.includes('❯')),
    `${first.length} rows`);

  // Drive a mood transition through the real helper + bridge + machine.
  const pipe = (hostLog.match(/hook bridge listening on (\S+)/) || [])[1];
  check('host bound the hook bridge', !!pipe, pipe);
  if (pipe) {
    const helper = path.join(REPO, '.harness', 'hook-helper.exe');
    spawnSync(helper, ['--pipe', pipe, '--event', 'PreToolUse'], {
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer' } }),
      windowsHide: true,
    });
    await sleep(800);
    const mood = a.control.find(m => m.type === 'mood');
    check('mood broadcast reached the client', !!mood, mood && `${mood.agent}:${mood.state}`);
    check('mood carries a portrait for the GUI', !!(mood && mood.portrait && mood.portrait.kind),
      mood && mood.portrait && mood.portrait.kind);
    // A real generated portrait has a path; an agent without one falls back to a
    // stable placeholder with initials. Asserting initials unconditionally made
    // this fail the moment the first real portrait landed.
    const art = mood && mood.portrait;
    check('portrait is usable by the GUI',
      !!(art && (art.kind === 'file' ? art.path : art.initials)),
      art && (art.kind === 'file' ? 'file: ' + require('path').basename(art.path) : 'placeholder: ' + art.initials));
  }

  // Detach, then reattach and confirm the screen is replayed rather than lost.
  a.ws.close();
  await sleep(1200);
  const b = await attach();
  await sleep(1200);

  const helloB = b.control.find(m => m.type === 'hello');
  const replayed = screen(b.term);
  check('reattach replays the current screen', replayed.some(l => l.includes('❯')),
    `${replayed.length} rows`);
  check('reattach hello carries the roster',
    !!(helloB && Array.isArray(helloB.roster)),
    helloB && JSON.stringify(helloB.roster.map(r => `${r.agent}:${r.state}`)));

  b.ws.close();
  try { host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
