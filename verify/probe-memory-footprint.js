'use strict';
/* BACKLOG #20 -- what does the app actually cost in memory?

   This is the BASELINE every later memory change is judged against (#1, #2,
   #13, #18 and the "low memory" settings). It sets no threshold: there is no
   target yet, this probe is what produces one. PASS/FAIL is on "did every
   scenario actually run", never on a number.

   WHAT IS MEASURED -- the whole OS process tree under the Electron we spawn,
   not app.getAppMetrics(). getAppMetrics() only sees Electron's own processes;
   the detached host, its ConPTY and the real `claude` binary are separate OS
   processes it cannot see, and they are the heavy ones. One Win32_Process
   walk covers all of them, in one unit, with no change to app/main.js.
   Totals are split into HARNESS (Electron, host, ConPTY: what this app adds
   and its settings can shrink) and CLI (`claude` plus its MCP servers, which
   the user pays for with or without this app). Judge changes on HARNESS.
   Headline figure is PRIVATE bytes (commit charge). Working sets are shown too
   but summing them double-counts shared pages (every Chromium child maps the
   same DLLs), so they are context, not the number to compare.

   SCENARIOS
   - idle          launched, settled, nothing happening.
   - many agents   24 fake PreToolUse Agent hooks through hook-helper.exe --
                   the probe-roster.js trick, so no real subagent is billed.
   - long session  bash-mode (`!`) commands that print a few hundred KB into
                   the terminal. Bash mode runs locally and sends NO prompt, so
                   nothing is billed. Checked by the bytes a viewer actually
                   received: a "long session" that streamed nothing is not one.
   - video avatars NOT MEASURABLE YET: #13/#18 aren't built. The many-agents
                   figure is "roster populated, no images" and is reported as
                   PARTIAL rather than passed off as the backlog's scenario.

   Deliberately NOT copied from probe-roster.js: `taskkill /IM electron.exe`.
   That kills every Electron on the machine, including a claude-custom window
   this probe may be running inside. Only the PIDs of our own tree are killed,
   and the shared .harness/host.log is read from an offset, never truncated. */
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..');
const PORT = 7851;
const LOG = path.join(REPO, '.harness', 'host.log');
const HELPER = path.join(REPO, '.harness', 'hook-helper.exe');
const OUT = path.join(REPO, '.harness', 'memory-footprint.json');
const TOKEN = crypto.randomBytes(24).toString('hex');
const MB = (b) => (b / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function allProcesses() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,' +
    'CommandLine,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  return JSON.parse(ps.stdout);
}

// Pure: every process reachable from rootPid by ParentProcessId.
function descendants(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p);
  }
  const root = procs.find((p) => p.ProcessId === rootPid);
  if (!root) return [];
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const k of kids.get(out[i].ProcessId) || []) {
      // Windows reuses PIDs, so a stale ParentProcessId can form a cycle.
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

function role(p) {
  const cmd = p.CommandLine || '';
  const name = (p.Name || '').toLowerCase();
  if (/host[\\/]host\.js/.test(cmd)) return 'host';
  if (name.startsWith('claude')) return 'claude';
  if (name === 'conhost.exe' || name === 'openconsole.exe') return 'conpty';
  const type = (cmd.match(/--type=([a-z-]+)/) || [])[1];
  if (name === 'electron.exe') return type ? `electron:${type}` : 'electron:main';
  return `other:${name}`;
}

// The harness's own cost vs the CLI's. `claude` and everything under it (its
// MCP servers, shells) is what the user pays for Claude Code with or without
// this app; the rest is what this app adds, and the part its settings control.
function sample() {
  const procs = allProcesses();
  const tree = descendants(procs, app.pid);
  const cliPids = new Set();
  for (const c of tree.filter((p) => role(p) === 'claude')) {
    for (const d of descendants(procs, c.ProcessId)) cliPids.add(d.ProcessId);
  }
  const byRole = {};
  const owner = { harness: 0, cli: 0 };
  let priv = 0; let ws = 0;
  for (const p of tree) {
    const cli = cliPids.has(p.ProcessId);
    owner[cli ? 'cli' : 'harness'] += p.PrivatePageCount || 0;
    const r = cli && role(p) !== 'claude' ? `cli:${(p.Name || '').toLowerCase()}` : role(p);
    byRole[r] = byRole[r] || { count: 0, privateBytes: 0, workingSet: 0 };
    byRole[r].count++;
    byRole[r].privateBytes += p.PrivatePageCount || 0;
    byRole[r].workingSet += p.WorkingSetSize || 0;
    priv += p.PrivatePageCount || 0;
    ws += p.WorkingSetSize || 0;
  }
  for (const p of tree) seen.set(p.ProcessId, p.CommandLine || p.Name);
  return { at: Date.now(), processes: tree.length, privateBytes: priv, workingSet: ws,
    harnessPrivateBytes: owner.harness, cliPrivateBytes: owner.cli, byRole };
}

// Several samples, report the one with the median private total: a single
// reading lands on a GC or a paint as easily as on the steady state.
async function measure(name, n, gapMs) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(sample());
    if (i < n - 1) await sleep(gapMs);
  }
  const sorted = [...samples].sort((a, b) => a.privateBytes - b.privateBytes);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = sorted[sorted.length - 1].privateBytes - sorted[0].privateBytes;
  return { name, median, spreadBytes: spread, samples };
}

