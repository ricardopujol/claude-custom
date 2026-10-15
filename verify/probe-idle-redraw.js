'use strict';
/**
 * PROBE: what an IDLE claude-custom window costs in CPU and GPU, per Electron process type, and what each always-on
 * animation adds (BACKLOG #100 b), normal mode against lean mode (BACKLOG #99). (re-runnable; HEAVY: take
 * ~/.claude/scripts/heavy-lock.ps1 first)
 *
 *   node verify/probe-idle-redraw.js [--reps=3] [--measure-ms=20000] [--only=idle,pulse-done] [--out=<file.json>]
 *
 * ONE real window with two real hosts (the host's `claude` is cmd.exe, nothing bills), a TEMP git project. Each scenario
 * is put in place by the same driver the other probes use (hook lines down the host pipe, the window's focus and blur,
 * minimise, the lean button), settles for a few seconds, then is measured for --measure-ms:
 *
 *   - CPU % of ONE core per Electron process type (main, renderer, gpu-process, utility), from the CPU-time delta of the
 *     Win32_Process rows present at both ends;
 *   - GPU engine % summed over those same pids ('\GPU Engine(*)\Utilization Percentage', sampled every 5 s while the
 *     window runs).
 *
 * Scenarios run NORMAL then LEAN, in rounds: round 1 is every scenario normal then lean, round 2 again, and so on, so a
 * drift in the machine's load spreads over both modes instead of landing on one. The table reports the MEDIAN over rounds
 * and the min..max, because a number without its spread is not a measurement.
 *
 * HONEST LIMIT: a probe window is off screen with backgroundThrottling off and native occlusion tracking off
 * (host/probe-window.js, app/main.js), so it paints like a window that is visible and uncovered. A window covered by
 * another one is cheaper in the real app (Chromium stops painting an occluded window). The minimised scenario is the one
 * hidden case a probe can drive.
 *
 * Electron is started ONLY through verify/lib/launch-electron.js; only the Electron tree and the hosts this probe started
 * are stopped, by PID. Nothing is stopped by name.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- pure helpers (unit-tested in test/probe-idle-redraw.test.js) ----

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** { median, min, max, n } of the finite numbers in xs; null when there are none. */
function spread(xs) {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  return { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length };
}

/** The Electron process type of a Win32_Process row: 'main', 'renderer', 'gpu-process', 'utility', ... or null when it is not Electron. */
function electronType(p) {
  if (!p || String(p.Name || '').toLowerCase() !== 'electron.exe') return null;
  const t = (String(p.CommandLine || '').match(/--type=([a-z-]+)/) || [])[1];
  return t || 'main';
}

const cpuTime = (p) => (Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0);

/**
 * CPU % of one core per Electron type between two process tables `wallS` seconds apart. Only a process present at both
 * ends with the same command line counts (a reused pid is not the same process).
 */
function cpuByType(before, after, wallS) {
  const was = new Map(before.map(p => [p.ProcessId, p]));
  const out = {};
  for (const p of after) {
    const t = electronType(p);
    if (!t) continue;
    const e = out[t] = out[t] || { count: 0, cpu: 0 };
    e.count++;
    const prev = was.get(p.ProcessId);
    if (prev && prev.CommandLine === p.CommandLine && wallS > 0) e.cpu += ((cpuTime(p) - cpuTime(prev)) / 1e7 / wallS) * 100;
  }
  return out;
}

/** GPU engine counter rows [{ at, name, value }] -> the median over time of the summed utilisation of `pids`. */
function gpuPercent(rows, pids) {
  const want = new Set(pids);
  const byTime = new Map();
  for (const c of rows || []) {
    const m = /^pid_(\d+)_/.exec(c.name || '');
    if (!m || !want.has(Number(m[1])) || typeof c.value !== 'number') continue;
    byTime.set(c.at, (byTime.get(c.at) || 0) + c.value);
  }
  return byTime.size ? median([...byTime.values()]) : 0;
}

/** Rounds of readings -> per scenario and mode, the spread of each metric. readings: [{ scenario, mode, cpu: {type: pct}, gpu }] */
function summarise(readings) {
  const cells = new Map();
  for (const r of readings) {
    const k = `${r.scenario}|${r.mode}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of cells) {
    const [scenario, mode] = k.split('|');
    const types = new Set(rs.flatMap(r => Object.keys(r.cpu)));
    const cpu = {};
    for (const t of types) cpu[t] = spread(rs.map(r => r.cpu[t]));
    cpu.total = spread(rs.map(r => Object.values(r.cpu).reduce((a, x) => a + (x || 0), 0)));
    out.push({ scenario, mode, rounds: rs.length, cpu, gpu: spread(rs.map(r => r.gpu)) });
  }
  return out;
}

const cell = (s) => (s ? `${s.median.toFixed(1)} (${s.min.toFixed(1)}..${s.max.toFixed(1)})` : 'n/a');

function table(rows) {
  const lines = ['| scenario | mode | rounds | GPU process CPU % | renderers CPU % | main CPU % | all Electron CPU % | GPU engine % |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.scenario} | ${r.mode} | ${r.rounds} | ${cell(r.cpu['gpu-process'])} | ${cell(r.cpu.renderer)} | ${cell(r.cpu.main)} | ${cell(r.cpu.total)} | ${cell(r.gpu)} |`);
  }
  return lines.join('\n');
}

