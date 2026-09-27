'use strict';
/* Does the REAL `claude` CLI run, and CALL TOOLS, with ANTHROPIC_BASE_URL
   pointed at an Anthropic-compatible local endpoint (BACKLOG #4)?

     node verify/probe-local-model.js

   Two layers, so something is learned even without Ollama running:

   (a) Fake endpoint, zero spend. A tiny local HTTP server implements just
       enough of `POST /v1/messages` (the real Messages API shape, including
       SSE when the CLI asks for stream:true) to: record every request the
       CLI sends (headers with secrets masked, model, whether a tools array
       was sent and how big, system-prompt length); reply with a `tool_use`
       block for the Bash tool on the first turn; reply `end_turn` with a
       unique, unguessable token on the follow-up turn once it sees a
       tool_result. `claude -p` is spawned with ANTHROPIC_BASE_URL pointed at
       this server. The token can only have come from OUR server -- Anthropic
       cannot produce it -- so the CLI printing it back is the proof the
       round trip happened against the fake endpoint and not api.anthropic.com.
       Two auth-env variants are measured (ANTHROPIC_API_KEY vs
       ANTHROPIC_AUTH_TOKEN); both point at 127.0.0.1 and use an obviously
       fake credential, so neither can authenticate against, let alone spend
       against, the real API even if the CLI ignored the base URL. A stored
       OAuth login is deliberately never exercised here, for exactly that
       reason: it is the one auth path that WOULD still be valid against the
       real endpoint if the base-url override were silently ignored, and
       proving that failure mode is not worth the risk of a real spend.
       Cost: zero network calls leave this machine, zero tokens.

   (b) Real local endpoint, only if one is listening. Checks Ollama
       (127.0.0.1:11434/api/tags) and common LiteLLM-proxy ports for an
       Anthropic-compatible `/v1/messages`. If nothing is listening at all,
       or something is listening but doesn't answer on /v1/messages -> SKIP
       with the reason, per house rule (never a fake PASS). If found, repeats
       (a)'s prompt (picking the smallest locally-pulled model tagged with
       the "tools" capability from /api/tags) against it and records whether
       a real tool call happens.

   CLI version measured is printed first. ELECTRON_RUN_AS_NODE is not
   relevant here (no Electron child is spawned -- `claude` is a plain Node
   CLI) but is still stripped from the child env defensively.

   RESULTS, 2026-09-27, this machine (claude-cli 2.1.283):
     (a) fake endpoint, $0 spend, both auth variants: 2 requests each (turn 1
         no tool_result -> tool_use for Bash; turn 2 has tool_result -> end_turn
         with the token). `ANTHROPIC_API_KEY=probe-not-a-key` and
         `ANTHROPIC_AUTH_TOKEN=probe-not-a-key` BOTH work with ANTHROPIC_BASE_URL
         to route to a non-Anthropic endpoint -- api-key auth sends
         `x-api-key`, auth-token sends `authorization: Bearer`. Both attempts:
         exit=0, tool round-trip happened, PROBE-DONE-<token> came back in the
         result field -- proof the round trip hit the fake server, not
         api.anthropic.com. `--permission-mode bypassPermissions --allowedTools
         Bash` was sufficient; the `--dangerously-skip-permissions` fallback was
         never needed. Every request carried tools (91-634 of them depending on
         turn/session) and a ~5.8KB system prompt regardless of endpoint.
     (b) a REAL local endpoint was found on this machine: Ollama on
         127.0.0.1:11434, GET /api/tags -> 200, GET /v1/messages -> 405 (route
         exists, POST-only -- Ollama does speak the Anthropic Messages shape).
         A LiteLLM-style port (4000) answered 403 on both /v1/models and
         /v1/messages -- an unrelated local service, correctly excluded (not
         reported as Anthropic-compatible). Repeating the probe against Ollama
         with `--model llama3.2:3b` (auto-picked: smallest locally-pulled model
         tagged "tools" in /api/tags) produced: exit=0, `num_turns:1`,
         `stop_reason:end_turn`, NO tool_use in the reply -- the model's
         response was "I'm here to help! What's the tool call response you'd
         like me to format into an answer for the original user question?",
         i.e. it hallucinated as though a tool_result already existed and never
         actually invoked Bash. Confirms the backlog's own caveat ("tool use on
         local models is patchy") on the smallest available model. Also
         measured: the CLI logged `[claude-code:unrecognized_model]
         {"model":"llama3.2:3b"}` to stderr yet still reported
         `"total_cost_usd":0.00884` for the turn -- an unrecognized local model
         is silently priced as though it were a metered first-party model
         rather than shown as free/unknown; worth a note for #4's design (a
         local model must not be able to display a paid-looking cost). */

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const at = () => `${Math.round((Date.now() - T0) / 1000)}s`;

