'use strict';
/* Does a PreToolUse hook's `updatedInput` really rewrite the Agent tool's input
   in the REAL `claude` CLI -- `model` and `prompt` -- so the subagent that is
   spawned runs on the rewritten model with the rewritten prompt? (BACKLOG #17,
   the tool belt.)

     node verify/probe-loadout-hook.js [--hook <path-to-hook.js>]

   Zero spend, zero network. Same technique as layer (a) of
   verify/probe-local-model.js: a tiny local HTTP server speaks just enough of
   `POST /v1/messages` (SSE, since the CLI asks for stream:true) and `claude -p`
   is spawned with ANTHROPIC_BASE_URL at it and an obviously fake credential.
   A stored OAuth login is never exercised -- it is the one auth path that
   would still be valid against api.anthropic.com if the base-URL override
   were silently ignored, and that is not worth a real spend.

   The conversation the fake server scripts:
     turn 1  (main agent, first request)  -> tool_use Agent { subagent_type:
             "general-purpose", prompt: "ORIGINAL-PROMPT-<token>", description }
     the CLI fires the PreToolUse hook (--settings <tempfile> carrying ONLY
             that hook, matcher Agent|Task) BEFORE launching the subagent
     turn 2  (the SUBAGENT's first request; recognised by ORIGINAL-PROMPT-<token>
             in its first user message) -> end_turn text
     turn 3  (main agent, sees the Agent tool_result) -> tool_use Bash
             `echo <token>`  (the "unrelated tool is untouched" claim)
     turn 4  (main agent, sees the Bash tool_result) -> end_turn
   Every request is recorded: model, the text blocks of the first user message.

   The loadout the hook reads (`--state <tempdir>`) equips the spawned agent
   type with Pace `haiku` and Method `verify-with-test`.

   CLAIMS (each printed PASS / FAIL, or SKIP with the reason when the CLI can't
   be spawned):
     (1) the subagent's request `model` reflects the rewritten `model`
     (2) its first user message carries the Method prefix at the START of a
         text block AND still contains the original prompt
     (3) the hook's wall time (spawned directly, 5 runs, median) and the gap
         between the server sending the Agent tool_use and the subagent's first
         request arriving (the CLI's whole spawn path, hook included)
     (4) the CLI version
     (5) an unrelated tool (Bash) is untouched: its command reaches the shell
         unchanged, and the hook (matcher Agent|Task) is never fired for it

   `--hook` defaults to host/loadout-hook.js. It exists so the measurement can
   run BEFORE that file does: this probe was first run against a throwaway
   ten-line hook to decide whether the feature is buildable at all.

   ELECTRON_RUN_AS_NODE is stripped from the child env defensively (`claude`
   is a plain Node CLI here, but the variable is inherited from any Claude Code
   session this is launched from).

   RESULTS, 2026-09-29, this machine (claude-cli 2.1.284), run against a throwaway
   ten-line hook (the real host/loadout-hook.js did not exist yet; re-run with
   the real one is recorded at the end of this comment when it lands):
     PASS (1) subagent request model = claude-haiku-4-5-20251001, main agent's
              = claude-opus-5-5. The CLI honours updatedInput.model
              on the Agent tool and resolves the alias 'haiku' itself.
     PASS (2) the subagent's first user message has a text block that STARTS
              with the Method prefix and still contains the original prompt
              (block 7 of 8: the CLI puts its own reminder blocks first).
     PASS (1c) control run with an empty loadout: subagent model = opus (inherits
              the main agent), no prefix. The rewrite is the hook's doing.
     INFO (3) hook wall time ~54 ms median (Node startup included), paid only
              per Agent spawn. Agent tool_use sent -> subagent's first request
              ~400-600 ms end to end (the CLI's whole spawn path).
     PASS (5) Bash is untouched: matcher Agent|Task never fires for it.
   ALSO MEASURED, worth knowing: on 2.1.284 the Agent tool returns at once with
   "Async agent launched successfully ... agentId: ..." -- a subagent runs in
   the background by default, so the rewrite has to land at spawn (it does: the
   hook runs before the launch).

   RE-RUN with the real host/loadout-hook.js (same day, same CLI): PASS (1),
   PASS (2), PASS (1c), PASS (5), hook median 59 ms, spawn path 436 ms. */

const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnWithTimeout } = require('./lib/spawn-with-timeout');

const T0 = Date.now();
const at = () => `${Math.round((Date.now() - T0) / 1000)}s`;
const slashes = p => String(p).replace(/\\/g, '/');

const AGENT_TYPE = 'general-purpose';
const METHOD_PREFIX = 'Before you finish, add or run the test that fails without your change.';

