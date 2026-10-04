'use strict';
/* Does the REAL `claude` CLI keep a `/skill` line submitted while a turn is running, and run it as a skill?
   (BACKLOG #61, step 0 of documentation/PLAN_WAND_SUBMIT.md. Re-runnable. Zero spend, zero network.)

     node verify/probe-queued-skill.js [--dump]

   The fake-endpoint technique of verify/probe-resume-queued-message.js: a local HTTP server speaks just enough
   of POST /v1/messages (SSE); the interactive CLI runs in a node-pty with ANTHROPIC_BASE_URL at it and a fake
   auth token, in a throwaway config dir and folder holding one project skill, `probeq`, whose body carries
   SKILL-BODY-<token>. The server HOLDS the first reply, so the turn is running while the probe types:

     1  "hello" + Enter                  -> request #1 arrives and is held (a turn is running)
     2  "/probeq" typed, then Enter      -> the line goes in mid-turn, the way a wand click would
     3  the held reply is released; the turn ends
     4  the CLI's NEXT request is read:
          (a) kept       some later request mentions the line at all
          (b) as a skill the later request carries SKILL-BODY-<token> (the skill's expansion), not just the text
                         "/probeq"
   Only the pty this probe started is killed, by PID. A temp folder, no permissions skipped. Exit 1 on FAIL
   (the CLI could not be driven); the verdict itself is printed as RESULT and exits 0.

   RESULTS: recorded in documentation/PLAN_WAND_SUBMIT.md ("Step 0 result"). */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
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
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
  const token = crypto.randomBytes(4).toString('hex');
  const bodyMarker = `SKILL-BODY-${token}`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-queued-skill-'));
  const work = path.join(base, 'work');
  const config = path.join(base, 'config');
  fs.mkdirSync(path.join(work, '.claude', 'skills', 'probeq'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(work, '.claude', 'skills', 'probeq', 'SKILL.md'),
    `---\nname: probeq\ndescription: probe skill for the queued-slash-command measurement\n---\n${bodyMarker}: reply with the word done.\n`);
  const slashes = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] }, [slashes(work)]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));

  // --- the fake endpoint ---
  const requests = [];
  let release = null;
  const held = new Promise(r => { release = r; });
  let firstMainSeen = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* recorded as-is */ }
      const all = JSON.stringify(body.messages || []);
      const rec = { n: requests.length, main: !!(body.tools && body.tools.length), t: Date.now(),
        hasBody: all.includes(bodyMarker), mentionsSlash: all.includes('/probeq'), hello: all.includes('PROBE-HELLO'),
        userTurns: (body.messages || []).filter(m => m && m.role === 'user').length };
      requests.push(rec);
      if (!rec.main) { sse(res, rec.n, 'ok', body.model); return; }
      if (!firstMainSeen) { firstMainSeen = true; held.then(() => sse(res, rec.n, 'first reply', body.model)); return; }
      sse(res, rec.n, 'second reply', body.model);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_AUTH_TOKEN = 'probe-token-not-real';
  env.CLAUDE_CONFIG_DIR = config;
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

  const COLS = 120, ROWS = 40;
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  const claudeBin = findClaude();
  if (!claudeBin) throw new Error('claude not found under npm root -g');
  const p = pty.spawn(claudeBin, ['--model', 'haiku'], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
  p.onData(d => term.write(d));
  const killed = () => { try { killPidTree(p.pid); } catch { /* gone */ } };
  process.on('exit', killed);
  const flush = () => new Promise(r => term.write('', r));
  const screen = async () => {
    await flush();
    const b = term.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - ROWS); i < b.length; i++) out.push(b.getLine(i).translateToString(true));
    return out.join('\n');
  };
  const waitFor = async (test, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await test(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const dump = async (label) => { if (process.argv.includes('--dump')) console.log(`--- ${label}\n${await screen()}`); };

  let verdict = null;
  try {
    await sleep(6000);
    await dump('after start');
    const s0 = await screen();
    if (/trust/i.test(s0) && /folder|files/i.test(s0)) { p.write('\r'); await sleep(3000); }
    p.write('PROBE-HELLO');
    await sleep(300);
    p.write('\r');
    await waitFor(() => requests.some(r => r.main), 30_000, 'the first main request (a turn is running)');
    await sleep(1000);
    await dump('turn running (reply held)');
    p.write('/probeq');
    await sleep(400);
    p.write('\r');
    await sleep(1500);
    await dump('after the mid-turn /probeq + Enter');
    const midScreen = await screen();
    release();
    await sleep(12_000);
    await dump('after release');
    const later = requests.filter(r => r.main).slice(1);
    const kept = later.some(r => r.mentionsSlash || r.hasBody);
    const asSkill = later.some(r => r.hasBody);
    verdict = { kept, asSkill, midScreenShowsQueued: /probeq/.test(midScreen), mainRequests: requests.filter(r => r.main).length };
    console.log(JSON.stringify(requests.map(r => ({ n: r.n, main: r.main, userTurns: r.userTurns, hello: r.hello, mentionsSlash: r.mentionsSlash, hasBody: r.hasBody }))));
  } finally {
    killed();
    server.close();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp */ }
  }
  console.log('RESULT ' + JSON.stringify(verdict));
  console.log(verdict.asSkill ? "RESULT: a /skill submitted mid-turn is KEPT and RUNS AS A SKILL (the skill's body reached the model)."
    : verdict.kept ? 'RESULT: the line was kept but did NOT run as a skill (only its text reached the model).'
      : 'RESULT: the line was NOT kept (no later request mentions it).');
}

main().then(() => process.exit(0), (e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
