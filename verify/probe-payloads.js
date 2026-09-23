'use strict';
/* Does Claude Code still send what the host reads?

   THE POINT: every unit test in this repo builds the payload it expects, then
   confirms the host understands it. That is circular, and it hid tool_name
   "Agent" vs "Task" through a green suite, two passing probes and a screenshot.

   This drives the REAL CLI through a real turn -- a Bash call and an agent
   launch -- captures the actual payloads, and checks them against
   host/payload-contract.js. A field renamed upstream fails here.

     node verify/probe-payloads.js            # check against the contract
     node verify/probe-payloads.js --dump     # also print the shapes seen */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const { CONTRACT, checkPayload } = require('../host/payload-contract');

// The host refuses any connection without the session token -- see
// host/gatekeeper.js. A local tool reads it from the file the host writes,
// which is precisely what a web page cannot do.
function sessionToken() {
  try {
    return require('fs').readFileSync(
      require('path').join(__dirname, '..', '.harness', 'session-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const withToken = (url) => url + '?token=' + encodeURIComponent(sessionToken());


const REPO = path.join(__dirname, '..');
const PORT = 7805;
const DUMP = process.argv.includes('--dump');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO,
         CLAUDE_CUSTOM_HOOK_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// The host prints a projection; the full payload is what we need, so it is
// captured from the bridge's own debug line.
const seen = () => (log.match(/\[hook:full\] .*/g) || [])
  .map(line => { try { return JSON.parse(line.replace('[hook:full] ', '')); } catch { return null; } })
  .filter(Boolean);

(async () => {
  await sleep(12000);
  const ws = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(2500);

  // The newline goes separately: sent in one chunk, a longer line is treated as
  // a paste and the carriage return is swallowed.
  ws.send(Buffer.from('Run bash: echo payload-probe, then use the Task tool to launch code-reviewer, prompt: say OK', 'utf8'));
  await sleep(1500);
  ws.send(Buffer.from(String.fromCharCode(13), 'utf8'));

  for (let i = 0; i < 70 && !/\[hook\] SubagentStop/.test(log); i++) await sleep(3000);
  await sleep(2000);

  const payloads = seen();
  check('real payloads were captured', payloads.length > 0, `${payloads.length} events`);

  const byEvent = new Map();
  for (const p of payloads) {
    const name = p.hook_event_name || '(none)';
    if (!byEvent.has(name)) byEvent.set(name, []);
    byEvent.get(name).push(p);
  }

  // Every hooked event must have been seen at least once, or this probe is
  // reporting on a sample that never exercised it.
  // Notification is the exception: it fires only when the session is BLOCKED
  // waiting for you, which cannot happen in the bypass mode the harness runs.
  // Calling that a failure reports on the scenario, not on the contract.
  // PostToolUseFailure needs a FAILING call and SessionEnd a session that ends;
  // this scenario has neither. verify/probe-failure-payloads.js measures both.
  const NOT_EXERCISED_HERE = new Map([
    ['Notification', 'cannot fire in bypass mode — nothing ever asks permission'],
    ['PostToolUseFailure', 'needs a failing call — see verify/probe-failure-payloads.js'],
    ['SessionEnd', 'needs the session to end — see verify/probe-failure-payloads.js'],
  ]);
  for (const event of Object.keys(CONTRACT)) {
    const got = byEvent.get(event) || [];
    if (!got.length && NOT_EXERCISED_HERE.has(event)) {
      console.log(`SKIP  ${event} ${NOT_EXERCISED_HERE.get(event)}`);
      continue;
    }
    check(`${event} was observed`, got.length > 0, got.length ? `${got.length}x` : 'never fired');
  }

  // The actual contract check.
  for (const [event, list] of byEvent) {
    if (!CONTRACT[event]) {
      console.log(`NOTE  ${event} arrives but the host reads nothing from it`);
      continue;
    }
    for (const payload of list) {
      const res = checkPayload(event, payload);
      if (!res.ok) {
        check(`${event} carries every field the host reads`, false,
          `MISSING ${res.missing.join(', ')} — the host reads these and they are not there`);
        break;
      }
    }
    if (list.every(p => checkPayload(event, p).ok)) {
      check(`${event} carries every field the host reads`, true);
    }
  }

  // The specific field whose rename cost three sessions.
  const launches = (byEvent.get('PreToolUse') || []).filter(p => p.tool_input && p.tool_input.subagent_type);
  check('an agent launch was seen, and its tool_name is one the host accepts',
    launches.length > 0 && launches.every(p => CONTRACT.PreToolUse.agentTools.includes(p.tool_name)),
    launches.map(p => `${p.tool_name}/${p.tool_input.subagent_type}`).join(', ') || 'no agent launch observed');

  // FF12 (2026-09-23): effort.level and permission_mode are hooks.md "common
  // input fields" -- MEASURED present on every hooked event, not derived from
  // any fixture. Pinned by NAME here, not folded into the generic "carries
  // every field" check above, so a rename of either shows up as its own line
  // rather than a combined MISSING list someone has to go parse.
  for (const [event, list] of byEvent) {
    if (!CONTRACT[event]) continue;
    check(`${event} carries effort.level on every observed payload`,
      list.every(p => p.effort && typeof p.effort.level === 'string'),
      list.map(p => p.effort && p.effort.level).join(', ') || 'no effort field observed');
    check(`${event} carries permission_mode on every observed payload`,
      list.every(p => typeof p.permission_mode === 'string'),
      list.map(p => p.permission_mode).join(', ') || 'no permission_mode field observed');
  }

  // Fields that arrive and are NOT in the contract. Not failures -- but this is
  // where an upstream addition worth using shows up. agent_type was found this
  // way, and it fixed a real misattribution bug.
  const unread = [];
  for (const [event, list] of byEvent) {
    if (!CONTRACT[event]) continue;
    const read = new Set(Object.keys(CONTRACT[event].fields).map(f => f.split('.')[0]));
    for (const key of Object.keys(list[0])) {
      if (!read.has(key) && !['hook_event_name', 'session_id', 'transcript_path', 'cwd',
                              'scratchpad_dir', 'prompt_id', 'tool_use_id'].includes(key)) {
        unread.push(`${event}.${key}`);
      }
    }
  }
  if (unread.length) { console.log(''); console.log('NOTE  arrives but unread: ' + unread.join(', ')); }

  if (DUMP) {
    console.log('\n--- shapes observed ---');
    for (const [event, list] of byEvent) {
      console.log(`${event}: ${Object.keys(list[0]).join(', ')}`);
      if (list[0].tool_input) console.log(`  tool_input: ${Object.keys(list[0].tool_input).join(', ')}`);
    }
  }

  try { ws.close(); host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