const results = { cliVersion: null, layerA: {}, layerB: {} };

function maskHeaders(h) {
  const out = {};
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === 'x-api-key' || lk === 'authorization') {
      out[k] = h[k] ? `<present, len ${String(h[k]).length}>` : '<absent>';
    } else if (['content-type', 'anthropic-version', 'anthropic-beta', 'user-agent', 'accept'].includes(lk)) {
      out[k] = h[k];
    }
  }
  return out;
}

function hasToolResult(body) {
  return Array.isArray(body.messages) && body.messages.some(m =>
    Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result'));
}

function systemLen(body) {
  if (typeof body.system === 'string') return body.system.length;
  if (Array.isArray(body.system)) return body.system.reduce((n, b) => n + (b.text ? b.text.length : 0), 0);
  return 0;
}

// --- the fake Anthropic-compatible endpoint -----------------------------------
function startFakeServer(token) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) {
      res.writeHead(404).end('not this probe');
      return;
    }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* recorded as-is below */ }
      const rec = {
        n: requests.length,
        headers: maskHeaders(req.headers),
        model: body.model,
        stream: !!body.stream,
        toolsPresent: Array.isArray(body.tools),
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        systemLen: systemLen(body),
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        hasToolResult: hasToolResult(body),
      };
      requests.push(rec);

      const wantsStream = !!body.stream;
      const respondingWithTool = !rec.hasToolResult;
      const msgId = 'msg_probe_' + rec.n;

      if (!wantsStream) {
        const content = respondingWithTool
          ? [{ type: 'tool_use', id: 'toolu_probe_' + rec.n, name: 'Bash', input: { command: `echo ${token}` } }]
          : [{ type: 'text', text: `PROBE-DONE-${token}` }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: msgId, type: 'message', role: 'assistant', model: body.model || 'probe-model',
          content, stop_reason: respondingWithTool ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: body.model || 'probe-model',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      });
      if (respondingWithTool) {
        send('content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_probe_' + rec.n, name: 'Bash', input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `echo ${token}` }) } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 15 } });
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: `PROBE-DONE-${token}` } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 } });
      }
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

// --- spawn the real CLI against a given base URL ------------------------------
function runClaudeAttempt(name, { baseUrl, authVar, extraArgs = [], timeoutMs = 60000,
  prompt = 'say hi' }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    env.ANTHROPIC_BASE_URL = baseUrl;
    env[authVar] = 'probe-not-a-key';

    const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', ...extraArgs];
    console.log(`[${at()}] spawning: claude ${args.join(' ')}  (env: ANTHROPIC_BASE_URL=${baseUrl}, ${authVar}=probe-not-a-key)`);

    let stdout = '', stderr = '';
    // Windows only knows how to run `claude.cmd` (the npm shim) through a
    // shell; every arg below is a hardcoded probe constant, never user input,
    // so DEP0190's injection warning does not apply here.
    const child = spawn('claude', args, {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, code, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name, code: null, stdout, stderr: `spawn error: ${err.message}` });
    });
  });
}

// --- layer (b): is anything Anthropic-compatible listening locally? ----------
function probeGet(url, timeoutMs = 1500, bodyLimit = 500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: body.slice(0, bodyLimit) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
  });
}

