'use strict';
/* What does the REAL `claude` CLI do with a SendMessage to a background agent,
   depending on WHEN it lands? (PR #69, Dexter F3 and F5.)

     node verify/probe-resume-queued-message.js [--only mid|late|ended]

   Zero spend, zero network: the fake-endpoint technique of
   verify/probe-loadout-hook.js. A local HTTP server speaks just enough of
   `POST /v1/messages` (SSE) and `claude -p` runs with ANTHROPIC_BASE_URL at it
   and a fake key. The server HOLDS replies to line the three timings up
   exactly; every hook event is appended to a jsonl file by a recorder hook.

   The subagent (background, recognised by SUBAGENT-PROMPT-<token> in its first
   user message) makes one tool round (Bash echo) and then ends its turn with
   text. The main agent spawns it, then sends it QUEUED-<token>:
     mid    while the subagent is still WORKING (its first reply is held until
            the SendMessage has run): the message should drain at its tool round.
     late   while the subagent writes its FINAL reply, after its last tool round
            (its final reply is held until the SendMessage has run). Dexter F3:
            is the message dropped, or does it wake the run after SubagentStop?
     ended  after the subagent's SubagentStop (the PR's measured resume case),
            plus a SendMessage to an id nobody has (what does a failed one send?).
   A subagent request whose transcript already holds its final SUB-DONE text is
   a WOKEN run: it gets a Bash echo WOKE-<token>, then ends.

   The main agent's last reply is held until the woken run is done (or 15 s),
   so `-p` doesn't exit under a background run.

   Each scenario's recorded hook stream is then replayed through
   host/mood-machine.js, printing the stack after every event, so the probe
   says directly whether the card shows the woken run and ends clean.
   `--by-name` addresses the run by its spawn name instead of its id;
   `--verbose` prints every request's message blocks. A FAIL exits 1.

   RESULTS, 2026-09-29, this machine (claude-cli 2.1.285):
     mid    PASS. SendMessage's result: { success: true, message: "Message
            queued for delivery to <id> at its next tool round.", pin: { id,
            name, ref } }. The message is in the run's next request, after its
            tool round; one SubagentStop; nothing wakes.
     late   PASS, and Dexter F3 is REAL. Same "queued" result; the run ends
            (SubagentStop) without draining it, then runs AGAIN on the same
            agent_id, and only once the main turn has ended (its Stop fired
            first): PreToolUse/PostToolUse Bash with that agent_id, then a
            second SubagentStop. Before the fix the machine dropped all of it.
     ended  PASS. A send to nobody: { success: false, message: "No agent named
            '<to>' is reachable. ..." }. A send to the ended run: { success:
            true, message: "Resuming agent <to>", resumedAgentId, pin: { id } }.
            The resumed run's calls and SubagentStop carry the old id.
     by name: pin.id and resumedAgentId are the agent_id, not the name; the
            name is in pin.name. So the result names the run for certain.
   ALSO MEASURED, worth knowing:
     - SendMessage fires PostToolUse like any tool (the harness just hadn't
       hooked it), ~100-170 ms after its PreToolUse.
     - A RESUMED run's transcript drops its original prompt block but keeps
       its own tool history.
     - Stop's background_tasks lists a run as "running" 1 ms BEFORE that
       run's SubagentStop arrives: a race, not proof a run came back.
     - SendMessage's input properties: to, summary, message, notify_when_idle. */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { spawnWithTimeout } = require('./lib/spawn-with-timeout');
const { createMoodMachine } = require('../host/mood-machine');

const tempDirs = [];
const removeTempDirs = () => {
  for (const d of tempDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
};
process.on('SIGINT', () => { removeTempDirs(); process.exit(130); });

const slashes = p => String(p).replace(/\\/g, '/');
const AGENT_TYPE = 'general-purpose';
const WAIT_WOKEN_MS = 15_000;

function firstUserTexts(body) {
  const first = (body.messages || []).find(m => m && m.role === 'user');
  if (!first) return [];
  if (typeof first.content === 'string') return [first.content];
  return (first.content || []).filter(c => c && c.type === 'text').map(c => c.text || '');
}

// Every string anywhere in the transcript, for "does it mention X".
function allText(body) {
  return JSON.stringify(body.messages || []);
}

// tool_use_id -> result text, for the tool results in the transcript.
function toolResults(body) {
  const out = new Map();
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c && c.type === 'tool_result') {
        out.set(c.tool_use_id, typeof c.content === 'string' ? c.content
          : (c.content || []).map(x => (x && x.text) || '').join(''));
      }
    }
  }
  return out;
}