function firstUserTexts(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const first = msgs.find(m => m && m.role === 'user');
  if (!first) return [];
  if (typeof first.content === 'string') return [first.content];
  return (first.content || []).filter(c => c && c.type === 'text').map(c => c.text || '');
}

function toolResultTexts(body) {
  const out = [];
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c && c.type === 'tool_result') {
        out.push(typeof c.content === 'string' ? c.content
          : (c.content || []).map(x => (x && x.text) || '').join(''));
      }
    }
  }
  return out;
}

function startServer(token) {
  const requests = [];
  const marker = `ORIGINAL-PROMPT-${token}`;
  const events = { agentToolUseSentAt: null, subagentRequestAt: null };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* recorded as-is */ }
      const texts = firstUserTexts(body);
      const results = toolResultTexts(body);
      const isSub = texts.some(t => t.includes(marker));
      const sawAgentResult = !isSub && results.some(r => r.includes('SUB-DONE-' + token) || /agentId:/.test(r));
      const sawBashResult = !isSub && results.some(r => r.includes(token) && !/SUB-DONE-|agentId:/.test(r));
      if (requests.length > 12) { res.writeHead(500).end('probe request cap'); return; }
      const rec = { n: requests.length, roles: (body.messages || []).map(m => m.role + ':' + (Array.isArray(m.content) ? m.content.map(c => c.type).join('+') : 'str')).join(' | '), model: body.model, isSub, firstUserTexts: texts, toolResults: results };
      requests.push(rec);

      // What to say back.
      let content;
      let stop = 'end_turn';
      if (isSub) {
        content = [{ type: 'text', text: `SUB-DONE-${token}` }];
        if (!events.subagentRequestAt) events.subagentRequestAt = Date.now();
      } else if (!body.tools || !body.tools.length) {
        // Side requests (title generation and the like) carry no tools.
        content = [{ type: 'text', text: 'ok' }];
      } else if (sawBashResult) {
        content = [{ type: 'text', text: `PROBE-DONE-${token}` }];
      } else if (sawAgentResult) {
        content = [{ type: 'tool_use', id: 'toolu_bash_' + rec.n, name: 'Bash', input: { command: `echo ${token}` } }];
        stop = 'tool_use';
      } else {
        content = [{ type: 'tool_use', id: 'toolu_agent_' + rec.n, name: 'Agent',
          input: { subagent_type: AGENT_TYPE, description: 'probe subagent', prompt: marker } }];
        stop = 'tool_use';
        if (!events.agentToolUseSentAt) events.agentToolUseSentAt = Date.now();
      }
      rec.reply = content[0].type === 'tool_use' ? `tool_use ${content[0].name}` : 'text';

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_probe_' + rec.n, type: 'message',
        role: 'assistant', model: body.model || 'probe-model', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 } } });
      content.forEach((c, i) => {
        if (c.type === 'tool_use') {
          send('content_block_start', { type: 'content_block_start', index: i,
            content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
          send('content_block_delta', { type: 'content_block_delta', index: i,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
        } else {
          send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } });
        }
        send('content_block_stop', { type: 'content_block_stop', index: i });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', err => reject(new Error(`fake server failed to bind: ${err.message}`)));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, events }));
  });
}

// Spawn the hook directly, the way the CLI does: JSON on stdin. Wall time of
// the whole child, Node startup included -- that is the cost a spawn pays.
function timeHook(hookPath, stateDir, runs = 5) {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: AGENT_TYPE, description: 'd', prompt: 'p' } });
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    spawnSync(process.execPath, [hookPath, '--state', stateDir], { input: payload, encoding: 'utf8', windowsHide: true });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { times: times.map(x => Math.round(x)), medianMs: Math.round(times[Math.floor(times.length / 2)]) };
}

// One run of the real CLI against a fresh fake server, with `loadout` as the
// content of <state>/loadout.json.
async function runScenario(label, hookPath, loadout) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-loadout-probe-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'loadout.json'), JSON.stringify(loadout));

  // ONLY the hook: nothing else in this settings layer. (The user's own
  // layers still load -- their hooks cannot change the model or the prompt.)
  const settingsFile = path.join(tmp, 'probe-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Task',
    hooks: [{ type: 'command',
      command: `"${slashes(process.execPath)}" "${slashes(hookPath)}" --state "${slashes(stateDir)}"`,
      timeout: 10 }] }] } }, null, 2));

  const token = crypto.randomBytes(8).toString('hex');
  const fake = await startServer(token);
  const baseUrl = `http://127.0.0.1:${fake.port}`;
  console.log(`\n--- ${label}: fake server on ${baseUrl}; token ${token}`);

  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_KEY = 'probe-not-a-key';

  const args = ['-p', 'say hi', '--output-format', 'json', '--no-session-persistence',
    '--settings', settingsFile, '--permission-mode', 'bypassPermissions', '--allowedTools', 'Agent,Bash'];
  console.log(`[${at()}] spawning claude ${args.join(' ')}`);
  const r = await spawnWithTimeout({ cmd: 'claude', args, env, timeoutMs: 120000, shell: process.platform === 'win32' });
  await new Promise(res => fake.server.close(res));
  console.log(`[${at()}] exit=${r.code} timedOut=${r.timedOut} requests=${fake.requests.length}`);
  fake.requests.forEach(q => console.log(`      req#${q.n} model=${q.model} sub=${q.isSub} reply=${q.reply}`));
  return { tmp, stateDir, token, fake, r,
    main0: fake.requests.find(q => !q.isSub && q.reply === 'tool_use Agent'),
    sub: fake.requests.find(q => q.isSub) };
}

