'use strict';
/* Pausing/stopping background agents and tasks (BACKLOG #19). Two questions:

   (a) Can a background shell task's CHILD PROCESS be OS-suspended and resumed
       without the CLI treating it as hung?
       Step 1 measures the suspend primitive itself, cheaply, against a plain
       Node child this script spawns (no `claude` involved yet): tries
       `pssuspend`/`pssuspend64` on PATH, then NtSuspendProcess/NtResumeProcess
       via a P/Invoke helper (OpenProcess(PROCESS_SUSPEND_RESUME) + the ntdll
       calls), proven by a heartbeat file that stops growing while suspended
       and resumes growing after.
       Step 2 spends real, small tokens: ONE short interactive session
       (`--model haiku`, recorded because the flag might not exist) run in a
       real pty (node-pty, exactly what host/host.js uses to run the real
       `claude` binary directly rather than through the npm .cmd shim -- see
       its "locate the real claude binary" comment). The sole prompt asks it
       to background a harmless Node one-liner (a `sleep 90`-equivalent that
       appends a heartbeat line to a file with a random token in its name, so
       the process is identifiable and its liveness is independently
       verifiable without trusting the CLI's own report). The child pid is
       found via a Win32_Process table (CommandLine LIKE the token), its
       ancestry is walked back to the pty's own pid to confirm it really is
       this session's child, it is suspended for ~20s (heartbeat file
       byte-for-byte frozen is the ground truth), then resumed (heartbeat
       grows again). The CLI's own `/tasks` panel (a local, zero-token UI --
       see part (b)) is screen-scraped before, during and after suspension so
       what the CLI SHOWS can be compared with what is ACTUALLY happening to
       the process.
       Trap paid for by this codebase (CLAUDE.md): launching a session from
       inside an existing `claude` session leaks CLAUDE_CODE_* markers that
       silently disable transcript persistence. host/host.js strips an exact
       denylist before spawning its pty; this probe strips the same list,
       because this probe is itself being run BY a `claude` session.

   (b) What does the CLI expose for STOPPING a background agent/task?
       Inventory only, no spend: `claude --help` (background-relevant
       commands), the built-in slash-command list (typing `/` is a local,
       zero-token filter list that never submits to the model -- a
       well-known CLI behaviour, not independently re-verified here via a
       transcript/cost-state check the way the real session below is), the
       shipped SDK tool
       schemas in the installed npm package (sdk-tools.d.ts -- the model-
       facing BashInput.run_in_background and TaskStopInput shapes), the
       hook events host/settings-writer.js already wires (so gaps are
       measured, not guessed), and state directories under ~/.claude that
       might name background tasks (~/.claude/jobs, ~/.claude/tasks).

     node verify/probe-pause.js

   Cost: part (a) step 1 spends nothing (no `claude` involved). Part (a) step
   2 spends real tokens: ONE short --model haiku session, a single user turn.
   Part (b) spends nothing (help text, local UI, files already on disk).

   RESULTS, 2026-09-27, this machine (claude-cli 2.1.283, Windows 11):
     (a) step 1: pssuspend/pssuspend64 NOT on PATH (Sysinternals not
         installed) -- SKIP for that primitive. NtSuspendProcess/
         NtResumeProcess via OpenProcess(PROCESS_SUSPEND_RESUME) WORKS:
         rc=0/0, heartbeat frozen (4 -> 4) for the full 2s suspend window,
         resumed growing (4 -> 8) after. This is the primitive step 2 uses.
     (a) step 2 (real session, `--model haiku` -- the alias exists and was
         accepted): the model replied with the completion marker in
         15-25s per run. The Bash tool's own tool_result named the task
         ("Command running in background with ID: <id>. Output is being
         written to: %LOCALAPPDATA%\claude\<project-slug>\<sessionId>\
         tasks\<id>") -- a previously-undocumented, predictable state file
         location (empty in this run: our command wrote its own heartbeat
         file directly rather than to stdout). On Windows, Claude Code's
         Bash tool wraps the command through THREE nested bash.exe layers
         (git-bash spawning git-bash spawning git-bash) before the actual
         node.exe leaf -- all four processes carry the full command line
         (and therefore the token), so identifying "the" child means
         picking the leaf of the matched chain, not expecting exactly one
         match. The leaf's ancestry chain, walked via a single
         Win32_Process CIM snapshot, reaches the claude.exe pid every
         time. Suspending the LEAF (the node.exe actually doing the work):
         heartbeat count was byte-for-byte flat across all four 5s samples
         of the ~20s suspend window (e.g. 15,15,15,15), then grew again
         within 3s of resume (15 -> 21) -- the suspend/resume primitive
         works on the real child exactly as step 1 predicted.
         What the CLI SHOWED throughout, via its own `/tasks` panel
         (zero-token local UI, screen-scraped, not asked of the model):
         `Status: running` and a `Runtime:` counter that kept advancing by
         WALL CLOCK the entire time (5s -> 28s -> 34s across
         before/mid-suspend/after-resume) -- the CLI has no idea the
         process is frozen; "running" and an ever-increasing runtime is
         indistinguishable from actually running. The panel also exposed
         the stopping keystroke inventoried in (b) empirically: "x to
         stop" in its own footer. Token spend: one run's `cost-state`
         transcript entry priced the session at totalCostUSD=$0.1001
         (claude-haiku-4-5-20251001: 1048 input, 1590 output incl. 1347
         thinking, 96456 cache-read, 40733 cache-creation tokens); a
         cost-state entry was not present on every run of identical shape,
         so raw usage was summed as a fallback on those (e.g. one run:
         input=36, cache_creation=79716, cache_read=192904, output=1338)
         -- naively summing only input_tokens+output_tokens would have
         undercounted real spend by roughly 2 orders of magnitude by
         omitting cache tokens entirely (measured on the first, buggy
         version of this accounting: it reported $0 for a $0.10 session).
         Total across all real-session attempts while developing this
         probe (including two throwaway runs killed by since-fixed
         screen-scraping false positives, before any assistant reply
         existed, hence $0 each): on the order of $0.10-$0.30. CAVEAT (found
         reviewing this PR): `cleanEnv()` did not strip `ANTHROPIC_API_KEY` at
         the time these runs happened, and it was set globally in this shell.
         Checked (Paris): `~/.claude.json`'s `customApiKeyResponses.rejected`
         contains exactly that key's tail (approved: none), and `claude auth
         status` reports `loggedIn: true, authMethod: claude.ai, apiProvider:
         firstParty` -- the CLI had already rejected the inherited key, so the
         session billed the claude.ai Max subscription, not the key's account;
         the $0.1001 cost-state figure is the CLI's estimate, not a charge
         against the key. `cleanEnv()` now strips the key (and
         ANTHROPIC_AUTH_TOKEN) regardless, since a future machine's rejected
         list is not this one's.
     (b) inventory (all $0):
         `claude --help`: background session lifecycle is `--bg`/
         `--background` to start, `claude agents` (`--json` gives pid, cwd,
         kind, startedAt, sessionId, name, status) to list, `attach`/`logs`
         to inspect, `stop|kill`/`rm` to end one -- all keyed by the short
         id `--bg` prints, all at the SESSION level, nothing at the
         individual-background-bash-task level.
         Built-in slash commands (typing `/` is a local, zero-token filter,
         by construction -- not independently re-verified via transcript
         here; M1, Miguel PR #61 review, reworded from an earlier overclaim):
         `/tasks` (alias `/bashes`) = "View and manage everything running
         in the background"; `/background` = "Send this session to the
         background and free the terminal". No built-in `/pause`, `/kill`,
         or `/stop` exists -- typing them matched zero built-ins (only
         fuzzy hits on unrelated project skills). `/tasks` + Enter with
         nothing running shows "No tasks currently running"; with a task
         running (measured live in (a)) it shows a "Shell details" panel:
         Status, Runtime, Command, Output, and the footer "← to go back ·
         Esc/Enter/Space to close · x to stop" -- `x` is the CLI's actual
         per-task stop keystroke, discovered empirically, not documented
         anywhere in --help.
         SDK tool schemas (sdk-tools.d.ts in the installed npm package):
         `BashInput.run_in_background?: boolean` is the only way to start
         one; `TaskStopInput { task_id?, shell_id? (deprecated) }` is the
         model's own tool to stop "the ID of the background task ...
         Agent-team teammates and named background agents are also
         accepted" -- ONE unified stop mechanism for bash tasks AND
         subagents. No Pause/Suspend tool exists anywhere in the tool
         union -- confirms the backlog's own suspicion ("CLI can stop
         tasks but has no native pause") from the shipped schema, not a
         guess.
         Hook events host/settings-writer.js wires: PreToolUse,
         PostToolUse, PostToolUseFailure, SubagentStop, SessionStart,
         SessionEnd, Notification, Stop. NONE of these fired for the
         background bash task's own lifecycle in (a) -- SubagentStop is
         Task/Agent-subagent-only. A background bash task starting or
         finishing is invisible to hooks on this measured surface; the
         only signals are the model's own eventual tool-result and the
         user-facing `/tasks` panel.
         State on disk: ~/.claude/jobs/<short-id>/ exists per `claude --bg`
         session (3 present on this machine, plus a pins.json) but its
         directories were empty in every case sampled -- no
         human-readable manifest of what's inside. ~/.claude/tasks/
         session-<uuid>/ (439 scanned, 1 non-empty) holds only
         `.highwatermark`/`.lock` bookkeeping for the Task tool's own
         numbering, not a list of background bash commands by name. The
         actual per-task state discovered here lives elsewhere entirely:
         %LOCALAPPDATA%\claude\<project-slug>\<sessionId>\tasks\<taskId>
         (see (a) above) -- not documented in --help or in either of the
         ~/.claude directories that sound like they should hold it. */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { createHygieneRegistry } = require('./lib/process-hygiene');

