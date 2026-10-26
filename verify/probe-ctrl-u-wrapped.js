'use strict';
const { killChildTree, trackExit } = require('../host/kill-tree');
/* What does the REAL `claude` CLI's Ctrl-U do to a line that WRAPS over several rows? And does appending to such a line, with no clear at all, work?
   (BACKLOG #119 A3, PR #199 Dexter r2 N1. Re-runnable. Zero spend, zero network: the fake-endpoint technique of verify/probe-panel-line-input.js.)

     node verify/probe-ctrl-u-wrapped.js [--dump]

   For each width it types a 150-character line in chunks (as app/top-bar-display.js typingKeys does), reads the box, sends Ctrl-E then Ctrl-U
   and reads the box again (CLEAR), then types the line again and, with NO Ctrl-U, sends Ctrl-E and `; B` (APPEND) and reads the box. RESULT
   lines say what is left; the measured answer is recorded in the header of app/renderer.js. Only the pty this probe started is killed, by handle. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MARK = String.fromCharCode(0x276f);
const DASH = String.fromCharCode(0x2014);
const RULE = new RegExp('^' + String.fromCharCode(0x2500) + '{10,}$');

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
  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  send('message_start', { type: 'message_start', message: { id: 'msg_probe_' + n, type: 'message', role: 'assistant',
    model: model || 'probe-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

const filler = (n) => { let s = ''; let i = 0; while (s.length < n) s += 'word' + (i++) + ' '; return s.slice(0, n).trim(); };

async function runCase(claudeBin, c, dump) {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ctrl-u-'));
  const work = path.join(base, 'work');
  const config = path.join(base, 'config');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{}');
  const slashes = p => p.split('\\').join('/');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] }, [slashes(work)]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => { let body = {}; try { body = JSON.parse(raw); } catch { /* as-is */ } sse(res, 1, 'ok', body.model); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_CODE_GIT_BASH_PATH') continue;
    if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, ANTHROPIC_AUTH_TOKEN: 'probe-token-not-real',
    CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });

  const ROWS = 40;
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
  const live = (lines) => {
    const rules = []; lines.forEach((l, i) => { if (RULE.test(l.trim())) rules.push(i); });
    if (rules.length < 2) return { box: null };
    return { box: lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).map(l => l.trim()) };
  };
  const boxText = (l) => (l.box ? l.box.join(' ').replace(/\s+/g, ' ').split(MARK + ' ').join('').trim() : null);
  const out = { name: c.name, cols: c.cols, chars: c.text.length };
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) { const l = live(await screen()); if (l.box && l.box[0] && l.box[0].startsWith(MARK)) break; await sleep(200); }
    await sleep(1500);
    if (!live(await screen()).box) throw new Error('the CLI box never showed');
    const typeChunked = async (text) => { for (let i = 0; i < text.length; i += 40) { p.write(text.slice(i, i + 40)); await sleep(120); } await sleep(700); };
    p.write('\x05'); await sleep(120); p.write('\x15'); await sleep(120);
    await typeChunked(c.text);
    const typed = live(await screen());
    out.rowsAfterTyping = typed.box ? typed.box.length : null;
    out.typedWhole = boxText(typed) === c.text;
    // CLEAR: Ctrl-E, Ctrl-U on the wrapped line
    p.write('\x05'); await sleep(150); p.write('\x15'); await sleep(700);
    const cleared = live(await screen());
    out.afterCtrlU = { rows: cleared.box ? cleared.box.length : null, left: boxText(cleared), empty: boxText(cleared) === '' };
    if (dump) console.log('--- ' + c.cols + ' after Ctrl-U\n' + (await screen()).join('\n'));
    // APPEND without any clear: empty the box (extra Ctrl-U for whatever is left), type the line again, then Ctrl-E and `; B`
    for (let i = 0; i < 4; i++) { p.write('\x05'); await sleep(100); p.write('\x15'); await sleep(200); }
    await typeChunked(c.text);
    p.write('\x05'); await sleep(150);
    await typeChunked('; B');
    const appended = live(await screen());
    out.afterAppend = { rows: appended.box ? appended.box.length : null, equalsAplusB: boxText(appended) === c.text + '; B', text: boxText(appended) };
    if (dump) console.log('--- ' + c.cols + ' after append\n' + (await screen()).join('\n'));
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
  const lead = 'In src/app.js:4 ' + DASH + ' ';
  const text = lead + filler(150 - lead.length);
  let failed = false;
  for (const cols of [80, 120]) {
    const r = await runCase(claudeBin, { name: 'wrapped-150', cols, text }, process.argv.includes('--dump'));
    if (r.error) failed = true;
    console.log('RESULT ' + JSON.stringify(r));
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