function report(m) {
  const s = m.median;
  console.log(`\n== ${m.name}: ${MB(s.privateBytes)} MB private (${s.privateBytes} bytes), ` +
    `${s.processes} processes, spread ${MB(m.spreadBytes)} MB over ${m.samples.length} samples`);
  console.log(`   HARNESS ${MB(s.harnessPrivateBytes)} MB (${s.harnessPrivateBytes} bytes)` +
    `   |   CLI + its MCP servers ${MB(s.cliPrivateBytes)} MB`);
  for (const [r, v] of Object.entries(s.byRole).sort((a, b) => b[1].privateBytes - a[1].privateBytes)) {
    console.log(`   ${r.padEnd(24)} x${v.count}  private ${MB(v.privateBytes).padStart(7)} MB` +
      `   ws ${MB(v.workingSet).padStart(7)} MB`);
  }
}

function hostLogSince(offset) {
  try {
    const buf = fs.readFileSync(LOG);
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8');
  } catch { return ''; }
}

// pid -> command line, so a reused PID isn't mistaken for a survivor.
const seen = new Map();
let app;

(async () => {
  if (await portInUse(PORT)) {
    console.log(`FAIL  port ${PORT} is already taken — a leftover probe host? Not touching it.`);
    process.exit(1);
  }
  const logOffset = (() => { try { return fs.statSync(LOG).size; } catch { return 0; } })();

  const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO,
    CLAUDE_CUSTOM_TOKEN: TOKEN };
  // Claude Code is itself Electron: an inherited ELECTRON_RUN_AS_NODE would
  // start this child as plain Node (see CLAUDE.md, "Traps").
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(require('electron'), [REPO], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d.toString(); });
  app.stderr.on('data', (d) => { out += d.toString(); });

  // A viewer, so the long-session scenario can prove bytes actually flowed.
  await sleep(15000);
  let viewerBytes = 0;
  const viewer = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(TOKEN)}`);
  viewer.on('message', (d) => { viewerBytes += d.length; });
  viewer.on('error', () => {});
  await new Promise((r) => { viewer.once('open', r); viewer.once('error', r); setTimeout(r, 5000); });
  check('a viewer attached to the probe host', viewer.readyState === WebSocket.OPEN);
  // Two early runs had a ~130 MB idle spread: `claude` was still starting.
  await sleep(25000);

  const results = [];

  // --- idle ---
  const idle = await measure('idle', 6, 5000);
  results.push(idle);
  const roles = Object.keys(idle.median.byRole);
  check('idle: the tree includes the host, the claude binary and a renderer',
    roles.includes('host') && roles.includes('claude') && roles.includes('electron:renderer'),
    roles.join(', '));

  // --- many agents ---
  const pipe = (hostLogSince(logOffset).match(/hook bridge listening on (\S+)/) || [])[1];
  check('hook bridge is up', !!pipe, pipe);
  const AGENTS = ['logic-reviewer', 'code-reviewer', 'mutation-tester', 'ui-ux-tester',
    'agent-organizer', 'spec-partner', 'security-auditor', 'media-pipeline-engineer',
    'debugger', 'electron-pro', 'python-pro', 'frontend-developer', 'backend-developer',
    'test-automator', 'doc-auditor', 'cedar', 'architect-reviewer', 'security-engineer',
    'performance-engineer', 'refactoring-specialist', 'data-analyst', 'devops-engineer',
    'javascript-pro', 'display-integrity-auditor'];
  if (pipe) {
    for (const agent of AGENTS) {
      spawnSync(HELPER, ['--pipe', pipe, '--event', 'PreToolUse'], {
        input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: agent } }),
        windowsHide: true,
      });
      await sleep(250);
    }
  }
  await sleep(5000);
  const hooks = (hostLogSince(logOffset).match(/\[hook\] PreToolUse/g) || []).length;
  check(`many agents: the host saw all ${AGENTS.length} Agent hooks`, hooks >= AGENTS.length, `${hooks}`);
  const agents = await measure('many agents (PARTIAL: roster populated, no video avatars — #13/#18 not built)', 4, 5000);
  results.push(agents);

  // --- long session ---
  const before = viewerBytes;
  const ROUNDS = 30;
  const send = (data) => viewer.send(JSON.stringify({ type: 'input', data }));
  for (let i = 0; i < ROUNDS; i++) {
    send('!');
    await sleep(300);
    send(`node -e "for(let i=0;i<200;i++)console.log('memprobe ${i} '+i+' '+'x'.repeat(64))"`);
    await sleep(200);
    send('\r');
    await sleep(2000);
  }
  await sleep(5000);
  const streamed = viewerBytes - before;
  // 30 rounds x 200 lines x ~80 chars is ~480 KB of output. Claude Code folds
  // long bash output, so demand far less than that -- but not nothing.
  check('long session: the terminal actually streamed output', streamed > 100 * 1024,
    `${MB(streamed)} MB to the viewer`);
  const long = await measure('long session', 6, 5000);
  results.push(long);

  results.forEach(report);
  console.log(`\nidle -> long session: ${MB(long.median.privateBytes - idle.median.privateBytes)} MB private` +
    ` (harness ${MB(long.median.harnessPrivateBytes - idle.median.harnessPrivateBytes)} MB)`);
  console.log('NOTE: "video avatars" is not measured — #13/#18 are not built. Re-run once they are.');

  fs.writeFileSync(OUT, JSON.stringify({
    measuredAt: new Date().toISOString(), note: 'private bytes = commit charge; the number to compare',
    videoAvatars: 'not built (#13/#18) - many-agents scenario is roster-only', results,
  }, null, 2));
  console.log('full samples ->', OUT);

  const errors = (out.match(/\[renderer:[a-z]+\].*/g) || [])
    .filter((l) => /error|not defined|undefined is not|cannot read/i.test(l));
  check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  try { viewer.close(); } catch {}
  // Our tree only. /T follows children; the explicit PID list catches anything
  // that had already been reparented by the time we kill.
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true });
  await sleep(1000);
  const ours = (p) => seen.get(p.ProcessId) === (p.CommandLine || p.Name);
  for (const p of allProcesses().filter(ours)) {
    spawnSync('taskkill', ['/PID', String(p.ProcessId), '/F'], { windowsHide: true });
  }
  await sleep(2000);
  const survivors = allProcesses().filter(ours);
  check('every process this probe started is gone', survivors.length === 0,
    survivors.map((p) => `${p.ProcessId} ${p.Name}`).join(', '));

  console.log(failures === 0 ? '\nALL PASS — baseline written' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  try { spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  process.exit(1);
});
