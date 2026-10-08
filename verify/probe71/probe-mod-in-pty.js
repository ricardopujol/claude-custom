'use strict';
/* Probe #71 (a): does a CLI mod (function-hooks plugin) render as terminal cells through a node-pty + xterm,
   the way claude-custom hosts claude? Do its Buttons respond to keys / SGR mouse clicks, can a button submit a
   prompt to the session, and does an edit to the mod hot-reload in a running session?
   Fake endpoint (zero spend), throwaway CLAUDE_CONFIG_DIR, only the pty this probe started is killed, by PID.
     node probe-mod-in-pty.js [--fullscreen-env NAME=VALUE] */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = require('path').join(__dirname, '..', '..').split(require('path').sep).join('/');
const pty = require(REPO + '/node_modules/node-pty');
const { Terminal } = require(REPO + '/node_modules/@xterm/headless');
const { killChildTree, trackExit } = require(REPO + '/host/kill-tree');
const MOD = path.join(__dirname, 'canvas-probe');
const REG = path.join(MOD, 'hooks', 'register.tsx');
const OUT = path.join(__dirname, 'out');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findClaude() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim();
  for (const rel of [path.join('bin', exe), 'cli.js']) {
    const p = path.join(npmRoot, '@anthropic-ai', 'claude-code', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sse(res, n, text, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_probe_' + n, type: 'message', role: 'assistant',
    model: model || 'probe-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

async function main() {
  const fsArg = process.argv.indexOf('--fullscreen-env');
  const extraEnv = fsArg > 0 ? Object.fromEntries([process.argv[fsArg + 1].split('=')]) : {};
  const label = fsArg > 0 ? 'fs' : 'main';
  fs.mkdirSync(OUT, { recursive: true });
  const original = fs.readFileSync(REG, 'utf8');
  const claudeBin = findClaude();
  if (!claudeBin) throw new Error('claude not found');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe71-'));
  const work = path.join(base, 'work');
  const config = path.join(base, 'config');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const slashes = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] }, [slashes(work)]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));

  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      requests.push({ main: raw.includes('"tools"'), clicked: raw.includes('CANVAS-BUTTON-CLICKED'), pluginFrame: /canvas-probe/.test(raw) });
      sse(res, requests.length, 'ok', 'probe-model');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_CODE_GIT_BASH_PATH') continue;
    if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'probe-token-not-real',
    CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, extraEnv);

  const COLS = 160, ROWS = 45;
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  let rawAll = '';
  const p = pty.spawn(claudeBin, ['--model', 'haiku', '--plugin-dir', MOD], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
  trackExit(p);
  p.onData(d => { rawAll += d; term.write(d); });
  const killed = () => { try { killChildTree(p); } catch { /* gone */ } };
  process.on('exit', killed);
  const flush = () => new Promise(r => term.write('', r));
  const screen = async () => {
    await flush();
    const b = term.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - ROWS); i < b.length; i++) out.push(b.getLine(i).translateToString(true));
    return out;
  };
  const log = [];
  const snap = async (name) => { const s = await screen(); log.push(`===== ${name}\n${s.join('\n')}`); return s.join('\n'); };
  const find = (lines, re) => { for (let y = 0; y < lines.length; y++) { const x = lines[y].search(re); if (x >= 0) return { x, y }; } return null; };
  const click = (pos) => { // SGR mouse, 1-based
    const c = pos.x + 1, r = pos.y + 1;
    p.write(`\x1b[<0;${c};${r}M`); p.write(`\x1b[<0;${c};${r}m`);
  };
  const tickOf = s => { const m = /CANVAS-BAND v\d tick=(\d+)/.exec(s); return m ? Number(m[1]) : null; };
  const presses = s => { const m = /presses=(\d+)/.exec(s); return m ? Number(m[1]) : null; };
  const res = { label, extraEnv };
  try {
    await sleep(9000);
    let s = await snap('after start');
    res.bandShown = /CANVAS-BAND v1/.test(s);
    res.tick1 = tickOf(s);
    await sleep(3000);
    s = await snap('3s later');
    res.tick2 = tickOf(s);
    res.altScreen = rawAll.includes('\x1b[?1049h');
    res.mouseModes = ['1000', '1002', '1003', '1006'].filter(m => rawAll.includes(`\x1b[?${m}h`));

    // band button by mouse
    let lines = await screen();
    const ping = find(lines, /\[ Ping \]|Ping/);
    res.pingAt = ping;
    if (ping) { click({ x: ping.x + 2, y: ping.y }); await sleep(1500); }
    s = await snap('after mouse click on Ping');
    res.pressesAfterClick = presses(s);
    res.toastAfterClick = /CANVAS-TOAST/.test(s);
    // band button by keys: ctrl+x tab, then hotkey p
    if (!(res.pressesAfterClick > 0)) {
      p.write('\x18'); await sleep(200); p.write('\t'); await sleep(400); p.write('p'); await sleep(1500);
      s = await snap('after ctrl+x tab p');
      res.pressesAfterKeys = presses(s);
      res.toastAfterKeys = /CANVAS-TOAST/.test(s);
      p.write('\x1b'); await sleep(500);
    }

    // pane via slash command
    p.write('/canvas'); await sleep(600); p.write('\r'); await sleep(2500);
    s = await snap('after /canvas');
    res.paneShown = /CANVAS-PANE v1/.test(s);
    res.paneLine = (s.split('\n').find(l => l.includes('CANVAS-PANE')) || '').trim();
    res.markdownHeading = /CANVAS-MD heading/.test(s);
    res.markdownRawHashes = /## CANVAS-MD/.test(s);
    const before = requests.filter(r => r.clicked).length;
    p.write('s'); await sleep(4000);
    s = await snap('after pressing s in pane');
    res.sendByHotkey = requests.filter(r => r.clicked).length > before;
    if (!res.sendByHotkey) {
      lines = await screen();
      const send = find(lines, /Send to session/);
      res.sendAt = send;
      if (send) { click({ x: send.x + 1, y: send.y }); await sleep(4000); }
      s = await snap('after mouse click on Send');
      res.sendByClick = requests.filter(r => r.clicked).length > before;
    }
    res.clickedPromptFramedAsPlugin = requests.some(r => r.clicked && r.pluginFrame);
    res.screenShowsClickedPrompt = /CANVAS-BUTTON-CLICKED/.test(s);

    // hot reload: edit the mod from outside while the session runs
    fs.writeFileSync(REG, original.replace("const VERSION = 'v1'", "const VERSION = 'v2'"));
    await sleep(5000);
    s = await snap('5s after editing VERSION to v2');
    res.hotReloadedBand = /CANVAS-BAND v2/.test(s);
    res.hotReloadedPane = /CANVAS-PANE v2/.test(s);
    res.stateKeptAcrossReload = tickOf(s);
    res.requests = requests.length;
  } finally {
    fs.writeFileSync(REG, original);
    killed();
    server.close();
    fs.writeFileSync(path.join(OUT, `screens-${label}.txt`), log.join('\n\n'));
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log(`note: could not remove ${base}: ${e.message}`); }
  }
  console.log('RESULT ' + JSON.stringify(res, null, 1));
}

main().then(() => process.exit(0), (e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