(async () => {
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  results.cliVersion = (v.stdout || v.stderr || '').trim();
  console.log(`claude --version: ${results.cliVersion}`);

  // === Layer (a): fake endpoint, zero spend ===================================
  console.log('\n=== Layer (a): fake Anthropic-compatible endpoint ===');
  const token = crypto.randomBytes(8).toString('hex');
  console.log(`probe token: ${token}`);
  const fake = await startFakeServer(token);
  const baseUrl = `http://127.0.0.1:${fake.port}`;
  console.log(`fake server listening on ${baseUrl}`);

  const attempts = [];
  for (const [name, authVar, extraArgs] of [
    ['apiKey+bypassPermissions', 'ANTHROPIC_API_KEY', ['--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash']],
    ['authToken+bypassPermissions', 'ANTHROPIC_AUTH_TOKEN', ['--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash']],
  ]) {
    const before = fake.requests.length;
    const r = await runClaudeAttempt(name, { baseUrl, authVar, extraArgs });
    const seen = fake.requests.slice(before);
    const sawToken = r.stdout.includes(token) || r.stdout.includes(`PROBE-DONE-${token}`);
    const toolRoundTrip = seen.some(rq => rq.hasToolResult);
    console.log(`[${at()}] ${name}: exit=${r.code} requestsSeen=${seen.length} toolRoundTrip=${toolRoundTrip} sawTokenInOutput=${sawToken}`);
    seen.forEach(rq => console.log(`      req#${rq.n} model=${rq.model} stream=${rq.stream} tools=${rq.toolsPresent}(${rq.toolCount}) systemLen=${rq.systemLen} hasToolResult=${rq.hasToolResult} headers=${JSON.stringify(rq.headers)}`));
    if (!seen.length) console.log(`      stdout: ${r.stdout.trim().slice(0, 300)}`);
    if (r.stderr.trim()) console.log(`      stderr: ${r.stderr.trim().slice(0, 300)}`);
    attempts.push({ name, exitCode: r.code, requestsSeen: seen, toolRoundTrip, sawTokenInOutput: sawToken,
      stdoutTail: r.stdout.trim().slice(-500), stderrTail: r.stderr.trim().slice(-500) });
  }

  let fallback = null;
  if (!attempts.some(a => a.toolRoundTrip && a.sawTokenInOutput)) {
    console.log(`[${at()}] neither bypassPermissions attempt completed a tool round-trip -- trying --dangerously-skip-permissions as a fallback`);
    const before = fake.requests.length;
    const r = await runClaudeAttempt('apiKey+dangerouslySkipPermissions', {
      baseUrl, authVar: 'ANTHROPIC_API_KEY', extraArgs: ['--dangerously-skip-permissions'],
    });
    const seen = fake.requests.slice(before);
    const sawToken = r.stdout.includes(token) || r.stdout.includes(`PROBE-DONE-${token}`);
    const toolRoundTrip = seen.some(rq => rq.hasToolResult);
    console.log(`[${at()}] fallback: exit=${r.code} requestsSeen=${seen.length} toolRoundTrip=${toolRoundTrip} sawTokenInOutput=${sawToken}`);
    seen.forEach(rq => console.log(`      req#${rq.n} model=${rq.model} stream=${rq.stream} tools=${rq.toolsPresent}(${rq.toolCount}) systemLen=${rq.systemLen} hasToolResult=${rq.hasToolResult}`));
    if (!seen.length) console.log(`      stdout: ${r.stdout.trim().slice(0, 300)}`);
    if (r.stderr.trim()) console.log(`      stderr: ${r.stderr.trim().slice(0, 300)}`);
    fallback = { name: r.name, exitCode: r.code, requestsSeen: seen, toolRoundTrip, sawTokenInOutput: sawToken,
      stdoutTail: r.stdout.trim().slice(-500), stderrTail: r.stderr.trim().slice(-500) };
  }

  await new Promise(r => fake.server.close(r));
  results.layerA = { token, port: fake.port, attempts, fallback };

  // === Layer (b): a real local endpoint, only if one exists ===================
  console.log('\n=== Layer (b): real local Anthropic-compatible endpoint ===');
  const checked = [];
  const ollama = await probeGet('http://127.0.0.1:11434/api/tags', 1500, 20000);
  checked.push('http://127.0.0.1:11434/api/tags (Ollama)');
  console.log(`Ollama /api/tags: ${ollama.ok ? `HTTP ${ollama.status}` : `unreachable (${ollama.reason})`}`);

  let ollamaAnthropic = null;
  if (ollama.ok) {
    ollamaAnthropic = await probeGet('http://127.0.0.1:11434/v1/messages');
    checked.push('http://127.0.0.1:11434/v1/messages');
    console.log(`Ollama /v1/messages: ${ollamaAnthropic.ok ? `HTTP ${ollamaAnthropic.status}` : `unreachable (${ollamaAnthropic.reason})`}`);
  }

  const liteLlmPorts = [4000, 8000, 8080];
  const liteLlmResults = [];
  for (const port of liteLlmPorts) {
    const url = `http://127.0.0.1:${port}/v1/models`;
    checked.push(url + ' (LiteLLM-style proxy)');
    const r = await probeGet(url);
    // A port answering at all (even 403/401) is a live service, but it is
    // only in scope for this probe if it also answers on the Anthropic
    // Messages path -- otherwise it is very likely an unrelated local dev
    // server and must not be reported as a usable endpoint.
    let messagesCheck = null;
    if (r.ok) {
      const murl = `http://127.0.0.1:${port}/v1/messages`;
      checked.push(murl);
      messagesCheck = await probeGet(murl);
      console.log(`LiteLLM-style :${port} /v1/messages: ${messagesCheck.ok ? `HTTP ${messagesCheck.status}` : `unreachable (${messagesCheck.reason})`}`);
    }
    liteLlmResults.push({ port, ...r, messagesCheck });
    console.log(`LiteLLM-style :${port} /v1/models: ${r.ok ? `HTTP ${r.status}` : `unreachable (${r.reason})`}`);
  }

  const liteLlmAnthropicCompatible = liteLlmResults.find(r => r.messagesCheck && r.messagesCheck.ok && r.messagesCheck.status !== 404);
  const anyEndpoint = ollama.ok || liteLlmResults.some(r => r.ok);
  const anthropicCompatible = (ollamaAnthropic && ollamaAnthropic.ok && ollamaAnthropic.status !== 404) || !!liteLlmAnthropicCompatible;
  const anthropicBaseUrl = (ollamaAnthropic && ollamaAnthropic.ok && ollamaAnthropic.status !== 404)
    ? 'http://127.0.0.1:11434'
    : (liteLlmAnthropicCompatible ? `http://127.0.0.1:${liteLlmAnthropicCompatible.port}` : null);

  if (!anyEndpoint) {
    console.log(`SKIP: no Anthropic-compatible local endpoint listening (checked: ${checked.join(', ')})`);
    results.layerB = { skip: `no local endpoint listening (checked: ${checked.join(', ')})` };
  } else if (!anthropicCompatible) {
    console.log(`SKIP: a local endpoint is listening but does not expose an Anthropic-compatible /v1/messages (checked: ${checked.join(', ')})`);
    results.layerB = { skip: `endpoint found but not Anthropic-compatible (checked: ${checked.join(', ')})`, ollama, ollamaAnthropic, liteLlmResults };
  } else {
    // A small, tool-capable model actually pulled on this machine -- the CLI
    // sends whatever model string it is given straight through to the local
    // endpoint (see the earlier attempt: "claude-opus-5-5" 404'd against
    // Ollama because Ollama has no such model, not because the endpoint
    // rejected the request shape). Prefer the smallest by parameter count.
    let localModel = null;
    try {
      const tags = JSON.parse(ollama.body).models || [];
      const toolCapable = tags.filter(m => Array.isArray(m.capabilities) && m.capabilities.includes('tools'));
      toolCapable.sort((a, b) => (a.size || Infinity) - (b.size || Infinity));
      localModel = toolCapable[0] && toolCapable[0].name;
    } catch (err) { console.log(`      could not parse /api/tags to pick a model: ${err.message}`); }
    console.log(`[${at()}] Anthropic-compatible endpoint found at ${anthropicBaseUrl} -- repeating the probe against it` +
      (localModel ? ` with local model ${localModel}` : ' (no tool-capable local model found; using the default model string)'));

    const extraArgs = ['--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash'];
    if (localModel) extraArgs.push('--model', localModel);
    const r = await runClaudeAttempt('real-local-endpoint', {
      baseUrl: anthropicBaseUrl, authVar: 'ANTHROPIC_API_KEY', extraArgs, timeoutMs: 90000,
      prompt: 'Use the Bash tool to run exactly: echo probe-ok-12345. Then reply with the single word done.',
    });
    console.log(`[${at()}] real endpoint: exit=${r.code}`);
    console.log(`      stdout: ${r.stdout.trim().slice(0, 800)}`);
    if (r.stderr.trim()) console.log(`      stderr: ${r.stderr.trim().slice(0, 300)}`);
    const toolRan = /probe-ok-12345/.test(r.stdout);
    results.layerB = { found: true, localModel, exitCode: r.code, toolRan,
      stdoutTail: r.stdout.trim().slice(-800), stderrTail: r.stderr.trim().slice(-500) };
  }

  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error('probe failed:', err && err.stack);
  process.exit(1);
});
