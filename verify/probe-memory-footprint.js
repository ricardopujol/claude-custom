'use strict';
const { killChildTree } = require('../host/kill-tree');
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
   - single instance  `--single-instance`: a separate run, no real CLI. One process
                   with 1 and 3 project windows against 1 and 3 processes; HARNESS
                   private bytes per extra project. See "single instance" below.

   .harness/host.log IS SHARED by every host on this repo, including a real
   claude-custom window this probe may be running inside (Miguel B1, PR #53).
   So nothing here trusts it blindly: the hook pipe is accepted only when its
   name carries OUR host's PID (host.js names it after process.pid), and
   delivery is proven by mood frames on OUR viewer, never by counting log
   lines other hosts also write. The log is read from an offset, never
   truncated.

   Deliberately NOT copied from probe-roster.js: `taskkill /IM electron.exe`.
   That kills every Electron on the machine. Only the PIDs of our own tree are
   killed, matched by PID *and* command line because Windows reuses PIDs. */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 7851;
const LOG = path.join(REPO, '.harness', 'host.log');
const HELPER = path.join(REPO, '.harness', 'hook-helper.exe');
const OUT = path.join(REPO, '.harness', 'memory-footprint.json');
const MB = (b) => (b / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers (unit-tested in test/probe-memory-footprint.test.js) ----

// Every process reachable from rootPid by ParentProcessId.
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

// The hook pipe of the host with this PID, or null. Every other host on the
// repo logs its own "hook bridge listening" line to the same file.
function pipeForHost(logText, hostPid) {
  const re = /hook bridge listening on (\S+)/g;
  let m;
  while ((m = re.exec(logText))) {
    if (m[1].endsWith(`-${hostPid}`)) return m[1];
  }
  return null;
}

// Harness vs CLI split, per role, for one process tree. `standIn` names the process that plays the CLI when a probe runs
// hosts on a stand-in binary (the single-instance measure uses cmd.exe): it is charged to the CLI, as `claude` would be.
function summarize(procs, rootPid, { standIn = null } = {}) {
  const tree = descendants(procs, rootPid);
  const cliPids = new Set();
  const isCli = (p) => role(p) === 'claude' || (!!standIn && (p.Name || '').toLowerCase() === standIn.toLowerCase());
  for (const c of tree.filter(isCli)) {
    for (const d of descendants(procs, c.ProcessId)) cliPids.add(d.ProcessId);
  }
  const byRole = {};
  const owner = { harness: 0, cli: 0 };
  let priv = 0; let ws = 0;
  for (const p of tree) {
    const cli = cliPids.has(p.ProcessId);
    owner[cli ? 'cli' : 'harness'] += p.PrivatePageCount || 0;
    const name = (p.Name || '').toLowerCase();
    const r = !cli ? role(p) : role(p) === 'claude' ? 'claude' : isCli(p) ? `cli-stand-in:${name}` : `cli:${name}`;
    byRole[r] = byRole[r] || { count: 0, privateBytes: 0, workingSet: 0 };
    byRole[r].count++;
    byRole[r].privateBytes += p.PrivatePageCount || 0;
    byRole[r].workingSet += p.WorkingSetSize || 0;
    priv += p.PrivatePageCount || 0;
    ws += p.WorkingSetSize || 0;
  }
  return { tree, cliPids, summary: { processes: tree.length, privateBytes: priv, workingSet: ws,
    harnessPrivateBytes: owner.harness, cliPrivateBytes: owner.cli, byRole } };
}

// The same summary over several roots (one per Jiandu process when single instance is off). A process reachable from two
// roots is counted once: the trees of separate Electron mains never share a process, and this keeps a cycle from doubling one.
function summarizeRoots(procs, rootPids, opts = {}) {
  const tree = [];
  const byRole = {};
  const out = { processes: 0, privateBytes: 0, workingSet: 0, harnessPrivateBytes: 0, cliPrivateBytes: 0, byRole, roots: rootPids.length };
  const counted = new Set();
  const cliPids = new Set();
  for (const pid of rootPids) {
    const one = summarize(procs.filter((p) => !counted.has(p.ProcessId)), pid, opts);
    for (const p of one.tree) { counted.add(p.ProcessId); tree.push(p); }
    for (const c of one.cliPids) cliPids.add(c);
    for (const k of ['processes', 'privateBytes', 'workingSet', 'harnessPrivateBytes', 'cliPrivateBytes']) out[k] += one.summary[k];
    for (const [r, v] of Object.entries(one.summary.byRole)) {
      byRole[r] = byRole[r] || { count: 0, privateBytes: 0, workingSet: 0 };
      byRole[r].count += v.count; byRole[r].privateBytes += v.privateBytes; byRole[r].workingSet += v.workingSet;
    }
  }
  return { tree, cliPids, summary: out };
}

// The STEADY harness: only the harness processes present in EVERY sample (same pid, same command line), each at its median
// private bytes. A process that comes and goes between samples (a one-shot powershell query, a git call) is left out, and
// reported as `transient` (how many distinct ones were seen, and the largest one). `samples` is a list of
// { tree, cliPids } as summarize / summarizeRoots return them.
function steadyHarness(samples) {
  const key = (p) => `${p.ProcessId}|${p.CommandLine || p.Name}`;
  const per = new Map();   // key -> { proc, bytes: [] }
  for (const s of samples) {
    for (const p of s.tree) {
      if (s.cliPids.has(p.ProcessId)) continue;
      const k = key(p);
      if (!per.has(k)) per.set(k, { proc: p, bytes: [] });
      per.get(k).bytes.push(p.PrivatePageCount || 0);
    }
  }
  let bytes = 0;
  const byRole = {};
  const transient = { count: 0, maxBytes: 0, roles: {} };
  for (const { proc, bytes: b } of per.values()) {
    const r = role(proc);
    if (b.length === samples.length) {
      const m = [...b].sort((x, y) => x - y)[Math.floor(b.length / 2)];
      bytes += m;
      byRole[r] = byRole[r] || { count: 0, privateBytes: 0 };
      byRole[r].count++; byRole[r].privateBytes += m;
    } else {
      transient.count++;
      transient.maxBytes = Math.max(transient.maxBytes, ...b);
      transient.roles[r] = (transient.roles[r] || 0) + 1;
    }
  }
  return { bytes, byRole, transient };
}

// Bytes per extra project between a 1-project and an n-project reading: (n - 1) extra projects. null when either reading is
// missing (never a confident zero: CLAUDE.md, "Number(null) is 0").
function perExtraProject(oneBytes, manyBytes, projects) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(oneBytes) || !ok(manyBytes) || !Number.isInteger(projects) || projects < 2) return null;
  return (manyBytes - oneBytes) / (projects - 1);
}

