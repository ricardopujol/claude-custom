'use strict';
const { killChildTree } = require('../host/kill-tree');
/* What does a TEAMMATE send, and does its claim survive while it idles?   (re-runnable, real CLI, bills the plan)

   Worktree occupancy (backlog #44 + #47) was measured for a plain subagent (verify/probe-occupancy-payloads.js,
   `claude -p`). A named background agent in an INTERACTIVE session is a different thing: an
   `in_process_teammate`. It ends a turn, idles, and is woken again by SendMessage -- and `claude -p` never
   makes one. The live case that prompted this (personal-agent session 3c8efad6, 2026-10-03): six teammates
   editing sibling worktrees, none of whose tabs showed anything.

   This drives the REAL interactive CLI through a real host of THIS checkout (hook debug on), IN this checkout:
   the teammate works in another worktree of the same repo (the first one git lists that isn't this one), and
   only ever reads there.

     turn 1  the main session launches a named background agent; it Reads, Greps and runs Bash in the other worktree
     turn 2  the main session SendMessages it; it Reads there again

   WHY HERE and not a throwaway repo: an interactive CLI stops at its trust dialog in a folder nobody trusted.
   MEASURED twice -- under %TEMP%, and in a fresh repo nested in this checkout's .harness\ (trust is not
   inherited by a repo of its own) -- and both times the typed prompt answered the dialog and the CLI exited 1.
   This checkout is trusted. If a session is already open in it (the usual case: the one running this probe),
   the host comes up BLOCKED by the one-session lock and the probe takes the product's own *Open anyway*.

   CHECKS (exit 1 if one fails)
     1  the spawn is a teammate (PostToolUse Agent, tool_response.status)
     2  the teammate's Read, Grep and Bash PreToolUse each carry an agent_id and an agent_type; Read an absolute
        tool_input.file_path, Grep an absolute tool_input.path
     3  one agent_id across both turns (a<name>-<hex>), its name as agent_type, and it is the one its
        SubagentStop carries. The session also runs unnamed agents of its own (agent_type "") whose
        SubagentStop arrives in between: the teammate's stops are the ones with ITS id
     4  the claim file <state>\.claude-custom\occupancy\<agent_id>.json names the other worktree and this host's pid
     5  SubagentStop fires at the end of EACH turn (the teammate is idle, not gone)...
     6  ...and the claim is still there while it idles (host/occupancy-producer.js keeps a teammate's claim
        until IDLE_MS without a touch, the session's end, or the host's exit)
     7  the teammate's .meta.json (beside SubagentStop's agent_transcript_path) says taskKind in_process_teammate
     8  killing the host (its own PID) takes the claim with it, or leaves a claim no reader shows

     node verify/probe-teammate-occupancy.js            # check
     node verify/probe-teammate-occupancy.js --dump     # also print every captured payload, trimmed

   WHAT IT LEAVES: one short session in this project's transcripts, and (while it runs) one claim file in the
   project's real occupancy folder, which the host removes when it exits. The registry, portraits and uploads
   are a temp folder. Every CLAUDE_CUSTOM_* not passed on purpose, CLAUDECODE, ELECTRON_RUN_AS_NODE and
   ANTHROPIC_API_KEY are deleted (a probe never bills a key, and a CLI started inside another session's
   environment refuses to start). The only process killed is the host this started, by PID. */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const { projectRoots } = require(path.join(ROOT, 'host', 'project-roots'));
const { rootsFromPorcelain } = require(path.join(ROOT, 'host', 'worktree-roots'));
const DUMP = process.argv.includes('--dump');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-mate-'));      // registry, portraits, uploads only
const here = path.resolve(ROOT);
const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
// the other worktree: the first one git lists that isn't this checkout (in the container layout, dev\)
const other = rootsFromPorcelain(execFileSync('git', ['-C', here, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true }))
  .find(r => !same(r, here) && fs.existsSync(path.join(r, 'package.json'))) || null;