const hasResult = (results, prefix) => [...results.keys()].some(k => String(k).startsWith(prefix));
const resultOf = (results, prefix) => { for (const [k, v] of results) if (String(k).startsWith(prefix)) return v; return null; };

function readHookLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function sse(res, rec, content, stop, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_probe_' + rec.n, type: 'message',
    role: 'assistant', model: model || 'probe-model', content: [], stop_reason: null, stop_sequence: null,
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
  rec.reply = content.map(c => (c.type === 'tool_use' ? `tool_use ${c.name}` : 'text')).join('+');
  rec.repliedAt = Date.now();
}

function startServer({ token, mode, hookLog, T0 }) {
  const marker = `SUBAGENT-PROMPT-${token}`;
  const queued = `QUEUED-${token}`;
  const requests = [];
  const byName = process.argv.includes('--by-name');
  const spawnName = `probe-w-${token.slice(0, 4)}`;
  const st = {
    agentId: null, sendMessageSchema: null, toolNames: null,
    subInFinal: false,        // sub's final-reply request has arrived
    sendDone: false,          // a main request carrying the SendMessage result arrived
    subDoneAt: null, wokeDone: false,
    waiters: [],              // [{ test, fire }] held replies
  };
  const poke = () => {
    for (const w of st.waiters.splice(0)) {
      if (w.test()) w.fire(); else st.waiters.push(w);
    }
  };
  const hold = (test, fire, timeoutMs, onTimeout) => {
    if (test()) { fire(); return; }
    let done = false;
    const w = { test, fire: () => { if (!done) { done = true; fire(); } } };
    st.waiters.push(w);
    if (timeoutMs) setTimeout(() => { if (!done) { done = true; (onTimeout || fire)(); } }, timeoutMs);
  };
  // Hook-log driven conditions are polled.
  const poll = setInterval(poke, 100);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* recorded as-is */ }
      if (requests.length > 30) { res.writeHead(500).end('probe request cap'); return; }
      const texts = firstUserTexts(body);
      const results = toolResults(body);
      // The main transcript holds the marker too (as the Agent call's prompt).
      // A RESUMED run's transcript drops the original prompt block (measured,
      // 2.1.285) but keeps its own tool history.
      const transcript0 = allText(body);
      const isSub = !transcript0.includes('toolu_agent_')
        && (transcript0.includes(marker) || transcript0.includes('toolu_subbash_'));
      const rec = { n: requests.length, t: Date.now() - T0, isSub, kind: '?', mentionsQueued: transcript0.includes(queued),
        first: texts.join(' | ').replace(/\s+/g, ' ').slice(0, 160),
        roles: (body.messages || []).map(m => m.role + '[' + (Array.isArray(m.content)
          ? m.content.map(c => c.type + (c.type === 'text' ? ':' + JSON.stringify(String(c.text).slice(-60)) : c.type === 'tool_use' ? ':' + c.name + '/' + c.id
            : c.type === 'tool_result' ? ':' + c.tool_use_id : '')).join(', ') : 'str') + ']').join('\n          ') };
      requests.push(rec);
      const reply = (content, stop = 'end_turn') => sse(res, rec, content, stop, body.model);
      const text = s => [{ type: 'text', text: s }];

      if (!body.tools || !body.tools.length) { rec.kind = 'side'; reply(text('ok')); return; }

      if (isSub) {
        const transcript = allText(body);
        if (hasResult(results, 'toolu_wokebash')) { rec.kind = 'sub:woken-end'; st.wokeDone = true; reply(text(`WOKE-DONE-${token}`)); poke(); return; }
        if (transcript.includes(`SUB-DONE-${token}`)) {
          rec.kind = 'sub:WOKEN';
          reply([{ type: 'tool_use', id: 'toolu_wokebash_' + rec.n, name: 'Bash', input: { command: `echo WOKE-${token}` } }], 'tool_use');
          return;
        }
        if (hasResult(results, 'toolu_subbash')) {
          rec.kind = 'sub:final';
          st.subInFinal = true;
          poke();
          const finalReply = () => { reply(text(`SUB-DONE-${token}`)); st.subDoneAt = Date.now(); poke(); };
          // late: the SendMessage lands while this, the last reply, is being written.
          if (mode === 'late') hold(() => st.sendDone, () => setTimeout(finalReply, 300), 20_000);
          else finalReply();
          return;
        }
        rec.kind = 'sub:first';
        const firstReply = () => reply([{ type: 'tool_use', id: 'toolu_subbash_' + rec.n, name: 'Bash',
          input: { command: `echo SUBTOOL-${token}` } }], 'tool_use');
        // mid: the SendMessage lands while the run is still working.
        if (mode === 'mid') hold(() => st.sendDone, () => setTimeout(firstReply, 300), 20_000);
        else firstReply();
        return;
      }

      // The main agent.
      st.toolNames = st.toolNames || body.tools.map(t => t.name);
      if (!st.sendMessageSchema) {
        const sm = body.tools.find(t => t.name === 'SendMessage');
        st.sendMessageSchema = sm ? Object.keys((sm.input_schema && sm.input_schema.properties) || {}) : null;
      }
      if (hasResult(results, 'toolu_send')) {
        rec.kind = 'main:after-send';
        st.sendDone = true;
        poke();
        // Keep -p alive while a woken run might still come.
        hold(() => st.wokeDone, () => reply(text(`PROBE-DONE-${token}`)), WAIT_WOKEN_MS);
        return;
      }
      if (hasResult(results, 'toolu_agent')) {
        rec.kind = 'main:send';
        const r = resultOf(results, 'toolu_agent') || '';
        const m = /agentId:\s*([A-Za-z0-9_-]+)/.exec(r);
        st.agentId = m ? m[1] : null;
        rec.agentResult = r.slice(0, 200);
        if (!st.agentId || !st.sendMessageSchema) { reply(text('no agent id or no SendMessage tool')); return; }
        const sendTo = to => ({ type: 'tool_use', id: 'toolu_send_' + to.slice(0, 12) + '_' + rec.n, name: 'SendMessage',
          input: { to, message: queued, summary: 'probe message' } });
        // --by-name: address the run by the name it was spawned with.
        const target = byName ? spawnName : st.agentId;
        const fire = () => reply(mode === 'ended'
          ? [sendTo(`nobody-${token}`), sendTo(target)]
          : [sendTo(target)], 'tool_use');
        const stopped = () => readHookLog(hookLog).some(e => e.p.hook_event_name === 'SubagentStop' && e.p.agent_id === st.agentId);
        if (mode === 'mid') fire();
        else if (mode === 'late') hold(() => st.subInFinal, fire, 20_000);
        else hold(() => stopped() && Date.now() - (st.subDoneAt || Infinity) > 1000, fire, 25_000);
        return;
      }
      if (hasResult(results, 'toolu_')) { rec.kind = 'main:other'; reply(text('ok')); return; }
      rec.kind = 'main:spawn';
      reply([{ type: 'tool_use', id: 'toolu_agent_' + rec.n, name: 'Agent', input: {
        subagent_type: AGENT_TYPE, description: 'probe subagent', prompt: marker,
        run_in_background: true, name: spawnName } }], 'tool_use');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', err => reject(new Error(`fake server failed to bind: ${err.message}`)));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, st, stop: () => clearInterval(poll) }));
  });
}

