'use strict';
const { killChildTree, trackExit } = require('../host/kill-tree');
/* What does the REAL `claude` CLI do with a panel line typed the way a panel button types it, and then Enter?
   (BACKLOG #71, PR #125 Dexter #1-#4. Re-runnable. Zero spend, zero network.)

     node verify/probe-panel-line-input.js [--dump]

   The fake-endpoint technique of verify/probe-queued-skill.js: a local HTTP server speaks just enough of POST /v1/messages (SSE);
   the interactive CLI runs in a node-pty at ANTHROPIC_BASE_URL with a fake auth token, in a throwaway config dir and folder
   (one package.json, one src/ folder). For each case the line is typed as app/renderer.js typeAndCheck does (Ctrl-E, Ctrl-U,
   then the line in ONE write), the box is read, Enter is pressed once, and the probe records whether a request carrying the
   line reached the endpoint and what the box holds afterwards:

     backslash    a line ending in `\`          (a): does `\` + Enter insert a newline instead of submitting?
     at-mention   `... @pack ...`               (b): do the file suggestions open, and does Enter accept a path instead of submitting?
     wrap-99/120  99 chars at 120 columns       the box wraps over rows: does it still submit?
     wrap-99/80   99 chars at 80 columns
     long-1999    1999 chars at 120 columns     a paste collapse? does it submit whole?
     nbsp         `Total:\u00a042`              how does the screen show it?
     double       `Total:  42`

   Only the pty this probe started is killed, by handle. A temp folder, no permissions skipped. Exit 1 on FAIL (the CLI could not
   be driven); the verdicts are printed as RESULT lines and exit 0. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PREFIX = "(from Claude's panel) ";

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

const filler = (n) => { let s = ''; let i = 0; while (s.length < n) s += `word${i++} `; return s.slice(0, n).trim(); };
const CASES = [
  { name: 'backslash', cols: 120, text: PREFIX + 'Save the report to C:\\Users\\ricar\\Reports\\' },
  { name: 'at-mention', cols: 120, text: PREFIX + 'review @pack and summarise' },
  { name: 'at-mention-end', cols: 120, text: PREFIX + 'review @pack' },
  { name: 'wrap-99/120', cols: 120, text: PREFIX + filler(99) },
  { name: 'wrap-99/80', cols: 80, text: PREFIX + filler(99) },
  { name: 'long-1999/120', cols: 120, text: PREFIX + filler(1999) },
  { name: 'long-1999/80', cols: 80, text: PREFIX + filler(1999) },
  { name: 'nbsp', cols: 120, text: PREFIX + 'Total:\u00a042' },
  { name: 'double', cols: 120, text: PREFIX + 'Total:  42' },
];

async function runCase(claudeBin, c, dump) {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-panel-line-'));
  const work = path.join(base, 'work');
  const config = path.join(base, 'config');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{}');
  fs.writeFileSync(path.join(work, 'src', 'a.js'), '');
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
      let body = {};
      try { body = JSON.parse(raw); } catch { /* as-is */ }
      const msgs = (body.messages || []).filter(m => m && m.role === 'user');
      const last = msgs.length ? JSON.stringify(msgs[msgs.length - 1].content) : '';
      requests.push({ main: !!(body.tools && body.tools.length), last });
      sse(res, requests.length, 'ok', body.model);
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
    CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });

  const ROWS = Number(process.env.PROBE_ROWS) || 40;
  const term = new Terminal({ cols: c.cols, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  const p = pty.spawn(claudeBin, ['--model', 'haiku'], { name: 'xterm-256color', cols: c.cols, rows: ROWS, cwd: work, env });
  trackExit(p);
  p.onData(d => term.write(d));
  const flush = () => new Promise(r => term.write('', r));
  const screen = async () => {
    await flush();
    const b = term.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - ROWS); i < b.length; i++) out.push(b.getLine(i).translateToString(true).replace(/\s+$/, ''));
    return out;
  };
  // The live box: the lines between the last two rules (what app/top-bar-display.js liveBox reads), and what is under it.
  const live = (lines) => {
    const rules = []; lines.forEach((l, i) => { if (/^─{10,}$/.test(l.trim())) rules.push(i); });
    if (rules.length < 2) return { box: null, below: [] };
    return { box: lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).map(l => l.trim()), below: lines.slice(rules[rules.length - 1] + 1).filter(Boolean) };
  };
  const out = { name: c.name, cols: c.cols };
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) { const l = live(await screen()); if (l.box && l.box[0] && l.box[0].startsWith('❯')) break; await sleep(200); }
    await sleep(1500);
    if (!live(await screen()).box) throw new Error('the CLI box never showed');
    p.write('\x05'); await sleep(120); p.write('\x15'); await sleep(120);
    // PROBE_CHUNK=<n> PROBE_GAP=<ms>: type the line in pieces, as the app's typingKeys does for a long line (one big write is taken for a paste)
    const chunk = Number(process.env.PROBE_CHUNK) || 0; const gap = Number(process.env.PROBE_GAP) || 120;
    if (chunk) { for (let i = 0; i < c.text.length; i += chunk) { p.write(c.text.slice(i, i + chunk)); await sleep(gap); } } else p.write(c.text);
    await sleep(900);
    const typed = live(await screen());
    out.chunk = chunk;
    out.rowsAfterTyping = typed.box ? typed.box.length : null;
    out.boxAfterTyping = typed.box ? typed.box.map(r => r.slice(0, 70) + (r.length > 70 ? '...' : '')) : null;
    out.belowAfterTyping = typed.below.map(r => r.slice(0, 70)).slice(0, 6);
    out.screenHasNbsp = typed.box ? typed.box.join('').includes('\u00a0') : null;
    out.boxJoinedMatches = typed.box ? typed.box.join('').replace(/\s+/g, ' ').replace(/^❯ ?/, '').trim() === c.text.replace(/\s+/g, ' ').trim() : null;
    if (dump) console.log(`--- ${c.name} after typing\n${(await screen()).join('\n')}`);
    p.write('\r');
    await sleep(3500);
    const after = live(await screen());
    out.boxAfterEnter = after.box ? after.box.map(r => r.slice(0, 70)) : null;
    out.requestsMain = requests.filter(r => r.main).length;
    const ask = requests.filter(r => r.main).pop();
    out.submittedWhole = !!ask && ask.last.includes(c.text.replace(PREFIX, '').slice(0, 30));
    out.submittedLast = ask ? ask.last.length : 0;
    out.submittedEndsWithText = !!ask && ask.last.includes(c.text.slice(-12).replace(/\\/g, '\\\\'));
    if (dump) console.log(`--- ${c.name} after Enter\n${(await screen()).join('\n')}`);
  } catch (err) {
    out.error = err.message;
  } finally {
    try { killChildTree(p); } catch { /* gone */ }
    server.close();
    await sleep(500);
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  }
  return out;
}

(async () => {
  const claudeBin = findClaude();
  if (!claudeBin) { console.log('FAIL claude not found under npm root -g'); process.exit(1); }
  const only = process.argv.find(a => a.startsWith('--only='));
  let failed = false;
  for (const c of CASES) {
    if (only && !only.slice(7).split(',').includes(c.name)) continue;
    const r = await runCase(claudeBin, c, process.argv.includes('--dump'));
    if (r.error) failed = true;
    console.log('RESULT ' + JSON.stringify(r));
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
