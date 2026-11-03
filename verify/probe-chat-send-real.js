'use strict';
const { killChildTree, trackExit } = require('../host/kill-tree');
/* What does the chat view's type box (app/chat-view-state.js runChatSend) do against the REAL `claude` CLI? (PR #226 Dexter R2-1.
   Re-runnable. Zero spend, zero network: the fake-endpoint technique of verify/probe-panel-line-input.js.)

     node verify/probe-chat-send-real.js [--dump] [--only=<case,...>] [--measure]

   The interactive CLI runs in a node-pty at ANTHROPIC_BASE_URL (a local server speaking just enough of POST /v1/messages) with a fake
   token, in a throwaway config dir and folder. The page's own send runs against that CLI's screen (an @xterm/headless terminal fed by
   the pty), with the page's own readers (inputState, commandTyped, boxText, boxHoldsLine from app/top-bar-display.js): the real
   runChatSend, not a copy. A case passes when the send reports ok AND the endpoint received a request carrying the whole text.

     one-line-250 / one-line-2000   a long one-line message: chunked at 200 characters, so the CLI never sees a paste
     multi-3 / multi-8              a multi-line message (8 lines, ~600 characters): ONE bracketed paste, which the CLI may collapse to
                                    "[Pasted text #N +M lines]"

   --measure also writes one raw block of each size (a single write, then a bracketed paste of N lines), each into a fresh CLI, and
   prints what the box shows. Prints RESULT lines; exit 1 when a case FAILs.

   MEASURED (2026-11-03, claude-code from npm root -g, 120 columns):
     bracketed paste   2 and 3 lines show whole; 4 lines and more collapse to "[Pasted text #1 +3 lines]" (4, 5, 6, 8, 12 lines all did).
                       The line count decides, not the length (4 lines = 163 characters collapsed). Enter submits the real text.
     ONE plain write   200 to 800 characters showed whole; 1,000 and 2,000 collapsed to "[Pasted text #1]"; 1,200 and 1,500 did NOT.
                       So there is no clean threshold: it depends on how the pty splits the write into reads, and anything from about 1,000
                       characters can collapse. Chunks of 200 (app/top-bar-display.js COMMAND_CHUNK) never did.
   So a long one-line message is chunked (R2-1), and a multi-line one, which cannot be, is accepted when the box holds exactly one paste
   placeholder (app/chat-view-state.js onlyPlaceholder).
   Only the pty this probe started is killed, by handle. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'app', 'chat-view-state'));
const { inputState, commandTyped, boxText, boxHoldsLine } = require(path.join(ROOT, 'app', 'top-bar-display'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROWS = 40;
const COLS = 120;

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
const lines = (count, each) => Array.from({ length: count }, (_, k) => `line${k + 1} ${filler(each)}`.slice(0, each)).join('\n');

const CASES = [
  { name: 'one-line-250', text: filler(250) },
  { name: 'one-line-2000', text: filler(2000) },
  { name: 'multi-3', text: lines(3, 40) },
  { name: 'multi-8', text: lines(8, 75) },
];

// One CLI session: fn({ p, screen, live, requests, term }) -> result.
async function withCli(claudeBin, fn) {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-chat-send-'));
  const work = path.join(base, 'work');
  const config = path.join(base, 'config');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{}');
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
      requests.push({ main: !!(body.tools && body.tools.length), last: msgs.length ? JSON.stringify(msgs[msgs.length - 1].content) : '' });
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

  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  const p = pty.spawn(claudeBin, ['--model', 'haiku'], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
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
  try {
    const t0 = Date.now();
    for (;;) {
      const l = await screen();
      if (inputState(l, {}) === 'ready') break;
      if (Date.now() - t0 > 60000) throw new Error('the CLI box never showed');
      await sleep(200);
    }
    await sleep(1500);
    return await fn({ p, screen, requests, term });
  } finally {
    try { killChildTree(p); } catch { /* gone */ }
    server.close();
    await sleep(500);
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  }
}

async function runSend(claudeBin, c, dump) {
  return withCli(claudeBin, async ({ p, screen, requests, term }) => {
    let cur = await screen();
    const write = (frame) => p.write(JSON.parse(frame).data);
    const result = await state.runChatSend(c.text, {
      turn: () => 'idle', blocked: () => false, holds: () => false,
      lines: () => cur,
      sync: async () => { cur = await screen(); },
      termRows: () => ROWS, vim: () => false, connected: () => true, busy: () => false, lock: () => {},
      bracketed: () => term.modes.bracketedPasteMode === true,
      type: (frame) => { write(frame); return 'sent'; },
      cancelHold: () => {}, send: write, sleep, keyGap: 120,
      inputState, commandTyped, boxText, boxHoldsLine,
    });
    await sleep(3000);
    const ask = requests.filter(r => r.main).pop();
    const tail = c.text.slice(-12).replace(/\n/g, '\\n');
    const reached = !!ask && ask.last.includes(c.text.slice(0, 12)) && ask.last.includes(tail);
    if (dump) console.log(`--- ${c.name}\n${(await screen()).join('\n')}`);
    return { name: c.name, chars: c.text.length, lines: c.text.split('\n').length, bracketed: term.modes.bracketedPasteMode === true,
      sendOk: !!result.ok, note: result.note || null, requestCarriedWholeText: reached, requests: requests.filter(r => r.main).length };
  });
}

// What does the box show for ONE write of N characters, and for a bracketed paste of N lines? (the paste threshold)
async function measure(claudeBin) {
  // A FRESH CLI per row: a box left holding an earlier paste (or its placeholder numbering) would colour the next row.
  const out = [];
  const rows = [
    ...[200, 201, 300, 500, 800, 1000, 1200, 1500, 2000].map(n => ({ kind: 'one write', n, send: () => filler(n) })),
    ...[[2, 20], [3, 40], [4, 40], [5, 40], [6, 40], [8, 75], [12, 75]].map(([count, each]) => ({ kind: 'bracketed', count, text: lines(count, each) })),
  ];
  for (const row of rows) {
    out.push(await withCli(claudeBin, async ({ p, screen, term }) => {
      const body = row.kind === 'one write' ? row.send() : `\x1b[200~${row.text}\x1b[201~`;
      p.write(body); await sleep(1200);
      const l = await screen();
      const whole = l.join('\n');
      return { kind: row.kind, n: row.n, lines: row.count, chars: row.kind === 'one write' ? row.n : row.text.length,
        shows: /\[Pasted text/.test(whole) ? 'PLACEHOLDER' : 'text', placeholder: (/\[Pasted text[^\]]*\]/.exec(whole) || [null])[0], state: inputState(l, {}) };
    }));
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
    let r;
    try { r = await runSend(claudeBin, c, process.argv.includes('--dump')); } catch (e) { r = { name: c.name, error: e.message }; }
    const pass = !r.error && r.sendOk && r.requestCarriedWholeText;
    if (!pass) failed = true;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(r)}`);
  }
  if (process.argv.includes('--measure')) {
    try { for (const row of await measure(claudeBin)) console.log('RESULT ' + JSON.stringify(row)); } catch (e) { console.log('FAIL measure: ' + e.message); failed = true; }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
