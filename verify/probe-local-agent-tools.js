'use strict';
/* Can a LOCAL model run a read-only agent through the real `claude` CLI? (BACKLOG #4,
   spike/local-agent-tools; follows PR #61's verify/probe-local-model.js)

     node verify/probe-local-agent-tools.js --models a,b,c [--runs 3] [--ctx 16384] [--out file.json]
     node verify/probe-local-agent-tools.js --self-test

   For each model it runs 10 read-only tasks on THIS repo, N times each, through
   `claude -p --output-format stream-json --verbose` with:
     ANTHROPIC_BASE_URL = http://127.0.0.1:11434 (Ollama), ANTHROPIC_API_KEY = a dummy.
   NO billed call is possible: the key is fake and the endpoint is loopback; the harness
   refuses to start if the base URL isn't loopback. Tools are limited to Read, Grep, Glob
   (--tools plus --disallowedTools Bash,Edit,Write); user hooks/settings are not loaded
   (--setting-sources project) so nothing outside the repo fires.

   Per task it records: tool calls (names, well-formed = the CLI accepted them, made-up =
   a tool outside the offered set, real = the file/dir argument exists), whether the final
   answer holds the ground truth, made-up paths in the answer, wall time, total_cost_usd the
   CLI displays, and Ollama's size/size_vram for the model right after the run.

   Heavy work: each chunk of tasks takes ~/.claude/scripts/heavy-lock.ps1 and releases it.
   Models are derived with `ollama create` at --ctx (num_ctx) because the Anthropic endpoint
   can't pass num_ctx, and Ollama's default 8192 truncates the CLI's prompt + tool results.
   Derived models and the loaded weights are removed/unloaded at the end. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { spawnWithTimeout } = require('./lib/spawn-with-timeout');

const REPO = path.resolve(__dirname, '..');
const OLLAMA = 'http://127.0.0.1:11434';
const OFFERED = ['Read', 'Grep', 'Glob'];
const LOCK_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'heavy-lock.ps1');
const CHUNK = 10;
const TASK_TIMEOUT_MS = 180000;

// Ground truth is fixed facts about this repo at the spike's base commit.
const TASKS = [
  { id: 'T1-find-def', prompt: 'Where is the function killPidTree defined? Give the file path.',
    all: [/host\/kill-tree\.js/] },
  { id: 'T2-callers', prompt: 'Which source files under host/ (not tests) require killPidTree from kill-tree? List the file paths.',
    all: [/host\/host\.js|host\.js/, /stop-deps\.js/] },
  { id: 'T3-summarise', prompt: 'Summarise app/secret-mask.js in two sentences.',
    all: [/password/i, /toggle|visible|show/i] },
  { id: 'T4-value', prompt: 'In app/secret-mask.js, what does inputType() return when the secret is not shown?',
    all: [/password/i] },
  { id: 'T5-config', prompt: 'What is the test script in package.json?',
    all: [/node --test/] },
  { id: 'T6-kinds', prompt: 'In app/models-favourites.js, what are the two favourite KINDS?',
    all: [/openrouter/i, /claude/i] },
  { id: 'T7-outcome', prompt: 'In host/stop-holder.js, which stopHolder outcome means the holder has a window open and was NOT stopped?',
    all: [/has-window/] },
  { id: 'T8-list', prompt: 'List every outcome name that stopHolder in host/stop-holder.js can return.',
    atLeast: [6, [/stopped/, /gone/, /has-window/, /unsure/, /changed/, /unproven/, /failed/]] },
  { id: 'T9-which-file', prompt: 'Which file in app/ defines a function named toggleFavourite?',
    all: [/models-favourites\.js/] },
  { id: 'T10-line', prompt: 'On which line of host/kill-tree.js is function killPidTree declared? Reply with the line number.',
    all: [/\b115\b/] },
];

// --- pure helpers (self-tested) ------------------------------------------------

/** stream-json lines -> { toolCalls, finalText, result, models }. Tolerates junk lines. */
function parseStream(stdout) {
  const toolCalls = [];
  const byId = new Map();
  let finalText = '', result = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    if (ev.type === 'assistant') {
      for (const c of content) {
        if (c && c.type === 'tool_use') { const t = { id: c.id, name: c.name, input: c.input || {}, error: null }; toolCalls.push(t); byId.set(c.id, t); }
        else if (c && c.type === 'text') finalText = c.text;
      }
    } else if (ev.type === 'user') {
      for (const c of content) {
        if (c && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
          const t = byId.get(c.tool_use_id);
          t.error = c.is_error ? (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 200) : null;
        }
      }
    } else if (ev.type === 'result') result = ev;
  }
  if (result && typeof result.result === 'string' && result.result.trim()) finalText = result.result;
  return { toolCalls, finalText, result };
}