// ---- the probe ----

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

function hostLogSince(offset) {
  try {
    const buf = fs.readFileSync(LOG);
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8');
  } catch { return ''; }
}

async function main() {
  const WebSocket = require('ws');
  const TOKEN = crypto.randomBytes(24).toString('hex');
  let failures = 0;
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  // pid -> command line, so a reused PID isn't mistaken for one of ours.
  const seen = new Map();
  let app = null;
  let viewer = null;

  const sample = () => {
    const { tree, summary } = summarize(allProcesses(), app.pid);
    for (const p of tree) seen.set(p.ProcessId, p.CommandLine || p.Name);
    return { at: Date.now(), ...summary, tree };
  };

  // One cleanup for the happy path AND the error path (Miguel I1).
  const cleanup = async () => {
    try { if (viewer) viewer.close(); } catch {}
    if (!app) return;
    // Last-moment snapshot so anything spawned since the final measurement is
    // known too (Miguel I2). Residual gap: a process that is reparented out of
    // our tree between this snapshot and the kill escapes -- the same window
    // status-relay.js's killTree accepts. The survivor check below reports it.
    try { sample(); } catch {}
    killChildTree(app);
    await sleep(1000);
    const ours = (p) => seen.get(p.ProcessId) === (p.CommandLine || p.Name);
    for (const p of allProcesses().filter(ours)) {
      spawnSync('taskkill', ['/PID', String(p.ProcessId), '/F'], { windowsHide: true });   // kill-ok(table-row): a table row matched by pid AND the command line seen this run (table-row class)
    }
    await sleep(2000);
    const survivors = allProcesses().filter(ours);
    check('every process this probe started is gone', survivors.length === 0,
      survivors.map((p) => `${p.ProcessId} ${p.Name}`).join(', '));
  };

  // Several samples, report the one with the median private total: a single
  // reading lands on a GC or a paint as easily as on the steady state.
  const measure = async (name, n, gapMs) => {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const { tree, ...s } = sample();
      samples.push(s);
      if (i < n - 1) await sleep(gapMs);
    }
    const sorted = [...samples].sort((a, b) => a.privateBytes - b.privateBytes);
    const median = sorted[Math.floor(sorted.length / 2)];
    const spread = sorted[sorted.length - 1].privateBytes - sorted[0].privateBytes;
    return { name, median, spreadBytes: spread, samples };
  };

  const report = (m) => {
    const s = m.median;
    console.log(`\n== ${m.name}: ${MB(s.privateBytes)} MB private (${s.privateBytes} bytes), ` +
      `${s.processes} processes, spread ${MB(m.spreadBytes)} MB over ${m.samples.length} samples`);
    console.log(`   HARNESS ${MB(s.harnessPrivateBytes)} MB (${s.harnessPrivateBytes} bytes)` +
      `   |   CLI + its MCP servers ${MB(s.cliPrivateBytes)} MB`);
    for (const [r, v] of Object.entries(s.byRole).sort((a, b) => b[1].privateBytes - a[1].privateBytes)) {
      console.log(`   ${r.padEnd(24)} x${v.count}  private ${MB(v.privateBytes).padStart(7)} MB` +
        `   ws ${MB(v.workingSet).padStart(7)} MB`);
    }
  };

  try {
    if (await portInUse(PORT)) {
      check(`port ${PORT} is free (a leftover probe host? not touching it)`, false);
      return failures;
    }
    const logOffset = (() => { try { return fs.statSync(LOG).size; } catch { return 0; } })();

    const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO,
      CLAUDE_CUSTOM_TOKEN: TOKEN };
    // Claude Code is itself Electron: an inherited ELECTRON_RUN_AS_NODE would
    // start this child as plain Node (see CLAUDE.md, "Traps").
    delete env.ELECTRON_RUN_AS_NODE;
    app = spawnElectron(require('electron'), [REPO], { env, stdio: ['ignore', 'pipe', 'pipe'] }, { keepEnv: ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_TOKEN'] });
    let out = '';
    app.stdout.on('data', (d) => { out += d.toString(); });
    app.stderr.on('data', (d) => { out += d.toString(); });

    // A viewer on OUR host: terminal output arrives as binary frames, control
    // messages (mood changes) as JSON text frames.
    await sleep(15000);
    let terminalBytes = 0;
    const moodAgents = new Set();
    viewer = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(TOKEN)}`);
    viewer.on('message', (d, isBinary) => {
      if (isBinary) { terminalBytes += d.length; return; }
      try {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'mood' && msg.agent) moodAgents.add(msg.agent);
      } catch {}
    });
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
    const hostPid = (sample().tree.find((p) => role(p) === 'host') || {}).ProcessId;
    const pipe = hostPid ? pipeForHost(hostLogSince(logOffset), hostPid) : null;
    check('hook bridge is up, and it is OUR host\'s pipe', !!pipe, pipe || `no pipe ending -${hostPid}`);
    const AGENTS = ['logic-reviewer', 'code-reviewer', 'mutation-tester', 'ui-ux-tester',
      'agent-organizer', 'spec-partner', 'security-auditor', 'media-pipeline-engineer',
      'debugger', 'electron-pro', 'python-pro', 'frontend-developer', 'backend-developer',
      'test-automator', 'doc-auditor', 'cedar', 'architect-reviewer', 'security-engineer',
      'performance-engineer', 'refactoring-specialist', 'data-analyst', 'devops-engineer',
      'javascript-pro', 'display-integrity-auditor'];
    // No pipe proven ours -> send nothing: a wrong pipe is someone's real session.
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
    const missing = AGENTS.filter((a) => !moodAgents.has(a));
    check(`many agents: our viewer saw all ${AGENTS.length} agents change mood`, missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${moodAgents.size} agents`);
    const agents = await measure('many agents (PARTIAL: roster populated, no video avatars — #13/#18 not built)', 4, 5000);
    results.push(agents);

    // --- long session ---
    const before = terminalBytes;
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
    const streamed = terminalBytes - before;
    // 30 rounds x 200 lines x ~80 chars is ~480 KB of output. Claude Code folds
    // long bash output, so demand far less than that -- but not nothing.
    check('long session: the terminal actually streamed output', streamed > 100 * 1024,
      `${MB(streamed)} MB of terminal frames`);
    const long = await measure('long session', 6, 5000);
    results.push(long);

    results.forEach(report);
    console.log(`\nidle -> long session: ${MB(long.median.privateBytes - idle.median.privateBytes)} MB private` +
      ` (harness ${MB(long.median.harnessPrivateBytes - idle.median.harnessPrivateBytes)} MB)`);
    console.log('NOTE: "video avatars" is not measured — #13/#18 are not built. Re-run once they are.');

    const errors = (out.match(/\[renderer:[a-z]+\].*/g) || [])
      .filter((l) => /error|not defined|undefined is not|cannot read/i.test(l));
    check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await cleanup();
    app = null;

    // Written last, with the verdict, so a consumer can tell a clean baseline
    // from a failed run's numbers (Miguel I3).
    fs.writeFileSync(OUT, JSON.stringify({
      measuredAt: new Date().toISOString(), ok: failures === 0, failures,
      note: 'private bytes = commit charge; judge changes on harnessPrivateBytes',
      videoAvatars: 'not built (#13/#18) - many-agents scenario is roster-only', results,
    }, null, 2));
    console.log('full samples ->', OUT);
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    if (app) await cleanup();
  }
  return failures;
}

