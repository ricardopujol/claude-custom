'use strict';
const { killChildTree } = require('../host/kill-tree');
/* Does a background agent survive /clear, and what does SessionEnd say?

   Dexter F3 (2026-09-25): processes.js ended EVERY open call on SessionEnd. If
   `/clear` fires SessionEnd while a background agent keeps running, that wipes
   calls that are really still running. Unmeasured at the time, so measured
   here rather than guessed: launch a background agent that runs a slow Bash
   command, `/clear` mid-command, and watch which hooks arrive afterwards.

     node verify/probe-clear-background.js

   Reports facts rather than pass/fail on the scenario; it FAILS only when it
   could not observe what it set out to observe. */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..');
const PORT = 7810;
const TOKEN = 'probe-token-' + Date.now();
const NEEDLE = 'clear-probe-' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// A fresh worktree stops at claude's folder-trust dialog; PROBE_CWD points the
// session at an already-trusted folder. The scenario only runs `sleep`.
const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT),
              CLAUDE_CUSTOM_CWD: process.env.PROBE_CWD || REPO,
              CLAUDE_CUSTOM_TOKEN: TOKEN, CLAUDE_CUSTOM_HOOK_DEBUG: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

// Every payload, in arrival order.
const payloads = () => (log.match(/\[hook:full\] .*/g) || [])
  .map(l => { try { return JSON.parse(l.replace('[hook:full] ', '')); } catch { return null; } })
  .filter(Boolean);

// A hard kill of the host does not run its shutdown, which is what kills the
// pty's `claude` -- so kill the whole tree (Miguel, review of this branch).
function killHost() {
  if (process.platform === 'win32') killChildTree(host);
  else host.kill();
}

async function type(ws, text) {
  // The newline goes separately: sent in one chunk, a longer line is treated
  // as a paste and the carriage return is swallowed.
  ws.send(Buffer.from(text, 'utf8'));
  await sleep(1500);
  ws.send(Buffer.from(String.fromCharCode(13), 'utf8'));
}

(async () => {
  await sleep(12000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(TOKEN)}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(2500);

  await type(ws, 'Use the Agent tool with run_in_background set to true, subagent_type general-purpose, ' +
    `and this prompt: "Use the Bash tool to run exactly: sleep 40 && echo ${NEEDLE}  then reply DONE." ` +
    'Then reply LAUNCHED and nothing else.');

  const subBash = () => payloads().find(p => p.hook_event_name === 'PreToolUse' && p.agent_id
    && String(p.tool_input && p.tool_input.command).includes(NEEDLE));
  for (let i = 0; i < 60 && !subBash(); i++) await sleep(2000);
  const started = subBash();
  check('the background agent started its slow Bash call', !!started);
  if (!started) return finish(ws);

  await sleep(4000);                            // let the parent turn end
  const beforeClear = payloads().length;
  // Stamp each event as it arrives: a SubagentStop seconds after /clear means
  // the agent was KILLED; one ~40s later (when the sleep ends) means it lived.
  const clearedAt = Date.now();
  const stamps = [];
  const stamper = setInterval(() => {
    const all = payloads();
    while (beforeClear + stamps.length < all.length) stamps.push(Math.round((Date.now() - clearedAt) / 1000));
  }, 250);
  await type(ws, '/clear');

  // The sleep is 40s; give it plenty of room to finish, and the agent to stop.
  for (let i = 0; i < 45; i++) {
    const after = payloads().slice(beforeClear);
    if (after.some(p => p.hook_event_name === 'SubagentStop' && p.agent_id === started.agent_id)) break;
    await sleep(2000);
  }
  await sleep(2000);
  clearInterval(stamper);

  const after = payloads().slice(beforeClear);
  const end = after.find(p => p.hook_event_name === 'SessionEnd');
  check('/clear fired SessionEnd', !!end, end ? `reason=${end.reason}` : 'none');
  const closed = after.find(p => (p.hook_event_name === 'PostToolUse' || p.hook_event_name === 'PostToolUseFailure')
    && p.tool_use_id === started.tool_use_id);
  const stopped = after.find(p => p.hook_event_name === 'SubagentStop' && p.agent_id === started.agent_id);

  console.log('');
  console.log('FACT  after /clear, the background call ' +
    (closed ? `still CLOSED (${closed.hook_event_name}, session_id ${closed.session_id === started.session_id ? 'unchanged' : 'CHANGED'})`
            : 'never closed'));
  const stopAt = stopped ? stamps[after.indexOf(stopped)] : null;
  console.log('FACT  after /clear, the background agent ' + (stopped
    ? `sent SubagentStop ${stopAt}s after /clear — ${stopAt < 30 ? 'KILLED by /clear (its 40s sleep had not ended)' : 'it SURVIVED /clear'}`
    : 'sent no SubagentStop'));
  console.log('FACT  events after /clear (* = carries agent_id): ' +
    after.map((p, i) => `${p.hook_event_name}${p.agent_id ? '*' : ''}@${stamps[i]}s`).join(' → '));
  finish(ws);
})();

function finish(ws) {
  try { ws.close(); } catch {}
  killHost();
  console.log(failures === 0 ? '\nOBSERVED' : `\n${failures} FAILED to observe`);
  if (failures) console.log('\n--- host log tail ---\n' + log.replace(/\[hook:(full|raw)\] .*\n/g, '').slice(-2500));
  process.exit(failures === 0 ? 0 : 1);
}