function classifyTools(toolCalls, { repo = REPO, exists = fs.existsSync } = {}) {
  let madeUp = 0, rejected = 0, realTarget = 0, withTarget = 0;
  for (const t of toolCalls) {
    if (!OFFERED.includes(t.name)) { madeUp++; continue; }
    if (t.error) rejected++;
    const target = t.input && (t.input.file_path || t.input.path);
    if (typeof target === 'string') {
      withTarget++;
      if (exists(path.isAbsolute(target) ? target : path.join(repo, target))) realTarget++;
    }
  }
  return { calls: toolCalls.length, madeUp, rejected, wellFormed: toolCalls.length - madeUp - rejected, withTarget, realTarget };
}

function checkAnswer(task, text) {
  const t = String(text || '');
  if (task.atLeast) return task.atLeast[1].filter(r => r.test(t)).length >= task.atLeast[0];
  return task.all.every(r => r.test(t));
}

/** File-looking tokens in an answer that don't exist in the repo (by path or by basename). */
function madeUpPaths(text, { repo = REPO, exists = fs.existsSync, baseNames = null } = {}) {
  const names = baseNames || new Set();
  const found = String(text || '').match(/[\w\-./\\]+\.(?:js|json|md|html|css|cs|ps1)\b/g) || [];
  const bad = [];
  for (const raw of new Set(found)) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (/^(https?:|node_modules)/.test(p)) continue;
    const abs = path.isAbsolute(p) ? p : path.join(repo, p);
    if (exists(abs) || names.has(path.basename(p)) && !p.includes('/')) continue;
    bad.push(raw);
  }
  return bad;
}

function repoBaseNames(repo = REPO) {
  const set = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else set.add(e.name);
    }
  };
  walk(repo);
  return set;
}

function assertLoopback(url) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`refusing non-loopback base URL ${url}`);
}