const OCC_DIR = path.join(projectRoots({}, here).stateRoot, '.claude-custom', 'occupancy');
const note = other ? path.join(other, 'package.json') : null;
const posix = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`);
const fwd = p => p.replace(/\\/g, '/');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const noteLine = (label, detail) => console.log(`NOTE  ${label}  -- ${detail}`);

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function waitFor(fn, ms, step = 500) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

const claimFiles = () => { try { return fs.readdirSync(OCC_DIR).filter(f => f.endsWith('.json')).sort(); } catch { return []; } };
const readClaim = (id) => { try { return JSON.parse(fs.readFileSync(path.join(OCC_DIR, `${id}.json`), 'utf8')); } catch { return null; } };

let host = null;
function cleanup() {
  if (host && host.pid) { try { killChildTree(host); } catch { /* gone */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
// A crash outside main()'s own catch must not leave a real CLI running in the checkout (PR #96 Miguel):
// `exit` runs for every way out except a kill, and killPidTree is synchronous.
process.on('exit', cleanup);
process.on('uncaughtException', (err) => { console.log('FAIL  the probe crashed  -- ' + ((err && err.stack) || err)); cleanup(); process.exit(1); });

async function main() {
  check('0: this repo has another worktree to work in', !!other, other || 'git lists only this checkout');
  if (!other) return;

  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, {
    CLAUDE_CUSTOM_PORT: String(port),
    CLAUDE_CUSTOM_CWD: here,
    CLAUDE_CUSTOM_TOKEN: token,
    CLAUDE_CUSTOM_HOOK_DEBUG: '1',
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  });
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });

  host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  host.stdout.on('data', d => { log += d.toString(); });
  host.stderr.on('data', d => { log += d.toString(); });

  const payloads = () => (log.match(/\[hook:full\] .*/g) || [])
    .map(line => { try { return JSON.parse(line.replace('[hook:full] ', '')); } catch { return null; } })
    .filter(Boolean);
  const mateEvents = () => payloads().filter(p => typeof p.agent_id === 'string' && p.agent_id !== '');
  const stops = () => payloads().filter(p => p.hook_event_name === 'SubagentStop');

  const listening = await waitFor(() => /\[host\] listening on/.test(log), 30000);
  check('0: a host of this checkout is up (hook debug on)', !!listening, listening ? `pid ${host.pid} port ${port}` : log.slice(-600));
  if (!listening) return;

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);
  let screen = '';
  // the pty's output is the BINARY frames; the text frames are the host's control messages
  let lock = null;
  ws.on('message', (d, isBinary) => {
    if (isBinary) { screen += d.toString(); if (screen.length > 400000) screen = screen.slice(-200000); return; }
    // one frame can hold several control messages back to back: find the lock's own
    const m = /\{"type":"lock","lock":\{"state":"([a-z]+)"/.exec(d.toString());
    if (m) lock = m[1];
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await waitFor(() => lock !== null && lock !== 'pending', 20000);
  if (lock === 'blocked') {
    // a session is already open in this checkout (the one running this probe, usually): *Open anyway*
    ws.send(JSON.stringify({ type: 'lock-override' }));
    await waitFor(() => lock === 'override' || lock === 'held', 15000);
  }
  noteLine('the one-session lock', String(lock));
  // (the pty's text arrives with cursor moves where the spaces are: compare it squeezed)
  const squeezed = () => screen.replace(/\s+/g, '');
  const ready = await waitFor(() => /youtrust|safetycheck|bypasspermissions|forshortcuts/i.test(squeezed()) || /\[host\] claude exited/.test(log), 60000);
  if (/youtrust|safetycheck/i.test(squeezed())) {
    check('0: the CLI did not stop at its trust dialog', false, `${here} is not a trusted folder`);
    ws.close();
    return;
  }
  check('0: the CLI is up and waiting for a prompt', !!ready && !/\[host\] claude exited/.test(log),
    log.split('\n').filter(l => /claude exited|pty pid/.test(l)).join(' '));
  await sleep(3000);

  const say = async (text) => {
    // The newline goes separately: sent in one chunk, a longer line is treated as a paste and the carriage
    // return is swallowed (verify/probe-payloads.js).
    ws.send(Buffer.from(text, 'utf8'));
    await sleep(1500);
    ws.send(Buffer.from(String.fromCharCode(13), 'utf8'));
  };

  // ---- turn 1 ------------------------------------------------------------------------------------------
  await say('Do exactly this and nothing else. Call the Agent tool once with subagent_type "general-purpose", '
    + 'name "occ-probe", model "haiku", run_in_background true, description "occupancy probe", and this prompt: '
    + `"Step 1: use the Read tool on ${fwd(note)} . Step 2: use the Grep tool with pattern hello and path ${fwd(other)} . `
    + `Step 3: run this Bash command: ls ${posix(other)} . Step 4: reply DONE and stop." Then reply LAUNCHED.`);

  const spawned = await waitFor(() => payloads().find(p => p.hook_event_name === 'PostToolUse'
    && ['Agent', 'Task'].includes(p.tool_name) && p.tool_response), 120000);
  const status = spawned && spawned.tool_response && spawned.tool_response.status;
  check('1: the spawn is a teammate', status === 'teammate_spawned',
    spawned ? JSON.stringify({ status, agent_id: spawned.tool_response.agent_id || spawned.tool_response.agentId, name: spawned.tool_input && spawned.tool_input.name }) : 'no Agent PostToolUse seen');
  if (!spawned) {
    // Nothing to measure: say what the CLI was showing and what the host logged, and stop here.
    // eslint-disable-next-line no-control-regex
    const plain = screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[^\x20-\x7e\n]+/g, ' ');
    console.log('--- the screen (tail) ---\n' + plain.slice(-1800));
    console.log('--- the host log (tail) ---\n' + log.split('\n').filter(l => !l.startsWith('[hook:full]')).slice(-25).join('\n'));
    try { ws.close(); } catch { /* closed */ }
    return;
  }

  // The teammate is whoever makes tool calls under an agent_id. NOT "the first SubagentStop": MEASURED, the
  // session also runs unnamed agents of its own (agent_type "", ids like a4ee54be436dfa873) whose SubagentStop
  // arrives in between.
  const pre = (tool) => mateEvents().find(p => p.hook_event_name === 'PreToolUse' && p.tool_name === tool);
  const idOf = p => (p ? p.agent_id : null);
  await waitFor(() => pre('Read') || pre('Grep') || pre('Bash'), 120000);
  const id0 = idOf(pre('Read')) || idOf(pre('Bash')) || idOf(pre('Grep'));
  const mateStops = () => stops().filter(p => id0 !== null && p.agent_id === id0);
  const firstStop = await waitFor(() => mateStops()[0], 180000);
  const read = pre('Read');
  const grep = pre('Grep');
  const bash = pre('Bash');
  check('2: the teammate\'s Read reaches the hook with an agent_id, an agent_type and an absolute file_path',
    !!read && typeof read.agent_type === 'string' && read.agent_type !== '' && path.isAbsolute(String(read.tool_input && read.tool_input.file_path)),
    read ? JSON.stringify({ agent_id: read.agent_id, agent_type: read.agent_type, file_path: read.tool_input.file_path }) : 'not seen');
  check('2: ...its Grep too, with an absolute tool_input.path',
    !!grep && typeof grep.agent_type === 'string' && path.isAbsolute(String(grep.tool_input && grep.tool_input.path)),
    grep ? JSON.stringify({ agent_id: grep.agent_id, agent_type: grep.agent_type, path: grep.tool_input.path }) : 'not seen');
  check('2: ...and its Bash', !!bash && typeof bash.agent_type === 'string',
    bash ? JSON.stringify({ agent_id: bash.agent_id, agent_type: bash.agent_type, command: String(bash.tool_input && bash.tool_input.command).slice(0, 80) }) : 'not seen');

  const id = id0;
  const claim1 = id ? await waitFor(() => readClaim(id), 10000) : null;
  check('4: the claim file names the other worktree and this host', !!claim1 && same(claim1.worktree, other) && claim1.hostPid === host.pid,
    claim1 ? JSON.stringify({ worktree: claim1.worktree, hostPid: claim1.hostPid, agent: claim1.agent, fromBranch: claim1.fromBranch, count: claim1.count }) : `files: ${JSON.stringify(claimFiles())}`);

  check('5: SubagentStop fires when the teammate ends its first turn', !!firstStop,
    firstStop ? JSON.stringify({ agent_id: firstStop.agent_id, agent_type: firstStop.agent_type, keys: Object.keys(firstStop).join(',') }) : 'no SubagentStop in 3 min');
  check('3: every call of the teammate carries ONE agent_id, and its name as agent_type',
    !!id && new Set(mateEvents().filter(p => p.tool_name).map(p => p.agent_id)).size === 1 && !!read && read.agent_type === 'occ-probe',
    JSON.stringify([...new Set(mateEvents().map(p => `${p.agent_id}/${p.agent_type}`))]));
  noteLine('SubagentStop events so far', stops().map(p => `${p.agent_id}/"${p.agent_type}"`).join(' '));
  await sleep(3000);
  check('6: the claim is still there while the teammate idles', !!id && readClaim(id) !== null, `files: ${JSON.stringify(claimFiles())}`);

  let meta = null;
  if (firstStop && typeof firstStop.agent_transcript_path === 'string') {
    try { meta = JSON.parse(fs.readFileSync(firstStop.agent_transcript_path.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { meta = null; }
  }
  check('7: its .meta.json says in_process_teammate', !!meta && meta.taskKind === 'in_process_teammate',
    meta ? JSON.stringify({ taskKind: meta.taskKind, agentType: meta.agentType, name: meta.name, customAgentType: meta.customAgentType }) : `agent_transcript_path=${firstStop && firstStop.agent_transcript_path}`);

  // ---- turn 2: woken by SendMessage ---------------------------------------------------------------------
  const before = mateEvents().length;
  await say('Do exactly this and nothing else. Call the SendMessage tool with to "occ-probe" and message '
    + `"Use the Read tool on ${fwd(note)} again, then reply DONE2 and stop." Then reply SENT.`);
  const secondStop = await waitFor(() => mateStops()[1], 180000);
  const again = mateEvents().slice(before).find(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read');
  check('3: woken by SendMessage, the teammate works under the SAME agent_id', !!again && again.agent_id === id,
    again ? again.agent_id : 'no second Read seen');
  check('5: ...and SubagentStop fires again at the end of that turn', !!secondStop && secondStop.agent_id === id,
    `the teammate's SubagentStop events: ${mateStops().length} (all agents: ${stops().length})`);
  await sleep(3000);
  const claim2 = id ? readClaim(id) : null;
  // (its count on disk need not have grown: the file's lastAt and count are rewritten at most every 30 s)
  check('6: ...and the claim is still there after the second turn', !!claim2 && same(claim2.worktree, other) && claim2.hostPid === host.pid,
    claim2 ? JSON.stringify({ worktree: claim2.worktree, count: claim2.count }) : `files: ${JSON.stringify(claimFiles())}`);

  // 9 (PR #124 Dexter, host.js's SessionStart handler): the host takes the tab's session id from EVERY SessionStart
  // it sees, with no agent_id guard. Does a teammate's life fire one of its own, and does the teammate's
  // session_id differ from the tab's?
  const starts = payloads().filter(p => p.hook_event_name === 'SessionStart');
  const fromAgent = starts.filter(p => typeof p.agent_id === 'string' && p.agent_id !== '');
  const tabIds = new Set(starts.map(p => p.session_id));
  const mateIds = new Set(mateEvents().map(p => p.session_id));
  noteLine('SessionStart events seen', JSON.stringify(starts.map(p => ({ source: p.source, session_id: p.session_id, agent_id: p.agent_id }))));
  noteLine('session_id on the teammate\'s events', JSON.stringify([...mateIds]));
  check('9: no SessionStart carries an agent_id (a teammate never overwrites the tab\'s session id)', starts.length > 0 && fromAgent.length === 0,
    `${starts.length} SessionStart, ${fromAgent.length} from an agent`);
  check('9: the SessionStart ids are ONE id, and it is the one the teammate\'s calls carry', tabIds.size === 1 && [...mateIds].every(s => tabIds.has(s)),
    `tab ${JSON.stringify([...tabIds])}, teammate ${JSON.stringify([...mateIds])}`);

  noteLine('events from the teammate', mateEvents().map(p => `${p.hook_event_name}${p.tool_name ? ':' + p.tool_name : ''}`).join(' '));
  if (DUMP) for (const p of payloads()) console.log('DUMP  ' + JSON.stringify(p).slice(0, 700));

  // ---- the host goes away ---------------------------------------------------------------------------------
  try { ws.close(); } catch { /* closed */ }
  const pid = host.pid;     // kept for the identity-file checks below, never killed by (PR #130 review r2, Dexter #2B)
  killChildTree(host);
  await sleep(4000);
  const left = id ? readClaim(id) : null;
  check('8: with its host killed the claim is gone, or names a host that is no longer running',
    left === null || left.hostPid === pid, left ? 'file left (a killed host runs no exit handler); readers judge it dead' : 'file removed');
  // The next producer to start in the project would sweep it. This probe wrote into the project's REAL
  // occupancy folder, so it takes its own file back rather than leave it for that.
  if (left && left.hostPid === pid) { try { fs.unlinkSync(path.join(OCC_DIR, `${id}.json`)); } catch { /* gone */ } }
}

main()
  .catch((err) => { check('the probe ran to the end', false, (err && err.stack) || String(err)); })
  .finally(async () => {
    cleanup();
    await sleep(1500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp; a locked file stays for the OS */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