async function runScenario(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resume-probe-'));
  tempDirs.push(tmp);
  const hookLog = path.join(tmp, 'hooks.jsonl');
  const recorder = path.join(tmp, 'record-hook.js');
  fs.writeFileSync(recorder, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let p={};`
    + `try{p=JSON.parse(s)}catch{}require('fs').appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({t:Date.now(),p})+'\\n');});`);
  const cmd = [{ type: 'command', command: `"${slashes(process.execPath)}" "${slashes(recorder)}"`, timeout: 10 }];
  const matcher = 'Agent|Task|Bash|SendMessage';
  const settingsFile = path.join(tmp, 'probe-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher, hooks: cmd }], PostToolUse: [{ matcher, hooks: cmd }],
    PostToolUseFailure: [{ matcher, hooks: cmd }], SubagentStop: [{ hooks: cmd }], Stop: [{ hooks: cmd }],
  } }, null, 2));

  const token = crypto.randomBytes(8).toString('hex');
  const T0 = Date.now();
  const fake = await startServer({ token, mode, hookLog, T0 });
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.port}`;
  env.ANTHROPIC_API_KEY = 'probe-not-a-key';
  const args = ['-p', 'say hi', '--output-format', 'json', '--no-session-persistence', '--settings', settingsFile,
    '--permission-mode', 'bypassPermissions', '--allowedTools', 'Agent,Bash,SendMessage'];
  console.log(`\n=== ${mode}: fake server :${fake.port}, token ${token}`);
  const r = await spawnWithTimeout({ cmd: 'claude', args, env, timeoutMs: 120_000, shell: process.platform === 'win32' });
  fake.stop();
  await new Promise(res => fake.server.close(res));
  const hooks = readHookLog(hookLog);
  return { mode, token, r, requests: fake.requests, st: fake.st, hooks, T0 };
}