async function main() {
  const hi = process.argv.indexOf('--hook');
  const hookPath = path.resolve(hi > -1 ? process.argv[hi + 1] : path.join(__dirname, '..', 'host', 'loadout-hook.js'));

  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const cliVersion = (v.stdout || v.stderr || '').trim();
  console.log(`claude --version: ${cliVersion || 'UNKNOWN'}`);
  if (!cliVersion || v.status !== 0) {
    console.log('SKIP: the claude CLI could not be spawned (claude --version failed)');
    return;
  }
  if (!fs.existsSync(hookPath)) {
    console.log(`SKIP: hook script not found at ${hookPath}`);
    return;
  }

  let equipped, control;
  try {
    equipped = await runScenario('equipped (Pace haiku + Method verify-with-test)', hookPath,
      { agents: { [AGENT_TYPE]: ['pace-haiku', 'verify-with-test'] } });
    control = await runScenario('control (empty loadout)', hookPath, { agents: {} });
  } catch (err) {
    console.log(`SKIP: ${err.message}`);
    return;
  }

  const lines = [];
  const claim = (n, ok, text) => lines.push(`${ok ? 'PASS' : 'FAIL'} (${n}) ${text}`);
  const { sub, main0, token } = equipped;

  if (!sub) {
    lines.push('FAIL (1) the subagent never sent a request (Agent tool_use not executed, or the hook blocked it)');
    lines.push('FAIL (2) no subagent request to read');
  } else {
    claim(1, /haiku/i.test(sub.model || '') && (!main0 || sub.model !== main0.model),
      `subagent request model = ${sub.model} (main agent's = ${main0 && main0.model}); Pace 'haiku' was written`);
    const starts = sub.firstUserTexts.findIndex(t => t.startsWith(METHOD_PREFIX));
    const keeps = sub.firstUserTexts.some(t => t.includes(`ORIGINAL-PROMPT-${token}`));
    claim(2, starts > -1 && keeps,
      `subagent first user message: prefix at start of text block ${starts} of ${sub.firstUserTexts.length}, original prompt kept=${keeps}`);
    if (starts > -1) lines.push(`INFO (2) that block: ${JSON.stringify(sub.firstUserTexts[starts].slice(0, 160))}`);
  }

  const cs = control.sub;
  claim('1c', !!cs && !/haiku/i.test(cs.model || '') && !cs.firstUserTexts.some(t => t.includes(METHOD_PREFIX)),
    `control (nothing equipped): subagent model = ${cs && cs.model}, no prefix -- the rewrite above is the hook's doing, not the CLI default`);

  const t = timeHook(hookPath, equipped.stateDir);
  const ev = equipped.fake.events;
  const gap = ev.agentToolUseSentAt && ev.subagentRequestAt ? ev.subagentRequestAt - ev.agentToolUseSentAt : null;
  lines.push(`INFO (3) hook wall time, 5 direct runs incl. Node startup: ${t.times.join(', ')} ms (median ${t.medianMs} ms);`
    + ` Agent tool_use sent -> subagent's first request received: ${gap == null ? 'n/a' : gap + ' ms'} (whole CLI spawn path)`);
  lines.push(`INFO (4) claude-cli ${cliVersion}`);

  const bashOk = equipped.fake.requests.some(q => !q.isSub
    && q.toolResults.some(x => x.includes(token) && !/SUB-DONE-|agentId:/.test(x)));
  claim(5, bashOk, 'unrelated tool: Bash `echo <token>` ran and its output came back unchanged (the hook matcher is Agent|Task only)');

  console.log('\n=== RESULTS ===');
  lines.forEach(l => console.log(l));
  for (const s of [equipped, control]) { try { fs.rmSync(s.tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => { console.error('probe failed:', err && err.stack); process.exit(1); });
}

module.exports = { firstUserTexts, toolResultTexts, METHOD_PREFIX };