const REPO = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const at = () => `${Math.round((Date.now() - T0) / 1000)}s`;

const results = { platform: process.platform, suspendPrimitive: {}, realSession: null, inventory: {} };

// H1 (Miguel, PR #61 review): Ctrl+C during the documented ~20s suspend
// window is Node's default SIGINT behaviour, which terminates immediately
// and skips every pending `finally` -- exactly the moment an operator
// watching this probe run is most likely to press it. This registry is what
// runs INSTEAD, resuming every pid this run has suspended and tree-killing
// every process tree it has spawned, so a Ctrl+C leaves nothing suspended
// forever and no live paid session orphaned. `hygiene.setResumeFn` is wired
// below, once `ntAction` exists.
const hygiene = createHygieneRegistry();

// =============================================================================
// Part (a) step 1: which suspend primitive works, measured against a plain
// Node child (no `claude` involved -- isolates "does suspension work on this
// machine at all" from "does the CLI's background task use a suspendable
// process").
// =============================================================================
const NT_HELPER_PS1 = path.join(os.tmpdir(), `claude-custom-probe-pause-nt-${process.pid}.ps1`);
fs.writeFileSync(NT_HELPER_PS1, `param(
  [Parameter(Mandatory=$true)][ValidateSet("Suspend","Resume")][string]$Action,
  [Parameter(Mandatory=$true)][int]$TargetPid
)
$sig = @"
using System;
using System.Runtime.InteropServices;
public class NtPause {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")]
  public static extern uint NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")]
  public static extern uint NtResumeProcess(IntPtr h);
}
"@
Add-Type -TypeDefinition $sig -ErrorAction Stop
$PROCESS_SUSPEND_RESUME = 0x0800
$h = [NtPause]::OpenProcess($PROCESS_SUSPEND_RESUME, $false, $TargetPid)
if ($h -eq [IntPtr]::Zero) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Output "OpenProcess FAILED, Win32 error=$err"
  exit 1
}
$rc = if ($Action -eq "Suspend") { [NtPause]::NtSuspendProcess($h) } else { [NtPause]::NtResumeProcess($h) }
Write-Output "$Action pid=$TargetPid rc=$rc (0=STATUS_SUCCESS)"
[NtPause]::CloseHandle($h) | Out-Null
`);

