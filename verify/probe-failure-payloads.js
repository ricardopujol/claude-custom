'use strict';
/* What closes a FAILED tool call, and who owns a subagent's tool calls?

   Found 2026-09-25: the Running panel kept three Bash calls "running" long after
   they ended. All three had exited non-zero. For a failed call Claude Code sends
   PostToolUseFailure, NOT PostToolUse -- and the harness only subscribed to the
   latter, so the close never arrived and the entry sat there until the 30-minute
   sweep.

   This probe measures, against the real CLI, the three facts the fix rests on:
     1. a failing Bash call fires PostToolUseFailure, carrying tool_use_id;
     2. a Bash call made INSIDE a subagent carries an agent_id in its
        PreToolUse payload, and that id equals the one in its SubagentStop;
     3. a main-session tool call carries NO agent_id (so "owned by the main
        session" is the absence of the field).

   It runs `claude -p` headless with a throwaway --settings whose hooks call
   back into this same file (`--log EVENT FILE`), which appends each payload.

     node verify/probe-failure-payloads.js           # check
     node verify/probe-failure-payloads.js --dump    # also print payload keys

   Deletes ELECTRON_RUN_AS_NODE: Claude Code is itself an Electron app, and a
   child spawned from a session would otherwise inherit it. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// --- hook mode: append one payload and exit ---------------------------------
if (process.argv[2] === '--log') {
  const [, , , event, file] = process.argv;
  let body = '';
  process.stdin.on('data', d => { body += d; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = { unparseable: body }; }
    fs.appendFileSync(file, JSON.stringify({ event, payload }) + '\n');
    process.exit(0);
  });
  return;
}

// --- probe mode --------------------------------------------------------------
const DUMP = process.argv.includes('--dump');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-failure-'));
const logFile = path.join(dir, 'hooks.jsonl').replace(/\\/g, '/');
const self = __filename.replace(/\\/g, '/');
const node = process.execPath.replace(/\\/g, '/');

const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'Stop', 'SessionEnd'];
const hook = event => ({
  matcher: '',
  hooks: [{ type: 'command', command: `"${node}" "${self}" --log ${event} "${logFile}"`, timeout: 10 }],
});
const settings = { hooks: Object.fromEntries(EVENTS.map(e => [e, [hook(e)]])) };
const settingsFile = path.join(dir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify(settings));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// `claude -p` prefers an API key in the environment over the subscription
// login, so with one set this probe BILLED the key -- and once its balance ran
// out, failed with "Credit balance is too low". A probe must never spend.
delete env.ANTHROPIC_API_KEY;

const prompt =
  'Do exactly these steps and nothing else. ' +
  '1) Use the Bash tool to run: ls /definitely/not/here/main-probe ' +
  '2) Use the Agent tool with subagent_type general-purpose and this prompt: ' +
  '"Use the Bash tool to run: ls /definitely/not/here/sub-probe  Then use the Bash tool to run: echo sub-ok  Then reply DONE." ' +
  '3) Reply FINISHED.';

console.log('running claude -p (this takes a minute)…');
// The prompt goes on stdin: `claude` is a shim needing shell:true, and a shell
// would split a prompt passed as an argument at its spaces and quotes.
const r = spawnSync('claude', ['-p', '--model', 'haiku', '--settings', `"${settingsFile}"`,
  '--dangerously-skip-permissions'], { env, input: prompt, encoding: 'utf8', shell: true, timeout: 300_000 });
if (r.error) { console.log('FAIL  claude did not run:', r.error.message); process.exit(1); }
console.log('claude replied:', (r.stdout || r.stderr || '').trim().slice(0, 200));

const events = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const bash = (ev, needle) => events.filter(e => e.event === ev && e.payload.tool_name === 'Bash'
  && String(e.payload.tool_input && e.payload.tool_input.command).includes(needle));

const mainPre = bash('PreToolUse', 'main-probe')[0];
const mainFail = bash('PostToolUseFailure', 'main-probe')[0];
const subPre = bash('PreToolUse', 'sub-probe')[0];
const subFail = bash('PostToolUseFailure', 'sub-probe')[0];
const subOk = bash('PostToolUse', 'sub-ok')[0];
const stops = events.filter(e => e.event === 'SubagentStop');

check('hook payloads were captured', events.length > 0, `${events.length} events in ${logFile}`);
check('a failing main-session Bash call fires PostToolUseFailure', !!mainFail);
check('...and NOT PostToolUse', bash('PostToolUse', 'main-probe').length === 0);
check('PostToolUseFailure carries the same tool_use_id as its PreToolUse',
  !!(mainPre && mainFail && mainPre.payload.tool_use_id && mainPre.payload.tool_use_id === mainFail.payload.tool_use_id));
check('a main-session tool call carries no agent_id', !!mainPre && mainPre.payload.agent_id === undefined,
  mainPre ? `agent_id=${mainPre.payload.agent_id}` : 'not seen');
check('a failing subagent Bash call fires PostToolUseFailure', !!subFail);
check('a subagent Bash call carries an agent_id', !!(subPre && subPre.payload.agent_id),
  subPre ? `agent_id=${subPre.payload.agent_id}` : 'not seen');
check('...on its PostToolUse too', !!(subOk && subOk.payload.agent_id));
check('...and it equals the agent_id in that subagent\'s SubagentStop',
  !!(subPre && stops.some(s => s.payload.agent_id === subPre.payload.agent_id)),
  `SubagentStop ids: ${stops.map(s => s.payload.agent_id).join(', ') || 'none'}`);
check('SessionEnd fires when the session ends', events.some(e => e.event === 'SessionEnd'));

if (DUMP) {
  console.log('');
  for (const e of events) {
    const p = e.payload;
    console.log(`${e.event.padEnd(19)} ${String(p.tool_name || '').padEnd(6)} agent_id=${p.agent_id || '-'} ` +
      `keys=${Object.keys(p).join(',')}`);
  }
}

console.log('');
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
// Kept only when something failed, so the raw capture can be inspected
// (Miguel: an unconditional leak is the class bc1e5ac fixed).
if (failures) console.log(`capture kept for inspection: ${dir}`);
else fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