// ---- single instance: 1 vs 3 projects, one process against one process each (DESIGN_SINGLE_INSTANCE.md §6, §7 item 5) ----
//
//   node scripts/with-heavy-lock.js node verify/probe-memory-footprint.js --single-instance [--reverse]
//
// Two shapes, each read at 1 project and at 3:
//   one process    the single-instance flag on (CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE=1 + the probe's own state folder): the 2nd and
//                  3rd launch hand their project to the first process and exit; the tree under that one Electron main is measured.
//   one each       the flag off, as verify/probe-single-instance.js case 4 launches: every launch is its own Electron; the trees
//                  under all of them are summed.
// The headline is HARNESS private bytes per extra project: (3-project reading - 1-project reading) / 2, for each shape.
// The hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), charged to the CLI side as a stand-in, so no real CLI runs, nothing is
// billed, and the harness figure is the same one the baseline above reports. Each scratch project is one plain git repo (one
// tab, one host). --reverse measures "one each" first, to see whether the order moves the numbers.
// PASS/FAIL is "every scenario ran and was counted" (windows really opened, the hosts the app reports are in the measured
// tree, the Electron mains are the expected number), never a number.
// SAFE: as verify/probe-single-instance.js: scratch projects, registry, portraits, uploads, UI state and user data all in a
// temp folder; only this probe's own processes are ended (hosts by their identity file's pid + start, the rest by pid AND
// the command line this run saw).