// --- Ollama --------------------------------------------------------------------
function ollamaJson(method, pth, body) {
  return new Promise((resolve) => {
    const req = http.request(OLLAMA + pth, { method, headers: { 'content-type': 'application/json' }, timeout: 120000 }, (res) => {
      let b = ''; res.on('data', d => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const unload = (model) => ollamaJson('POST', '/api/generate', { model, keep_alive: 0 });
async function vram(model) {
  const ps = await ollamaJson('GET', '/api/ps');
  const m = ps && (ps.models || []).find(x => String(x.name).startsWith(model) || String(x.model).startsWith(model));
  return m ? { size: m.size, sizeVram: m.size_vram, ctx: m.context_length } : null;
}
function derive(base, name, ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-mf-'));
  const mf = path.join(dir, 'Modelfile');
  fs.writeFileSync(mf, `FROM ${base}\nPARAMETER num_ctx ${ctx}\n`);
  const r = spawnSync('ollama', ['create', name, '-f', mf], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`ollama create ${name} failed: ${r.stderr || r.stdout}`);
}

// --- heavy lock (a lock chunk is short, well under its 30 min stale limit) ------
function lock(action, owner) {
  const args = ['-NoProfile', '-File', LOCK_SCRIPT, action === 'acquire' ? '-Acquire' : '-Release', '-Owner', owner];
  if (action === 'acquire') args.push('-WaitMinutes', '25');
  const r = spawnSync('powershell', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim() };
}

// --- one task run --------------------------------------------------------------
async function runTask(model, task, baseNames) {
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  env.ANTHROPIC_BASE_URL = OLLAMA;
  env.ANTHROPIC_API_KEY = 'probe-not-a-key';
  assertLoopback(env.ANTHROPIC_BASE_URL);
  const args = ['-p', task.prompt, '--model', model, '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write',
    '--allowedTools', 'Read,Grep,Glob', '--setting-sources', 'project', '--disable-slash-commands',
    '--strict-mcp-config', '--max-turns', '12'];
  // shell:true on Windows joins args WITHOUT quoting, so an unquoted prompt arrives as its first word.
  const quoted = args.map(a => (/\s/.test(a) ? '"' + a.replace(/"/g, '') + '"' : a));
  const t0 = Date.now();
  const r = await spawnWithTimeout({ cmd: 'claude', args: quoted, env, cwd: REPO, timeoutMs: TASK_TIMEOUT_MS,
    shell: process.platform === 'win32' });
  const secs = (Date.now() - t0) / 1000;
  const parsed = parseStream(r.stdout);
  const tools = classifyTools(parsed.toolCalls);
  const bad = madeUpPaths(parsed.finalText, { baseNames });
  const mem = await vram(model);
  const usage = parsed.result && parsed.result.usage || {};
  return {
    model, task: task.id, secs: Math.round(secs * 10) / 10, timedOut: !!r.timedOut, exit: r.code,
    success: checkAnswer(task, parsed.finalText), madeUpPaths: bad, tools,
    toolNames: parsed.toolCalls.map(t => t.name),
    costUsd: parsed.result ? parsed.result.total_cost_usd : null,
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, turns: parsed.result && parsed.result.num_turns,
    mem, answer: String(parsed.finalText).slice(0, 400), stderr: r.stderr.trim().slice(0, 200),
  };
}

async function main() {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const models = (arg('--models', '')).split(',').filter(Boolean);
  const runs = Number(arg('--runs', 3));
  const ctx = Number(arg('--ctx', 16384));
  const out = arg('--out', path.join(os.tmpdir(), 'local-agent-tools.json'));
  if (!models.length) throw new Error('--models required');
  const baseNames = repoBaseNames();
  const rows = [];
  const derived = [];
  try {
    for (const base of models) {
      const name = `spike-${base.replace(/[^a-z0-9]+/gi, '-')}-${ctx / 1024}k`;
      derive(base, name, ctx); derived.push(name);
      const jobs = [];
      const only = arg('--only', ''); for (let r = 1; r <= runs; r++) for (const t of TASKS) if (!only || only.split(',').includes(t.id)) jobs.push({ r, t });
      for (let i = 0; i < jobs.length; i += CHUNK) {
        const owner = `spike-local-agent-tools: ${base} tasks ${i + 1}-${Math.min(i + CHUNK, jobs.length)}`;
        // Other lanes hold the lock for long stretches; keep queuing (each try waits 25 min), give up after 8.
        let l = lock('acquire', owner);
        for (let tries = 1; l.code !== 0 && tries < 8; tries++) l = lock('acquire', owner);
        if (l.code !== 0) throw new Error(`heavy lock not acquired: ${l.out}`);
        try {
          for (const { r, t } of jobs.slice(i, i + CHUNK)) {
            const row = await runTask(name, t, baseNames);
            row.model = base; row.run = r; rows.push(row);
            console.log(`${base} r${r} ${t.id}: ${row.success ? 'PASS' : 'FAIL'} ${row.secs}s calls=${row.tools.calls} madeUp=${row.tools.madeUp} rej=${row.tools.rejected} cost=${row.costUsd}`);
            fs.writeFileSync(out, JSON.stringify(rows, null, 1));
          }
        } finally { lock('release', owner); }
      }
      await unload(name);
    }
  } finally {
    for (const n of derived) { await unload(n); spawnSync('ollama', ['rm', n], { encoding: 'utf8' }); }
  }
  console.log(`wrote ${out}`);
}

function selfTest() {
  const assert = require('assert');
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Grep', input: { pattern: 'x' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false, content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'c', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'InputValidationError' }] } }),
    'garbage', JSON.stringify({ type: 'result', result: 'final', total_cost_usd: 0.5 }),
  ].join('\n');
  const p = parseStream(stream);
  assert.strictEqual(p.finalText, 'final');
  const c = classifyTools(p.toolCalls, { exists: () => true });
  assert.deepStrictEqual([c.calls, c.madeUp, c.rejected, c.wellFormed], [3, 1, 1, 1]);
  assert.ok(checkAnswer(TASKS[0], 'it is in host/kill-tree.js'));
  assert.ok(!checkAnswer(TASKS[0], 'host/other.js'));
  assert.ok(checkAnswer(TASKS[7], 'stopped gone has-window unsure changed unproven'));
  assert.ok(!checkAnswer(TASKS[7], 'stopped gone'));
  assert.deepStrictEqual(madeUpPaths('see host/kill-tree.js and host/nope.js', { exists: p => p.endsWith('kill-tree.js') }), ['host/nope.js']);
  assert.throws(() => assertLoopback('https://api.anthropic.com'));
  console.log('self-test ok');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else main().catch((e) => { console.error('probe failed:', e && e.stack); process.exit(1); });
}

module.exports = { TASKS, parseStream, classifyTools, checkAnswer, madeUpPaths, assertLoopback };
