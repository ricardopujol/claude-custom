'use strict';
/* Do a SUBAGENT's Read / Edit / Write calls reach the occupancy hook with an agent_id and a file_path?

   Worktree occupancy (backlog #44 + #47, documentation/DESIGN_WORKTREE_OCCUPANCY.md) is built on one
   assumption nothing in the repo had measured: that a PreToolUse hook for Read|Edit|Write|NotebookEdit fires
   for a subagent's call WITH the same `agent_id` / `agent_type` a subagent's Bash call carries (that one was
   measured by probe-failure-payloads.js), and that the path is in `tool_input.file_path`. Every unit test
   supplies the shape it expects, so this drives the REAL CLI -- `claude -p` on haiku, a throwaway --settings
   -- and then runs the captured events through host/agent-occupancy.js claimFrom.

   Measures:
     1. a subagent's Write, Read and Edit each fire PreToolUse under the occupancy matcher
     2. ...each carrying agent_id, agent_type and an absolute tool_input.file_path
     3. ...and the agent_id is the one its SubagentStop carries (so SubagentStop can delete the claim)
     4. a main-session Read carries no agent_id (it never claims)
     5. claimFrom turns the subagent's calls into a claim on the OTHER folder, and the main call into none
   NOT measured: NotebookEdit's path field (`notebook_path`, from the tool's documented input; asking haiku
   to edit a notebook would only make the run longer).

     node verify/probe-occupancy-payloads.js           # check
     node verify/probe-occupancy-payloads.js --dump    # also print what was seen

   Deletes ELECTRON_RUN_AS_NODE and ANTHROPIC_API_KEY (a probe must never bill a key). Writes only inside two
   temp folders. */
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
const { OCCUPANCY_MATCHER } = require('../host/settings-writer');
const { claimFrom } = require('../host/agent-occupancy');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-occupancy-'));
const own = path.join(base, 'own');          // where the "launching session" runs
const other = path.join(base, 'other');      // the sibling the subagent works in
fs.mkdirSync(own); fs.mkdirSync(other);
fs.writeFileSync(path.join(own, 'main.txt'), 'main file\n');
const logFile = path.join(base, 'hooks.jsonl').replace(/\\/g, '/');
const self = __filename.replace(/\\/g, '/');
const node = process.execPath.replace(/\\/g, '/');

const hook = (matcher, event) => ({
  matcher, hooks: [{ type: 'command', command: `"${node}" "${self}" --log ${event} "${logFile}"`, timeout: 10 }],
});
const settings = { hooks: {
  PreToolUse: [hook(OCCUPANCY_MATCHER, 'PreToolUse')],
  SubagentStop: [hook('', 'SubagentStop')],
} };
const settingsFile = path.join(base, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify(settings));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ANTHROPIC_API_KEY;

const target = path.join(other, 'sub-a.txt');
const prompt =
  'Do exactly these steps and nothing else. ' +
  `1) Use the Read tool to read ${path.join(own, 'main.txt')} ` +
  '2) Use the Agent tool with subagent_type general-purpose and this prompt: ' +
  `"Use the Write tool to create ${target} containing the single word hello. Then use the Read tool to read ${target}. ` +
  `Then use the Edit tool to change hello to bye in ${target}. Then reply DONE." ` +
  '3) Reply FINISHED.';

console.log('running claude -p on haiku (about a minute)...');
const r = spawnSync('claude', ['-p', '--model', 'haiku', '--settings', `"${settingsFile}"`, '--dangerously-skip-permissions'],
  { env, cwd: own, input: prompt, encoding: 'utf8', shell: true, timeout: 300_000 });
if (r.error) { console.log('FAIL  claude did not run:', r.error.message); process.exit(1); }
console.log('claude replied:', (r.stdout || r.stderr || '').trim().slice(0, 160));

const events = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
};

const pre = events.filter(e => e.event === 'PreToolUse');
const subCalls = pre.filter(e => e.payload.agent_id);
const mainCalls = pre.filter(e => !e.payload.agent_id);
const sub = tool => subCalls.find(e => e.payload.tool_name === tool);
const stops = events.filter(e => e.event === 'SubagentStop');

check('hook payloads were captured', events.length > 0, `${events.length} events in ${logFile}`);
for (const tool of ['Write', 'Read', 'Edit']) {
  const e = sub(tool);
  check(`a subagent's ${tool} fires the occupancy PreToolUse`, !!e);
  if (!e) continue;
  const p = e.payload;
  check(`...with an agent_id, an agent_type and an absolute tool_input.file_path`,
    typeof p.agent_id === 'string' && p.agent_id !== '' && typeof p.agent_type === 'string' && p.agent_type !== ''
      && p.tool_input && path.isAbsolute(String(p.tool_input.file_path)),
    JSON.stringify({ agent_id: p.agent_id, agent_type: p.agent_type, file_path: p.tool_input && p.tool_input.file_path }));
}
const ids = new Set(subCalls.map(e => e.payload.agent_id));
check('the subagent calls share ONE agent_id', ids.size === 1, JSON.stringify([...ids]));
check('...and it is the id SubagentStop carries (SubagentStop can delete the claim)',
  ids.size === 1 && stops.some(s => s.payload.agent_id === [...ids][0]), JSON.stringify(stops.map(s => s.payload.agent_id)));
const mainRead = mainCalls.find(e => e.payload.tool_name === 'Read');
check('a main-session Read fires too, and carries no agent_id', !!mainRead && mainRead.payload.agent_id === undefined,
  mainRead ? `agent_id=${mainRead.payload.agent_id}` : 'not seen');

const roots = [own, other];
const claims = subCalls.map(e => claimFrom(e, roots, own));
check('claimFrom turns every subagent call into a claim on the other folder',
  claims.length > 0 && claims.every(c => c && path.resolve(c.worktree).toLowerCase() === path.resolve(other).toLowerCase()),
  JSON.stringify(claims.map(c => c && c.agent)));
check('...and the main session\'s own Read into none', !!mainRead && claimFrom(mainRead, roots, own) === null);

if (DUMP) for (const e of events) console.log(JSON.stringify({ event: e.event, tool: e.payload.tool_name, agent_id: e.payload.agent_id, agent_type: e.payload.agent_type, input: e.payload.tool_input }));
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp */ }
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