const SETTLE_MS = 30000;
const SAMPLES = 8;
const GAP_MS = 4000;
const STAND_IN = 'cmd.exe';

async function singleInstanceMain({ reverse = false } = {}) {
  const { execFileSync } = require('child_process');
  const { tmpDir } = require('../test/tmp-dir');
  const { hostsUnder } = require('./lib/run-hosts');
  const { startTimes } = require('../host/proc-start');
  const seenPids = require('./lib/seen-pids').createSeenPids();
  const tmp = tmpDir('cc-probe-memory-si-');
  const HARNESS_DIR = path.join(REPO, '.harness');
  let failures = 0;
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
    if (!ok) failures++;
  };
  const seen = new Map();   // pid -> command line seen in a measured tree this run
  const apps = [];

  const waitFor = async (fn, ms = 20000, step = 500) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v; try { v = await fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(step);
    }
  };
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
    'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_UI_STATE_DIR',
    'CLAUDE_CUSTOM_ONE_WINDOW_PROBE', 'CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE'];

  // The launch verify/probe-single-instance.js makes (its launchApp), with the user data folder per shape.
  async function launchApp(cwd, { uiState, userData, flag }) {
    const port = await freePort();
    const token = crypto.randomBytes(16).toString('hex');
    const env = { ...process.env, CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CUSTOM_CWD: cwd,
      CLAUDE_CUSTOM_TABS_PROBE: String(port), CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
      CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'), CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
      CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'), CLAUDE_CUSTOM_UI_STATE_DIR: uiState, CLAUDE_CUSTOM_ONE_WINDOW_PROBE: '1' };
    if (flag) env.CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE = '1';
    for (const k of Object.keys(env)) {
      if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
      if (k === 'CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE' && !flag) delete env[k];
    }
    delete env.ELECTRON_RUN_AS_NODE;
    fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
    const child = spawnElectron(require('electron'), [REPO, `--user-data-dir=${userData}`], { cwd: REPO, env,
      stdio: ['ignore', 'pipe', 'pipe'] }, { keepEnv: PASSED_ENV });
    const app = { port, token, child, out: '', exited: false, exitCode: null };
    child.stdout.on('data', (d) => { app.out += d; });
    child.stderr.on('data', (d) => { app.out += d; });
    child.on('exit', (code) => { app.exited = true; app.exitCode = code; });
    apps.push(app);
    return app;
  }

  const command = (app, cmd, timeoutMs = 30000) => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
  const stateOf = async (app, root) => {
    const st = await command(app, root === undefined ? { cmd: 'state' } : { cmd: 'state', window: root });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    return st;
  };
  // A window is up when its tab's host is running (a host pid in its state).
  const windowUp = (app, root) => waitFor(async () => {
    const st = await stateOf(app, root);
    return st && st.ok && Array.isArray(st.hosts) && st.hosts.length >= 1 && st.hosts.every((h) => Number.isInteger(h.pid)) ? st : null;
  }, 150000, 500);
  const windowsOf = async (app) => { const r = await command(app, { cmd: 'windows' }); return r && r.ok ? r : null; };
  const handedOver = (app) => /single instance: the owner \(pid \d+\) has it; this launch ends/.test(app.out);
  const endsHandedOver = async (app) => {
    await waitFor(() => (handedOver(app) ? true : null), 120000);
    const gone = await waitFor(() => (app.exited ? true : null), 120000, 1000);
    return handedOver(app) && gone === true && app.exitCode === 0;
  };

  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
    { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
  const makeProject = (name) => {
    const container = path.join(tmp, name);
    const dev = path.join(container, 'dev');
    fs.mkdirSync(dev, { recursive: true });
    git(dev, 'init', '-q', '-b', 'develop');
    git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
    return { name, container, dev };
  };

  // With the start time each host wrote (readIdentity drops it: verify/lib/run-hosts.js).
  const hostsOfThisRun = () => hostsUnder(HARNESS_DIR, tmp);

  const measureRoots = async (name, roots) => {
    const samples = [];
    const raw = [];
    for (let i = 0; i < SAMPLES; i++) {
      const all = allProcesses();
      const { tree, cliPids, summary } = summarizeRoots(all, roots(), { standIn: STAND_IN });
      for (const p of tree) seen.set(p.ProcessId, p.CommandLine || p.Name);
      samples.push(summary);
      raw.push({ tree, cliPids, parentRole: new Map(tree.map((p) => [p.ProcessId, role(all.find((q) => q.ProcessId === p.ParentProcessId) || {})])) });
      if (i < SAMPLES - 1) await sleep(GAP_MS);
    }
    const sorted = [...samples].sort((a, b) => a.harnessPrivateBytes - b.harnessPrivateBytes);
    // Where the powershells hang from, and what they run: they are harness processes the app starts, some kept (the resource
    // sampler's persistent shell, host/persistent-powershell.js), some one-shot queries.
    const shells = {};
    for (const s of raw) {
      for (const p of s.tree) {
        if ((p.Name || '').toLowerCase() !== 'powershell.exe') continue;
        const k = `${s.parentRole.get(p.ProcessId)} :: ${(p.CommandLine || '').replace(/\s+/g, ' ').slice(0, 90)}`;
        shells[k] = shells[k] || { sightings: 0, pids: new Set() };
        shells[k].sightings++; shells[k].pids.add(p.ProcessId);
      }
    }
    return { name, median: sorted[Math.floor(sorted.length / 2)],
      spreadBytes: sorted[sorted.length - 1].harnessPrivateBytes - sorted[0].harnessPrivateBytes, samples,
      steady: steadyHarness(raw), shells: Object.fromEntries(Object.entries(shells).map(([k, v]) => [k, { sightings: v.sightings, pids: v.pids.size }])),
      tree: raw[raw.length - 1].tree };
  };
  const count = (m, r) => (m.median.byRole[r] || { count: 0 }).count;

  // Every host the app reports for these windows is in the measured tree: the tree really holds what was opened.
  const hostsInTree = (m, states) => {
    const pids = new Set(m.tree.map((p) => p.ProcessId));
    const hosts = states.flatMap((s) => (s && s.hosts) || []).map((h) => h.pid);
    return { hosts, ok: hosts.length > 0 && hosts.every((h) => pids.has(h)) && count(m, 'host') === hosts.length };
  };

  async function shape(label, flag) {
    const ui = path.join(tmp, `ui-${label}`);
    fs.mkdirSync(ui, { recursive: true });
    const userData = path.join(tmp, `user-data-${label}`);
    const P = [1, 2, 3].map((i) => makeProject(`${label}-p${i}`));
    const mine = [];
    const first = await launchApp(P[0].container, { uiState: ui, userData, flag });
    mine.push(first);
    const s1 = await windowUp(first);
    check(`${label}: project 1 came up`, !!s1, s1 ? '' : first.out.slice(-600));
    if (!s1) return { label, mine };
    await sleep(SETTLE_MS);
    const one = await measureRoots(`${label}, 1 project`, () => [first.child.pid]);
    const h1 = hostsInTree(one, [s1]);
    check(`${label}, 1 project: one Electron main, and the app's host (${h1.hosts.join(' ')}) is in the measured tree`,
      count(one, 'electron:main') === 1 && h1.ok, JSON.stringify(Object.keys(one.median.byRole)));

    const states = [s1];
    for (const p of P.slice(1)) {
      const a = await launchApp(p.container, { uiState: ui, userData, flag });
      mine.push(a);
      if (flag) {
        check(`${label}: the launch on ${p.name} handed over and exited 0`, await endsHandedOver(a), `exit=${a.exitCode} ${a.out.slice(-300)}`);
        states.push(await windowUp(first, p.container));
      } else {
        states.push(await windowUp(a));
      }
      check(`${label}: ${p.name}'s window came up`, !!states[states.length - 1]);
    }
    let roots;
    if (flag) {
      const w = await waitFor(async () => { const r = await windowsOf(first); return r && r.windows.length === 3 ? r : null; }, 60000);
      check(`${label}: one process holds the three windows`, !!w && w.pid === first.child.pid, JSON.stringify(w && w.windows.map((x) => path.basename(x.root))));
      roots = () => [first.child.pid];
    } else {
      const ws = await Promise.all(mine.map(windowsOf));
      const pids = new Set(mine.map((a) => a.child.pid));
      check(`${label}: three processes, one window each`, pids.size === 3 && mine.every((a) => !a.exited) && ws.every((w) => !!w && w.windows.length === 1),
        JSON.stringify(ws.map((w) => w && w.windows.length)));
      roots = () => mine.map((a) => a.child.pid);
    }
    const pages = await Promise.all(mine.filter((a) => !a.exited).map((a) => command(a, { cmd: 'webContents' })));
    await sleep(SETTLE_MS);
    const three = await measureRoots(`${label}, 3 projects`, roots);
    const h3 = hostsInTree(three, states);
    check(`${label}, 3 projects: ${flag ? 1 : 3} Electron main(s), and the app's 3 hosts are in the measured tree`,
      count(three, 'electron:main') === (flag ? 1 : 3) && h3.ok && h3.hosts.length === 3, `hosts ${h3.hosts.join(' ')}`);
    const extra = perExtraProject(one.median.harnessPrivateBytes, three.median.harnessPrivateBytes, 3);
    const steadyExtra = perExtraProject(one.steady.bytes, three.steady.bytes, 3);
    return { label, mine, one, three, extra, steadyExtra, pages: pages.map((p) => p && p.count) };
  }

  const report = (m) => {
    const s = m.median;
    console.log(`\n== ${m.name}: HARNESS ${MB(s.harnessPrivateBytes)} MB private (${s.harnessPrivateBytes} bytes), ` +
      `${s.processes} processes, spread ${MB(m.spreadBytes)} MB over ${m.samples.length} samples`);
    for (const [r, v] of Object.entries(s.byRole).sort((a, b) => b[1].privateBytes - a[1].privateBytes)) {
      console.log(`   ${r.padEnd(26)} x${v.count}  private ${MB(v.privateBytes).padStart(7)} MB   ws ${MB(v.workingSet).padStart(7)} MB`);
    }
    const st = m.steady;
    console.log(`   STEADY harness (in all ${m.samples.length} samples, each at its median): ${MB(st.bytes)} MB; ` +
      `transient: ${st.transient.count} process(es) ${JSON.stringify(st.transient.roles)}, largest ${MB(st.transient.maxBytes)} MB`);
    for (const [r, v] of Object.entries(st.byRole).sort((a, b) => b[1].privateBytes - a[1].privateBytes)) {
      console.log(`     steady ${r.padEnd(24)} x${v.count}  ${MB(v.privateBytes).padStart(7)} MB`);
    }
    for (const [k, v] of Object.entries(m.shells)) console.log(`     powershell <- ${k}  (${v.sightings} sightings, ${v.pids} pid(s))`);
  };

  const endAll = async () => {
    for (const a of apps.filter((x) => !x.exited)) await command(a, { cmd: 'quit', graceful: true }, 10000);
    await waitFor(() => (apps.every((a) => a.exited) ? true : null), 60000, 1000);
    for (const a of apps.filter((x) => !x.exited)) killChildTree(a.child);
    for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
    seenPids.endAll();
    await sleep(2000);
    const ours = (p) => seen.get(p.ProcessId) === (p.CommandLine || p.Name);
    for (const p of allProcesses().filter(ours)) {
      spawnSync('taskkill', ['/PID', String(p.ProcessId), '/F'], { windowsHide: true });   // kill-ok(table-row): a table row matched by pid AND the command line seen this run (table-row class)
    }
    await sleep(2000);
    const survivors = allProcesses().filter(ours);
    check('every process this probe measured is gone', survivors.length === 0, survivors.map((p) => `${p.ProcessId} ${p.Name}`).join(', '));
    const hostsLeft = hostsOfThisRun().filter((h) => h.processStartedAt !== null);
    const starts = hostsLeft.length ? await startTimes(hostsLeft.map((h) => h.pid)) : new Map();
    const leaked = hostsLeft.filter((h) => starts && starts.get(h.pid) === h.processStartedAt);
    check('every host this probe\'s projects started has ended (pid + the start time it wrote)', leaked.length === 0, leaked.map((h) => `${h.pid} ${h.cwd}`).join(', '));
    check('every Electron this probe started has ended', apps.every((a) => a.exited), apps.filter((a) => !a.exited).map((a) => a.child.pid).join(' '));
  };

  const results = [];
  try {
    const order = reverse ? [['one-each', false], ['one-process', true]] : [['one-process', true], ['one-each', false]];
    for (const [label, flag] of order) {
      const r = await shape(label, flag);
      results.push(r);
      // Each shape ends before the next starts, so one shape's processes are never in the other's reading.
      for (const a of r.mine.filter((x) => !x.exited)) await command(a, { cmd: 'quit', graceful: true }, 10000);
      await waitFor(() => (r.mine.every((a) => a.exited) ? true : null), 60000, 1000);
      check(`${label}: its processes ended before the next shape`, r.mine.every((a) => a.exited));
    }
    for (const r of results) { if (r.one) report(r.one); if (r.three) report(r.three); }
    console.log('\nHARNESS private bytes per extra project (median readings; (3 - 1) / 2):');
    for (const r of results) {
      const fmt = (v) => (typeof v === 'number' ? `${MB(v)} MB (${Math.round(v)} bytes)` : 'not measured');
      console.log(`   ${r.label.padEnd(12)} ${fmt(r.extra)}   steady ${fmt(r.steadyExtra)}` +
        (r.pages ? `   pages after 3: ${JSON.stringify(r.pages)}` : ''));
    }
    for (const [field, name] of [['extra', 'HARNESS'], ['steadyExtra', 'steady HARNESS']]) {
      const by = Object.fromEntries(results.map((r) => [r.label, r[field]]));
      if (typeof by['one-each'] === 'number' && typeof by['one-process'] === 'number') {
        console.log(`   saving per extra project, ${name}: ${MB(by['one-each'] - by['one-process'])} MB (the design's estimate: ~335 MB)`);
      }
    }
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await endAll();
  }
  const out = path.join(REPO, '.harness', 'memory-footprint-single-instance.json');
  fs.writeFileSync(out, JSON.stringify({
    measuredAt: new Date().toISOString(), ok: failures === 0, failures, reverse,
    note: 'harness private bytes per extra project = (3 - 1) / 2 of the median readings; cmd.exe stands in for claude (CLI side)',
    results: results.map(({ mine, ...r }) => ({ ...r, one: r.one && { ...r.one, tree: undefined }, three: r.three && { ...r.three, tree: undefined } })),
  }, null, 2));
  console.log('full samples ->', out);
  return failures;
}

if (require.main === module) {
  const single = process.argv.includes('--single-instance');
  (single ? singleInstanceMain({ reverse: process.argv.includes('--reverse') }) : main()).then((failures) => {
    console.log(failures === 0 ? (single ? '\nALL PASS' : '\nALL PASS — baseline written') : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
}

module.exports = { descendants, role, pipeForHost, summarize, summarizeRoots, perExtraProject, steadyHarness };