function describeHook(e, T0) {
  const p = e.p;
  const bits = [`+${e.t - T0}ms`, p.hook_event_name];
  if (p.tool_name) bits.push(p.tool_name);
  if (p.agent_id) bits.push(`agent_id=${p.agent_id}`);
  if (p.tool_name === 'SendMessage' && p.tool_input) bits.push(`to=${p.tool_input.to}`);
  if (p.tool_name === 'Bash' && p.tool_input) bits.push(`cmd=${JSON.stringify(p.tool_input.command)}`);
  if (p.hook_event_name === 'PostToolUse' && p.tool_name === 'SendMessage') bits.push(`response=${JSON.stringify(p.tool_response).slice(0, 240)}`);
  if (p.hook_event_name === 'PostToolUseFailure') bits.push(`error=${JSON.stringify(p.error || p.tool_response).slice(0, 240)}`);
  if (p.hook_event_name === 'Stop' && p.background_tasks) bits.push(`background_tasks=${JSON.stringify(p.background_tasks).slice(0, 240)}`);
  return bits.join(' ');
}

// The recorded stream through the real machine: what the card would show.
function replay(hooks) {
  let t = 0;
  const m = createMoodMachine({ now: () => t });
  const lines = [];
  const trace = [];
  for (const e of hooks) {
    t = e.t;
    m.handle({ event: e.p.hook_event_name, payload: e.p });
    trace.push({ e, stack: m.stack().slice(), state: m.stateOf(AGENT_TYPE) });
    lines.push(`${(e.p.hook_event_name + ' ' + (e.p.tool_name || '')).padEnd(26)} -> stack=[${m.stack().join(',')}] ${AGENT_TYPE}=${m.stateOf(AGENT_TYPE)}`);
  }
  return { lines, trace };
}

// PASS/FAIL per scenario: what the CLI did, and what the machine made of it.
function claims(s, trace) {
  const out = [];
  const claim = (ok, text) => out.push(`${ok ? 'PASS' : 'FAIL'} (${s.mode}) ${text}`);
  const id = s.st.agentId;
  const stops = s.hooks.filter(e => e.p.hook_event_name === 'SubagentStop' && e.p.agent_id === id);
  const woke = s.requests.some(q => q.kind === 'sub:WOKEN');
  const final = trace.length ? trace[trace.length - 1].stack : [];
  const isWokeEvent = x => x.e.p.agent_id === id && x.e.p.tool_name === 'Bash'
    && String(x.e.p.tool_input && x.e.p.tool_input.command).includes('WOKE-');
  const smPost = s.hooks.filter(e => e.p.hook_event_name === 'PostToolUse' && e.p.tool_name === 'SendMessage');
  const resp = to => (smPost.find(e => e.p.tool_input && String(e.p.tool_input.to).startsWith(to)) || { p: {} }).p.tool_response || {};
  claim(final.length === 0, `the machine ends with nothing open (stack [${final.join(',')}])`);
  if (s.mode === 'mid') {
    claim(s.requests.some(q => q.kind === 'sub:final' && q.mentionsQueued), 'the message drained into the request after the run\'s tool round');
    claim(stops.length === 1 && !woke, `one SubagentStop and no woken run (stops ${stops.length}, woken ${woke})`);
    claim(trace.every(x => x.stack.length <= 1), 'the machine never opened a second run');
  } else {
    claim(woke && stops.length === 2, `the run ran again after its SubagentStop, on the same id (woken ${woke}, stops ${stops.length})`);
    const during = trace.filter(isWokeEvent);
    claim(during.length > 0 && during.every(x => x.stack.includes(AGENT_TYPE) && x.state !== 'sleeping'),
      `the machine shows it working during that run (${during.map(x => x.state).join(', ') || 'no woken events'})`);
  }
  if (s.mode === 'late') {
    const r = resp(id);
    claim(r.success === true && !r.resumedAgentId && r.pin && r.pin.id === id, `a send to a live run is "queued", naming it in pin.id: ${JSON.stringify(r).slice(0, 160)}`);
  }
  if (s.mode === 'ended') {
    const bad = resp('nobody-');
    claim(bad.success === false, `a send to nobody says success:false: ${JSON.stringify(bad).slice(0, 120)}`);
    const r = resp(process.argv.includes('--by-name') ? 'probe-w-' : id);
    claim(r.success === true && r.resumedAgentId === id && r.pin && r.pin.id === id,
      `a send to the ended run RESUMES it, naming it in resumedAgentId and pin.id: ${JSON.stringify(r).slice(0, 160)}`);
  }
  return out;
}