// ---- the probe ----

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

function processTable() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  return JSON.parse(ps.stdout);
}

// Get-Counter over the measuring window; resolves the rows, or null.
function sampleGpu(seconds) {
  const script = `$s = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 5 -MaxSamples ${Math.max(1, Math.floor(seconds / 5))} -ErrorAction SilentlyContinue; ` +
    `$s | ForEach-Object { $t = $_.Timestamp.Ticks; $_.CounterSamples | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { [pscustomobject]@{ at = $t; name = $_.InstanceName; value = $_.CookedValue } } } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let text = '';
    ps.stdout.on('data', (d) => { text += d; });
    ps.on('error', () => resolve(null));
    ps.on('exit', () => {
      try { const j = JSON.parse(text.trim() || '[]'); resolve(Array.isArray(j) ? j : [j]); } catch { resolve(null); }
    });
  });
}

function descendantPids(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p.ProcessId);
  }
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) || []) if (!out.includes(k)) out.push(k);
  return new Set(out);
}

async function main() {
  const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));
  const { createHygieneRegistry } = require('./lib/process-hygiene');
  const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
  const hygiene = createHygieneRegistry();
  hygiene.install();
  const tmp = tmpDir('cc-probe-idle-');
  const container = path.join(tmp, 'proj');
  const dev = path.join(container, 'dev');
  const featA = path.join(container, 'feat-a');
  const userData = path.join(tmp, 'user-data');
  const reps = Number(arg('reps', '3'));
  const measureMs = Number(arg('measure-ms', '20000'));
  const settleMs = Number(arg('settle-ms', '6000'));
  const only = arg('only', '');
  const modes = arg('modes', 'normal,lean').split(',');
  const outFile = arg('out', path.join(HARNESS_DIR, 'idle-redraw.json'));

  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...a], { cwd, stdio: 'pipe', windowsHide: true });
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
    'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];
  const waitFor = async (fn, ms = 20000, step = 250) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v; try { v = await fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(step);
    }
  };

  const seenPids = require('./lib/seen-pids').createSeenPids();
  const killEverything = () => {
    let files = [];
    try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { /* none */ }
    const inside = path.resolve(tmp).toLowerCase() + path.sep;
    for (const f of files) {
      const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
      if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) seenPids.add(id.pid, id.processStartedAt);
    }
    seenPids.endAll();
  };
  hygiene.addCleanup(killEverything);

  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');

  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = { ...process.env, CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CUSTOM_CWD: container,
    CLAUDE_CUSTOM_TABS_PROBE: String(port), CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'), CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads') };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
  const app = { child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });

  const command = (cmd, timeoutMs = 30000) => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token }) + '\n'));
    sock.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } } });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
  const stateOf = async () => {
    const st = await command({ cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    return st;
  };
  const tabOf = (st, label) => (Array.isArray(st && st.stripDom) ? st.stripDom.find(t => t.label === label) || null : null);
  const hostPid = (st, label) => { const h = ((st && st.hosts) || []).find(x => x.label === label); return h && Number.isInteger(h.pid) ? h.pid : null; };
  const fireHook = (pid, event, payload) => new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
  const leanPage = async () => { const r = await command({ cmd: 'view', action: 'leanState', args: {} }); return r && r.ok ? r : null; };
  const setLean = async (on) => {
    const now = await leanPage();
    if (!now || now.leanOn !== on) await command({ cmd: 'strip-lean', button: on ? 'lean-btn' : 'lean-back' });
    return waitFor(async () => { const p = await leanPage(); return p && p.leanOn === on ? p : null; }, 10000);
  };

  // Both tabs started and their pages joined their hosts (a hook sent earlier is heard by nobody).
  async function bothStarted() {
    if (!await waitFor(async () => (tabOf(await stateOf(), 'feat/a') ? true : null), 60000)) return null;
    const pageUp = () => waitFor(async () => { const v = (await stateOf()).viewDom; return v && v.hasTerm === true && v.xterm > 0 ? true : null; }, 30000);
    for (const label of ['feat/a', 'develop']) {
      const r = await command({ cmd: 'select', label });
      if (!(r && r.ok && r.started && await pageUp())) return null;
    }
    await sleep(1500);
    return waitFor(async () => { const st = await stateOf(); return hostPid(st, 'feat/a') && hostPid(st, 'develop') && tabOf(st, 'develop').selected ? st : null; }, 20000);
  }

  // Back to a clean, quiet, normal window: focused (clears the cue), restored, develop selected, no pulse, no background.
  async function reset() {
    await command({ cmd: 'window-state', state: 'restore' });
    await setLean(false);
    await command({ cmd: 'windowFocus' });
    await command({ cmd: 'select', label: 'feat/a' });     // selecting a pulsing tab ends its pulse
    await command({ cmd: 'select', label: 'develop' });
    await command({ cmd: 'view', action: 'bgStyle', args: { action: 'reset-background' } });
    await sleep(500);
  }
  let aPid = null; let dPid = null;
  const stop = async (pid) => { await sleep(4500); return fireHook(pid, 'Stop', {}); };   // one Stop per 4 s per host
  const pulse = async (want) => !!await waitFor(async () => ((tabOf(await stateOf(), 'feat/a') || {}).pulse || null) === want, 15000);
  const SCENARIOS = {
    'idle': async () => true,
    'pulse-done': async () => { await stop(aPid); return pulse('pulse-done'); },
    'pulse-needs': async () => { await fireHook(aPid, 'Notification', { notification_type: 'permission_prompt', message: 'needs you' }); return pulse('pulse-needs'); },
    'cue': async () => { await command({ cmd: 'windowBlur' }); await stop(dPid); return !!await waitFor(async () => (await command({ cmd: 'view', action: 'animState', args: {} })).cue, 8000); },
    'pulse-and-cue': async () => { await command({ cmd: 'windowBlur' }); await stop(aPid); await stop(dPid); return pulse('pulse-done'); },
    'minimised-pulse-and-cue': async () => { await command({ cmd: 'windowBlur' }); await stop(aPid); await stop(dPid); await pulse('pulse-done'); const r = await command({ cmd: 'window-state', state: 'minimize' }); return r.ok; },
  };
  const names = Object.keys(SCENARIOS).filter(n => !only || only.split(',').includes(n));

  const ready = await bothStarted();
  if (!ready) { console.log(`FAIL  the window did not come up with both tabs started\n${app.out.slice(-600)}`); return 1; }
  aPid = hostPid(ready, 'feat/a'); dPid = hostPid(ready, 'develop');
  console.log(`window up: electron root ${child.pid}, hosts develop ${dPid} feat/a ${aPid}; ${names.length} scenarios x ${modes.join('+')} x ${reps} rounds, ${measureMs / 1000}s each`);

  const readings = [];
  const notes = [];
  for (let round = 1; round <= reps; round++) {
    for (const name of names) {
      for (const mode of modes) {
        await reset();
        const ok = await SCENARIOS[name]();
        if (mode === 'lean') await setLean(true);
        if (!ok) notes.push(`round ${round} ${name}/${mode}: the scenario state was not reached`);
        await sleep(settleMs);
        const a = processTable();
        const pids = descendantPids(a, child.pid);
        const gpuJob = sampleGpu(measureMs / 1000);
        const t0 = Date.now();
        await sleep(measureMs);
        const b = processTable();
        const wallS = (Date.now() - t0) / 1000;
        const mine = (rows) => rows.filter(p => pids.has(p.ProcessId));
        const cpu = {};
        for (const [t, e] of Object.entries(cpuByType(mine(a), mine(b), wallS))) cpu[t] = e.cpu;
        const gpu = gpuPercent(await gpuJob, [...pids]);
        readings.push({ round, scenario: name, mode, cpu, gpu, scenarioReached: ok });
        console.log(`round ${round} ${name.padEnd(24)} ${mode.padEnd(6)} gpu-proc ${(cpu['gpu-process'] || 0).toFixed(1)}%  renderers ${(cpu.renderer || 0).toFixed(1)}%  main ${(cpu.main || 0).toFixed(1)}%  gpu-engine ${gpu.toFixed(1)}%${ok ? '' : '  (STATE NOT REACHED)'}`);
      }
    }
  }
  await reset();
  const rows = summarise(readings);
  console.log('\n' + table(rows));
  if (notes.length) console.log('\nnotes:\n' + notes.join('\n'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ measuredAt: new Date().toISOString(), reps, measureMs, settleMs, readings, rows, notes }, null, 2));
  console.log('\nfull numbers ->', outFile);
  await command({ cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exit(code); }, (e) => { console.error(e); process.exit(1); });
}

module.exports = { median, spread, electronType, cpuByType, gpuPercent, summarise, table };