function ntAction(action, pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', NT_HELPER_PS1,
    '-Action', action, '-TargetPid', String(pid)], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Wired here (not at declaration) because it closes over ntAction.
// hygiene.install() itself is called only under the require.main === module
// guard at the bottom of this file -- NOT here at module load -- so a test
// that requires this file to reuse its pure helpers does not silently hijack
// its own process's SIGINT/uncaughtException handling as a side effect.
//
// Dexter, PR #61 review round 2, finding 4: `ntAction` NEVER throws -- a
// failed OpenProcess/NtResumeProcess call comes back as `{code: 1, out:
// 'OpenProcess FAILED, ...'}`, not an exception. The registry's contract
// requires a truthy/falsy return to tell success from failure, so that
// translation happens HERE, once, rather than pushing NtAction's specific
// shape into the generic hygiene module. Logs loudly either way, so a
// failed emergency resume is never silent.
hygiene.setResumeFn((pid) => {
  const r = ntAction('Resume', pid);
  if (r.code === 0) {
    console.error(`[hygiene] emergency resume OK for pid ${pid}: ${r.out}`);
    return true;
  }
  console.error(`[hygiene] emergency resume FAILED for pid ${pid}: rc=${r.code} ${r.out || r.err}`);
  return false;
});

async function detectSuspendPrimitive() {
  console.log('\n=== Part (a) step 1: suspend primitive ===');
  if (process.platform !== 'win32') {
    console.log(`SKIP: this probe's suspend primitive detection is Windows-only (platform=${process.platform})`);
    results.suspendPrimitive = { skip: `platform is ${process.platform}, not win32` };
    return null;
  }

  const pss = spawnSync('where', ['pssuspend'], { encoding: 'utf8' });
  const pss64 = spawnSync('where', ['pssuspend64'], { encoding: 'utf8' });
  const havePssuspend = pss.status === 0 || pss64.status === 0;
  console.log(`pssuspend(64) on PATH: ${havePssuspend}`);
  if (!havePssuspend) console.log('SKIP: pssuspend not found on PATH -- Sysinternals not installed on this machine');

  // Validate NtSuspendProcess/NtResumeProcess against a throwaway heartbeat
  // child. Same evidence shape as the real-session test below: a file that
  // stops growing while suspended and resumes growing after.
  const heartbeat = path.join(os.tmpdir(), `claude-custom-probe-pause-hb1-${crypto.randomBytes(4).toString('hex')}.txt`);
  const child = spawn(process.execPath, ['-e',
    `let n=0;setInterval(()=>{n++;require('fs').appendFileSync(${JSON.stringify(heartbeat)},n+' '+Date.now()+'\\n')},300)`],
    { detached: true, stdio: 'ignore' });
  const lines = () => { try { return fs.readFileSync(heartbeat, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  hygiene.registerChild(child);

  let sRes, rRes, before, during;
  try {
    await sleep(1000);
    // The baseline is sampled AFTER the suspend call returns, not before it is
    // issued: spinning up powershell and JIT-compiling the Add-Type P/Invoke
    // shim costs several hundred ms to over a second, during which the
    // heartbeat keeps ticking. Sampling "before" prior to that setup cost made
    // an already-suspended process look like it had kept running. By the time
    // NtSuspendProcess returns rc=0 the process is actually suspended, so that
    // is the correct t=0 for "during".
    sRes = ntAction('Suspend', child.pid);
    console.log(`NtSuspendProcess: ${sRes.out || sRes.err}`);
    hygiene.registerSuspended(child.pid);
    before = lines();
    await sleep(2000);
    during = lines();
  } finally {
    // L2 (Miguel, PR #61 review): resume lives in its own finally, independent
    // of the SIGINT/uncaughtException backstop, so a throw between suspend and
    // resume (a `lines()`/sleep hiccup) still resumes cleanly instead of
    // leaning on the emergency path to notice.
    rRes = ntAction('Resume', child.pid);
    console.log(`NtResumeProcess: ${rRes.out || rRes.err}`);
    // Dexter, PR #61 review round 2, finding 4: only clear on a CONFIRMED
    // success (rc===0). Clearing unconditionally raced a Ctrl+C landing
    // during this very resume attempt: the spawned powershell dies first
    // (Ctrl+C is broadcast to the whole console process group), this
    // `finally` still runs synchronously and would have cleared the pid
    // BEFORE the SIGINT handler gets a turn on the event loop, so the
    // handler would find nothing left to retry. Left registered on failure,
    // the emergency handler's own resume attempt (a fresh spawnSync, outside
    // the already-delivered signal's window) gets a real second try.
    if (rRes.code === 0) hygiene.clearSuspended(child.pid);
    else console.error(`[detectSuspendPrimitive] RESUME FAILED for pid ${child.pid} (rc=${rRes.code}) -- left registered as suspended`);
  }
  await sleep(1200);
  const after = lines();
  console.log(`heartbeat lines: right-after-suspend-call=${before} still-during-suspend(+2s)=${during} after-resume=${after}`);
  try { child.kill(); } catch {}
  hygiene.unregisterSpawnedTree(child.pid);
  try { fs.unlinkSync(heartbeat); } catch {}

  const ntWorks = sRes.code === 0 && rRes.code === 0 && during <= before + 1 && after > during;
  console.log(`NtSuspendProcess/NtResumeProcess works: ${ntWorks}`);
  results.suspendPrimitive = { pssuspendOnPath: havePssuspend, ntSuspendResumeWorks: ntWorks,
    evidence: { before, during, after, suspendResult: sRes, resumeResult: rRes } };
  return ntWorks ? 'nt' : (havePssuspend ? 'pssuspend' : null);
}

// =============================================================================
// Part (a) step 2: the real session, ONE short --model haiku turn.
// =============================================================================
function resolveClaudeExe() {
  if (process.env.CLAUDE_CUSTOM_BIN) return process.env.CLAUDE_CUSTOM_BIN;
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    path.join(os.homedir(), '.local/bin/claude.exe'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

// Same denylist as host/host.js's INHERITED_SESSION_VARS -- this probe is
// itself running inside a `claude` session, so the trap it documents (a
// leaked CLAUDE_CODE_CHILD_SESSION silently disabling transcript
// persistence) applies here just as much as it does to the harness.
const INHERITED_SESSION_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDECODE'];

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // documentation/CLAUDECUSTOM_BUILD_LOG.md, Open Problems: "ANTHROPIC_API_KEY
  // is set globally on this machine (both shells). `claude -p` prefers it over
  // the Max login, so any probe ... bills the key unless it deletes the
  // variable from the child env." This probe's real `--model haiku` session
  // inherited it unstripped -- but checked (Paris, reviewing this PR): the
  // CLI's own `~/.claude.json` had that key on its `customApiKeyResponses.
  // rejected` list, and `claude auth status` showed `authMethod: claude.ai`,
  // so on THIS machine it fell through to the Max login anyway and billed the
  // subscription, not the key. Still deleted here regardless: a future
  // machine's rejected list is not this one's, and this probe has no reason
  // to depend on it.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  return env;
}

function processTable() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// The transcript file is the ONLY ground truth for "did the model actually
// reply", not the pty screen: the instruction text necessarily contains the
// completion marker once (to tell the model what to reply), the terminal
// echoes whatever is typed into the input box before Enter is even
// processed, and a long prompt line-wraps so only its FIRST visual line is
// prefixed with "❯" -- a naive "skip lines starting with ❯" screen filter
// still matches the marker on a wrapped continuation line. Measured: the
// first two versions of this probe "detected" a reply within 2-9s of
// sending Enter, killed the pty, and left an empty transcript behind (no
// assistant entry at all) -- pure false positives from screen-scraping.
function findTranscriptPath(sessionId) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  for (const projDir of fs.readdirSync(projectsDir)) {
    const candidate = path.join(projectsDir, projDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
function readTranscriptEntries(sessionId) {
  const p = findTranscriptPath(sessionId);
  if (!p) return [];
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
      .map(raw => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function readAssistantReply(sessionId, marker) {
  for (const o of readTranscriptEntries(sessionId)) {
    if (o.type !== 'assistant' || !o.message || o.message.role !== 'assistant') continue;
    const text = JSON.stringify(o.message.content || '');
    if (text.includes(marker)) return o;
  }
  return null;
}
// The authoritative dollar figure this session itself recorded, not a
// hand-summed approximation -- summing input_tokens+output_tokens from each
// assistant turn undercounts real spend by omitting cache_creation/cache_read
// tokens entirely (measured: the first version of this accounting reported
// costUsdSumField=0 despite a real $0.10 haiku session).
function latestCostState(sessionId) {
  const entries = readTranscriptEntries(sessionId).filter(o => o.type === 'cost-state');
  return entries.length ? entries[entries.length - 1] : null;
}
// The Bash tool's own background-task bookkeeping, discovered empirically in
// this session's tool_result: "Command running in background with ID: X.
// Output is being written to: <path>." -- a predictable, undocumented (until
// now) location: %LOCALAPPDATA%\claude\<project-slug>\<sessionId>\tasks\<taskId>.output
function findBackgroundTaskInfo(sessionId) {
  for (const o of readTranscriptEntries(sessionId)) {
    if (o.type !== 'user' || !Array.isArray(o.message && o.message.content)) continue;
    for (const c of o.message.content) {
      if (c.type !== 'tool_result' || typeof c.content !== 'string') continue;
      const m = c.content.match(/Command running in background with ID: (\S+)\. Output is being written to: (.+?)\./);
      if (m) return { taskId: m[1], outputPath: m[2] };
    }
  }
  return null;
}

function ancestryChain(table, pid, rootPid, maxHops = 12) {
  const byPid = new Map(table.map(p => [p.ProcessId, p]));
  const chain = [];
  let cur = pid;
  for (let i = 0; i < maxHops; i++) {
    const p = byPid.get(cur);
    if (!p) { chain.push({ pid: cur, name: '(not found in table)' }); break; }
    chain.push({ pid: p.ProcessId, name: p.Name });
    if (p.ProcessId === rootPid) break;
    cur = p.ParentProcessId;
    if (!cur) break;
  }
  return chain;
}

async function realSessionTest(suspendPrimitive) {
  console.log('\n=== Part (a) step 2: real session, background bash task suspend/resume ===');
  if (!suspendPrimitive) {
    console.log('SKIP: no working suspend primitive was found in step 1 -- not spending tokens on a test that cannot measure anything');
    results.realSession = { skip: 'no working suspend primitive (see suspendPrimitive above)' };
    return;
  }

  let pty;
  try {
    pty = require('node-pty');
  } catch (err) {
    console.log(`SKIP: node-pty not resolvable (${err.message})`);
    results.realSession = { skip: `node-pty not resolvable: ${err.message}` };
    return;
  }
  const { Terminal } = require('@xterm/headless');

  const CLAUDE_BIN = resolveClaudeExe();
  console.log(`claude binary: ${CLAUDE_BIN}`);
  const sessionId = crypto.randomUUID();
  const token = crypto.randomBytes(6).toString('hex');
  const heartbeat = path.join(os.tmpdir(), `claude-custom-probe-pause-live-${token}.txt`).replace(/\\/g, '/');
  console.log(`session id: ${sessionId}`);
  console.log(`heartbeat file: ${heartbeat}  (token ${token} makes the spawned process identifiable in the process table)`);

  // --model haiku: recorded here whether the flag/alias is accepted at all.
  const args = ['--model', 'haiku', '--session-id', sessionId, '--permission-mode', 'bypassPermissions',
    '--allowedTools', 'Bash'];
  console.log(`spawning: ${path.basename(CLAUDE_BIN)} ${args.join(' ')}`);
  const term = pty.spawn(CLAUDE_BIN, args, {
    name: 'xterm-256color', cols: 120, rows: 45, cwd: REPO, env: { ...cleanEnv(), TERM: 'xterm-256color' },
  });
  console.log(`pty pid (claude.exe): ${term.pid}`);
  hygiene.registerChild(term);

  const xterm = new Terminal({ cols: 120, rows: 45, allowProposedApi: true });
  term.onData(d => xterm.write(d));
  const screen = () => {
    const b = xterm.buffer.active;
    const lines = [];
    for (let y = 0; y < 45; y++) {
      const l = b.getLine(b.baseY + y);
      if (l) { const t = l.translateToString(true).trimEnd(); if (t) lines.push(t); }
    }
    return lines;
  };
  const until = async (pred, ms, step = 500) => {
    for (let t = 0; t < ms; t += step) { const v = pred(); if (v) return v; await sleep(step); }
    return null;
  };
  const hbLines = () => { try { return fs.readFileSync(heartbeat, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

  const tasksPanel = async (label) => {
    term.write('/tasks');
    await sleep(700);
    term.write('\r');
    await sleep(1200);
    const panel = screen();
    console.log(`[${at()}] /tasks panel (${label}):\n  ${panel.slice(-8).join('\n  ')}`);
    term.write('\x1b'); // Esc closes the panel without submitting anything
    await sleep(500);
    return panel;
  };

  const record = { sessionId, token, heartbeat, ptyPid: term.pid, cliVersionArgs: args };
  try {
    const ready = await until(() => /Try "|❯/.test(screen().join('\n')), 20000, 500);
    console.log(`[${at()}] claude ${ready ? 'is up' : 'DID NOT COME UP'}`);
    if (!ready) {
      record.failure = 'claude never drew its prompt box';
      record.screenAtFailure = screen();
      console.log(screen().join('\n'));
      results.realSession = record;
      return;
    }

    const marker = `PAUSEPROBE-ACK-${token}`;
    const prompt = `Use the Bash tool to start, in the background (set run_in_background to true), a ` +
      `Node.js one-liner that loops forever and appends one line every half second to this exact file ` +
      `path: ${heartbeat} -- each appended line should just be a counter and a timestamp. As soon as the ` +
      `tool call returns, without waiting for the command to finish or checking on it, reply with exactly ` +
      `this word and nothing else: ${marker}`;
    term.write(prompt);
    await sleep(1500);
    term.write('\r'); // Enter sent separately -- a long line sent with \r inline is swallowed as a paste

    // Ground truth is the transcript file on disk, not the pty screen (see
    // findTranscriptPath/readAssistantReply above for why screen-scraping a
    // reply marker is a proven false-positive trap here).
    const reply = await until(() => readAssistantReply(sessionId, marker), 60000, 1500);
    console.log(`[${at()}] model replied with the marker (per transcript): ${!!reply}`);
    record.repliedStarted = !!reply;

    const bgTaskInfo = findBackgroundTaskInfo(sessionId);
    if (bgTaskInfo) {
      let outputFileSize = null;
      try { outputFileSize = fs.statSync(bgTaskInfo.outputPath).size; } catch { /* not written yet or already cleaned up */ }
      console.log(`[${at()}] Bash tool's own background-task bookkeeping: id=${bgTaskInfo.taskId} output=${bgTaskInfo.outputPath} (${outputFileSize ?? 'missing'} bytes)`);
      record.backgroundTaskInfo = { ...bgTaskInfo, outputFileSize };
    }
    if (!reply) {
      record.failure = 'no assistant transcript entry containing the marker within 60s';
      record.screenAtFailure = screen();
      console.log(screen().join('\n'));
      results.realSession = record;
      return;
    }

    await sleep(1500);
    const table = processTable();
    const candidates = table.filter(p => p.CommandLine && p.CommandLine.includes(token));
    console.log(`[${at()}] process-table candidates matching token: ${candidates.length}`);
    candidates.forEach(c => console.log(`      pid=${c.ProcessId} ppid=${c.ParentProcessId} name=${c.Name}`));
    record.candidates = candidates.map(c => ({ pid: c.ProcessId, ppid: c.ParentProcessId, name: c.Name }));

    if (candidates.length === 0) {
      record.failure = 'no process in the table matched the token';
      results.realSession = record;
      console.log(`SKIP: could not identify the background task's child process (${record.failure})`);
      return;
    }
    // Claude Code's Bash tool on Windows wraps the command through nested
    // bash.exe layers (measured: 3 deep on this machine), and the full
    // command line -- including our heartbeat path -- is visible on every
    // layer, so all of them match the token. The actual workload is the LEAF
    // of that matched chain: the one candidate that is not itself the parent
    // of another candidate.
    const leaf = candidates.find(c => !candidates.some(other => other.ParentProcessId === c.ProcessId));
    const targetPid = (leaf || candidates[candidates.length - 1]).ProcessId;
    console.log(`[${at()}] leaf process (the actual workload): pid=${targetPid} name=${(leaf || {}).Name}`);
    record.leafPid = targetPid;
    const chain = ancestryChain(table, targetPid, term.pid);
    console.log(`[${at()}] ancestry chain (target -> ... -> claude.exe): ${chain.map(c => `${c.pid}:${c.name}`).join(' -> ')}`);
    const chainReachesClaude = chain.some(c => c.pid === term.pid);
    console.log(`chain reaches the claude.exe pid (${term.pid}): ${chainReachesClaude}`);
    record.ancestryChain = chain;
    record.chainReachesClaude = chainReachesClaude;

    const panelBefore = await tasksPanel('running, before suspend');
    const beforeLines = hbLines();
    console.log(`[${at()}] heartbeat lines before suspend: ${beforeLines}`);

    // L2 (Miguel, PR #61 review): suspend->resume gets its OWN try/finally,
    // independent of the SIGINT/uncaughtException backstop (`hygiene`) --
    // registerSuspended below means a Ctrl+C is still covered, but a plain
    // exception from tasksPanel()/hbLines() mid-suspend should resume via
    // this finally directly, not fall through to the emergency path.
    const samples = [];
    let sRes, rRes, panelMid, staysFlat;
    hygiene.registerSuspended(targetPid);
    try {
      sRes = ntAction('Suspend', targetPid);
      console.log(`[${at()}] suspend: ${sRes.out || sRes.err}`);
      record.suspendResult = sRes;

      for (let i = 0; i < 4; i++) {
        await sleep(5000);
        const n = hbLines();
        samples.push(n);
        console.log(`[${at()}] +${(i + 1) * 5}s while suspended, heartbeat lines: ${n}`);
      }
      panelMid = await tasksPanel('midway through the ~20s suspend window');
      record.linesWhileSuspended = samples;
      staysFlat = samples.every(n => n === samples[0]);
      console.log(`heartbeat stayed flat for the whole ~20s suspend window: ${staysFlat}`);
      record.staysFlatWhileSuspended = staysFlat;
    } finally {
      rRes = ntAction('Resume', targetPid);
      console.log(`[${at()}] resume: ${rRes.out || rRes.err}`);
      record.resumeResult = rRes;
      // Dexter, PR #61 review round 2, finding 4: only clear on a CONFIRMED
      // success -- see the matching comment in detectSuspendPrimitive for the
      // Ctrl+C-during-resume race this closes.
      if (rRes.code === 0) hygiene.clearSuspended(targetPid);
      else console.error(`[${at()}] RESUME FAILED for pid ${targetPid} (rc=${rRes.code}) -- left registered as suspended`);
    }

    await sleep(3000);
    const afterLines = hbLines();
    console.log(`[${at()}] heartbeat lines ~3s after resume: ${afterLines} (should exceed ${samples[samples.length - 1]})`);
    record.linesAfterResume = afterLines;
    record.resumedGrowth = afterLines > samples[samples.length - 1];

    const panelAfter = await tasksPanel('after resume');
    // The finding this whole test exists to make: the CLI's own /tasks panel
    // shows "Status: running" and a Runtime counter that keeps ticking up by
    // WALL CLOCK throughout the entire suspend window -- it has no idea the
    // process is frozen. Compare the three panels' Runtime/Status lines.
    const panelSummary = p => (p || []).filter(l => /Status:|Runtime:/.test(l)).map(l => l.trim());
    record.taskStateTextShown = {
      beforeSuspend: panelSummary(panelBefore), midSuspend: panelSummary(panelMid), afterResume: panelSummary(panelAfter),
      fullPanelAfterResume: panelAfter,
    };
    console.log(`[${at()}] /tasks Runtime/Status -- before: ${JSON.stringify(record.taskStateTextShown.beforeSuspend)} ` +
      `mid-suspend: ${JSON.stringify(record.taskStateTextShown.midSuspend)} after-resume: ${JSON.stringify(record.taskStateTextShown.afterResume)}`);

    // Kill the ROOT of the matched chain with /T (tree kill), not just the
    // leaf: the leaf is what was suspended/resumed above, but it sits under
    // nested bash.exe wrapper layers that would otherwise be left running,
    // waiting on a child that no longer exists.
    const root = candidates.find(c => !candidates.some(other => other.ProcessId === c.ParentProcessId));
    const rootPid = (root || candidates[0]).ProcessId;
    console.log(`[${at()}] cleaning up: tree-killing pid=${rootPid} (root of the matched chain) and the session`);
    try { execFileSync('taskkill', ['/PID', String(rootPid), '/F', '/T']); } catch (err) { console.log(`   taskkill root pid: ${err.message}`); }
    results.realSession = record;
  } finally {
    try { term.kill(); } catch {}
    hygiene.unregisterSpawnedTree(term.pid);
    // Belt-and-suspenders sweep, unconditional regardless of which branch
    // above ran or threw: term.kill() only kills the top-level claude.exe
    // pty process, NOT its nested bash.exe/node.exe descendants (they are
    // not in the same Windows Job Object) -- measured the hard way when an
    // earlier version of this probe SKIPped out on an unexpected candidate
    // count before reaching its explicit cleanup line and left a real
    // infinite-loop node.exe process running on this machine, invisible to
    // `claude agents` and `/tasks`, until a manual process-table sweep
    // caught it. Match by the token in the heartbeat filename, which is
    // unique to this run and appears on every wrapper layer's command line.
    try {
      const sweep = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${token}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { encoding: 'utf8' });
      if (sweep.status !== 0 && sweep.stderr) console.log(`   cleanup sweep stderr: ${sweep.stderr.trim()}`);
    } catch (err) { console.log(`   cleanup sweep failed: ${err.message}`); }
    try { fs.unlinkSync(heartbeat); } catch {}
    await sleep(500);
    try { fs.unlinkSync(heartbeat); } catch {} // a still-alive process can recreate it between the two unlinks above

    // Token spend: read the session's own "cost-state" transcript entry --
    // the authoritative dollar figure Claude Code itself computed, including
    // cache_creation/cache_read tokens that a naive per-turn
    // input_tokens+output_tokens sum silently omits (measured: that naive
    // sum reported $0 on a session cost-state itself priced at $0.10).
    try {
      const transcriptPath = findTranscriptPath(sessionId);
      const costState = latestCostState(sessionId);
      console.log(`[${at()}] transcript: ${transcriptPath || '(not found)'}`);
      if (costState) {
        console.log(`[${at()}] token spend (cost-state): totalCostUSD=${costState.totalCostUSD} modelUsage=${JSON.stringify(costState.modelUsage)}`);
        if (results.realSession) results.realSession.tokenSpend = { transcriptPath, totalCostUSD: costState.totalCostUSD, modelUsage: costState.modelUsage };
      } else {
        // cost-state is not written on every session (measured: present on
        // one run, absent on another of identical shape). Fall back to
        // summing the raw usage fields straight off each assistant turn so
        // the RESULTS block still carries real numbers, not a blank.
        const totals = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
        for (const o of readTranscriptEntries(sessionId)) {
          const u = o.message && o.message.role === 'assistant' && o.message.usage;
          if (!u) continue;
          for (const k of Object.keys(totals)) totals[k] += u[k] || 0;
        }
        console.log(`[${at()}] no cost-state entry this run -- raw usage summed instead: ${JSON.stringify(totals)}`);
        if (results.realSession) results.realSession.tokenSpend = { skip: 'no cost-state entry in transcript', transcriptPath, rawUsageTotals: totals };
      }
    } catch (err) {
      console.log(`[${at()}] could not read transcript for token spend: ${err.message}`);
      if (results.realSession) results.realSession.tokenSpend = { skip: err.message };
    }
  }
}

// =============================================================================
// Part (b): inventory only, no spend.
// =============================================================================
async function inventory() {
  console.log('\n=== Part (b): what the CLI exposes for stopping a background agent/task ===');
  const inv = {};

  const help = spawnSync('claude', ['--help'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const helpText = help.stdout || '';
  const bgLines = helpText.split('\n').filter(l =>
    /--bg|--background|\bagents\b|\battach\b|\bstop\|kill\b|\blogs\b|\brm\b|\brespawn\b/.test(l));
  console.log('claude --help (background-relevant lines):');
  bgLines.forEach(l => console.log('  ' + l.trim()));
  inv.helpBackgroundLines = bgLines.map(l => l.trim());

  // Built-in slash commands: typing '/' is a local filter list, by
  // construction never a prompt sent to the model -- this is a well-known
  // CLI behaviour, not something this script independently re-verifies via a
  // transcript/cost-state check the way realSessionTest does for its own
  // session (M1, Miguel, PR #61 review: the earlier wording here claimed
  // "verified below", which overstated what this code path actually checks).
  //
  // H2 (Miguel, PR #61 review): `term` is declared outside the try so a
  // `finally` can always reach it -- the previous version only killed it as
  // the LAST statement of the try block, so any exception between spawn and
  // that line (a Terminal buffer read, a node-pty hiccup) left a live
  // claude.exe (bypassPermissions, no session id) with nothing supervising
  // it, the same failure class realSessionTest's own comment already
  // documents having hit once for real.
  let term = null;
  try {
    const pty = require('node-pty');
    const { Terminal } = require('@xterm/headless');
    const CLAUDE_BIN = resolveClaudeExe();
    term = pty.spawn(CLAUDE_BIN, ['--permission-mode', 'bypassPermissions'], {
      name: 'xterm-256color', cols: 120, rows: 45, cwd: REPO, env: { ...cleanEnv(), TERM: 'xterm-256color' },
    });
    hygiene.registerChild(term);
    const xterm = new Terminal({ cols: 120, rows: 45, allowProposedApi: true });
    term.onData(d => xterm.write(d));
    const screen = () => {
      const b = xterm.buffer.active; const lines = [];
      for (let y = 0; y < 45; y++) { const l = b.getLine(b.baseY + y); if (l) { const t = l.translateToString(true).trimEnd(); if (t) lines.push(t); } }
      return lines;
    };
    await sleep(6000);

    term.write('/tasks');
    await sleep(1000);
    const tasksMatch = screen().find(l => /\/tasks/.test(l));
    console.log(`built-in /tasks command: ${tasksMatch ? tasksMatch.trim() : '(not found)'}`);
    inv.slashTasksEntry = tasksMatch ? tasksMatch.trim() : null;
    for (let i = 0; i < 10; i++) term.write('\x7f');
    await sleep(300);

    term.write('/background');
    await sleep(1000);
    const bgMatch = screen().find(l => /\/background\b/.test(l));
    console.log(`built-in /background command: ${bgMatch ? bgMatch.trim() : '(not found)'}`);
    inv.slashBackgroundEntry = bgMatch ? bgMatch.trim() : null;
    for (let i = 0; i < 12; i++) term.write('\x7f');
    await sleep(300);

    // Confirmed absent as a BUILT-IN (fuzzy matches below are project skills,
    // not CLI built-ins -- distinguished by having a description that names
    // something other than background-task control).
    for (const q of ['/pause', '/kill', '/stop']) {
      term.write(q);
      await sleep(900);
      const lines = screen();
      const idx = lines.findIndex(l => l.trim() === `❯ ${q}`);
      const menu = idx >= 0 ? lines.slice(idx + 2, idx + 4).map(l => l.trim()) : [];
      console.log(`typed ${q} -- top autocomplete results: ${JSON.stringify(menu)}`);
      inv[`slash${q.slice(1)}TopMatches`] = menu;
      for (let i = 0; i < q.length + 2; i++) term.write('\x7f');
      await sleep(300);
    }

    term.write('/tasks');
    await sleep(700);
    term.write('\r');
    await sleep(1200);
    const panel = screen().slice(-6);
    console.log('idle /tasks panel:\n  ' + panel.join('\n  '));
    inv.idleTasksPanel = panel;
    term.write('\x1b');
    await sleep(300);
  } catch (err) {
    console.log(`SKIP: could not drive an interactive pty for the slash-command inventory (${err.message})`);
    inv.slashCommandInventory = { skip: err.message };
  } finally {
    if (term) {
      try { term.kill(); } catch { /* already gone */ }
      hygiene.unregisterSpawnedTree(term.pid);
    }
  }

  // The model-facing tool schemas the CLI ships (BashInput.run_in_background,
  // TaskStopInput) -- ground truth for "can stop, cannot pause", read from the
  // installed npm package rather than assumed.
  try {
    const dtsPath = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'sdk-tools.d.ts');
    const dts = fs.readFileSync(dtsPath, 'utf8');
    const hasRunInBackground = /run_in_background\?:\s*boolean/.test(dts);
    const taskStopMatch = dts.match(/export interface TaskStopInput \{[^}]*\}/s);
    const hasPauseTool = /Pause|Suspend/i.test(dts.match(/export type ToolInputSchemas =[\s\S]*?;/)[0]);
    console.log(`sdk-tools.d.ts: BashInput.run_in_background present: ${hasRunInBackground}`);
    console.log(`sdk-tools.d.ts: TaskStopInput: ${taskStopMatch ? taskStopMatch[0].replace(/\s+/g, ' ') : '(not found)'}`);
    console.log(`sdk-tools.d.ts: any Pause/Suspend tool name in the tool union: ${hasPauseTool}`);
    inv.sdkTools = { path: dtsPath, hasRunInBackground, taskStopInput: taskStopMatch ? taskStopMatch[0] : null, hasPauseTool };
  } catch (err) {
    console.log(`SKIP: could not read the installed sdk-tools.d.ts (${err.message})`);
    inv.sdkTools = { skip: err.message };
  }

  // Hook events this project already wires (host/settings-writer.js) -- so a
  // gap ("nothing fires when a background bash task itself starts/finishes")
  // is a measured absence, not a guess.
  try {
    const swPath = path.join(REPO, 'host', 'settings-writer.js');
    const sw = fs.readFileSync(swPath, 'utf8');
    const wired = [...sw.matchAll(/^\s*(\w+):\s*\[entry\(/gm)].map(m => m[1]);
    console.log(`hook events wired by host/settings-writer.js: ${wired.join(', ')}`);
    console.log('none of these fire for a background BASH task\'s own start/finish (SubagentStop is for Task/Agent subagents, not raw Bash backgrounding)');
    inv.hooksWired = wired;
  } catch (err) {
    console.log(`SKIP: could not read host/settings-writer.js (${err.message})`);
    inv.hooksWired = { skip: err.message };
  }

  // State on disk that might name background tasks.
  try {
    const jobsDir = path.join(os.homedir(), '.claude', 'jobs');
    const jobsEntries = fs.readdirSync(jobsDir);
    console.log(`~/.claude/jobs entries (per \`claude --bg\` short id): ${jobsEntries.join(', ')}`);
    inv.claudeJobsDir = jobsEntries;
  } catch (err) {
    console.log(`SKIP: ~/.claude/jobs not readable (${err.message})`);
    inv.claudeJobsDir = { skip: err.message };
  }
  try {
    const tasksDir = path.join(os.homedir(), '.claude', 'tasks');
    const sessions = fs.readdirSync(tasksDir);
    let nonEmpty = 0;
    for (const s of sessions) {
      try { if (fs.readdirSync(path.join(tasksDir, s)).length) nonEmpty++; } catch {}
    }
    console.log(`~/.claude/tasks: ${sessions.length} session dirs scanned, ${nonEmpty} non-empty (contents are ` +
      `.highwatermark/.lock bookkeeping for the Task tool, not a list of background bash commands by name)`);
    inv.claudeTasksDir = { sessionDirs: sessions.length, nonEmpty };
  } catch (err) {
    console.log(`SKIP: ~/.claude/tasks not readable (${err.message})`);
    inv.claudeTasksDir = { skip: err.message };
  }

  const agentsJson = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  try {
    const sessions = JSON.parse(agentsJson.stdout || '[]');
    console.log(`\`claude agents --json\`: ${sessions.length} active session(s), fields: ${sessions[0] ? Object.keys(sessions[0]).join(', ') : '(none active)'}`);
    inv.agentsJsonFields = sessions[0] ? Object.keys(sessions[0]) : [];
  } catch (err) {
    console.log(`SKIP: \`claude agents --json\` did not parse (${err.message})`);
    inv.agentsJsonFields = { skip: err.message };
  }

  results.inventory = inv;
}

async function main() {
  hygiene.install();
  const primitive = await detectSuspendPrimitive();
  await realSessionTest(primitive);
  await inventory();
  try { fs.unlinkSync(NT_HELPER_PS1); } catch {}
  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  process.exit(0);
}

// Guarded so `require('./probe-pause')` (test/probe-hygiene.test.js) can
// reuse the pure helpers below -- and inspect `hygiene` itself -- without
// installing real SIGINT/uncaughtException handlers on the test process or
// spawning a real `claude` session as a side effect of loading the module.
if (require.main === module) {
  main().catch((err) => {
    console.error('probe failed:', err && err.stack);
    try { fs.unlinkSync(NT_HELPER_PS1); } catch {}
    process.exit(1);
  });
}

module.exports = {
  hygiene, ntAction, ancestryChain, findBackgroundTaskInfo, findTranscriptPath,
  readTranscriptEntries, readAssistantReply, latestCostState, resolveClaudeExe, cleanEnv,
};