function report(s) {
  const out = [];
  const id = s.st.agentId;
  const stops = s.hooks.filter(e => e.p.hook_event_name === 'SubagentStop' && e.p.agent_id === id);
  const woken = s.requests.filter(q => q.kind === 'sub:WOKEN');
  const wokeCall = s.hooks.find(e => e.p.hook_event_name === 'PostToolUse' && e.p.tool_name === 'Bash'
    && String(e.p.tool_input && e.p.tool_input.command).includes('WOKE-'));
  const subQueued = s.requests.filter(q => q.isSub && q.mentionsQueued).map(q => q.kind);
  const mainQueued = s.requests.filter(q => !q.isSub && q.kind !== 'side' && q.mentionsQueued).map(q => q.kind);
  out.push(`exit=${s.r.code} timedOut=${s.r.timedOut} agentId=${id}`);
  out.push(`sub requests that mention QUEUED: [${subQueued.join(', ')}]; main requests that mention it: [${mainQueued.join(', ')}]`);
  out.push(`woken sub requests: ${woken.length}; SubagentStop for ${id}: ${stops.length} (at ${stops.map(e => '+' + (e.t - s.T0)).join(', ')} ms)`);
  if (wokeCall) {
    out.push(`woken run's Bash PostToolUse: agent_id=${wokeCall.p.agent_id} (same id: ${wokeCall.p.agent_id === id}), at +${wokeCall.t - s.T0} ms;`
      + ` after the FIRST SubagentStop: ${stops.length ? wokeCall.t > stops[0].t : 'n/a'}`);
  }
  return out;
}

async function main() {
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const cliVersion = (v.stdout || v.stderr || '').trim();
  console.log(`claude --version: ${cliVersion || 'UNKNOWN'}`);
  if (!cliVersion || v.status !== 0) { console.log('SKIP: the claude CLI could not be spawned'); return 0; }

  const oi = process.argv.indexOf('--only');
  const modes = oi > -1 ? [process.argv[oi + 1]] : ['mid', 'late', 'ended'];
  const results = [];
  for (const mode of modes) results.push(await runScenario(mode));

  const verdicts = [];
  for (const s of results) {
    console.log(`\n############ ${s.mode} ############`);
    if (!s.st.sendMessageSchema) {
      console.log(`SKIP: no SendMessage tool offered to the main agent. Tools: ${(s.st.toolNames || []).join(', ')}`);
      continue;
    }
    console.log(`SendMessage input properties: ${s.st.sendMessageSchema.join(', ')}`);
    console.log('-- requests:');
    s.requests.forEach(q => console.log(`   #${q.n} +${q.t}ms ${q.kind} reply=${q.reply || '(none)'}${q.mentionsQueued ? ' [mentions QUEUED]' : ''}`
      + (process.argv.includes('--verbose') ? `\n        roles=${q.roles}\n        first=${JSON.stringify(q.first)}` : '')));
    console.log('-- hooks:');
    s.hooks.forEach(e => console.log('   ' + describeHook(e, s.T0)));
    console.log('-- replay through host/mood-machine.js:');
    const { lines, trace } = replay(s.hooks);
    lines.forEach(l => console.log('   ' + l));
    console.log('-- summary:');
    report(s).forEach(l => console.log('   ' + l));
    verdicts.push(...claims(s, trace));
  }
  console.log('\n=== RESULTS ===');
  verdicts.forEach(l => console.log(l));
  return verdicts.some(l => l.startsWith('FAIL')) ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => { removeTempDirs(); process.exit(code || 0); })
    .catch((err) => { console.error('probe failed:', err && err.stack); removeTempDirs(); process.exit(1); });
}

module.exports = { firstUserTexts, toolResults };
