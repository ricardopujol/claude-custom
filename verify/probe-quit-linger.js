'use strict';
/**
 * PROBE: how long the app's OWN Electron processes stay after a quit (BACKLOG #74 A, audit B14). (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-quit-linger.js [--cycles 10] [--load] [--condition tab] [--watch 60]
 *                                                                    [--out <file.json>] [--bound <s>]
 *
 * verify/probe-electron-zombies.js showed a TRIVIAL Electron in the app's shape leaves nothing behind (0 of 35, PR #130). This one runs
 * the real app (app/main.js, a temp container project, the host's `claude` is cmd.exe so nothing bills) and quits it the way a person
 * does: the window's close (the probe driver's winClose, which is win.close()), then the app's own quit path (window-all-closed ->
 * app.quit() -> will-quit). From the moment the close is asked it records:
 *   - every process of that launch, with its type read from its command line WHILE it is readable (browser, gpu-process, renderer,
 *     utility, crashpad-handler; the session hosts, which by design outlive the window, are listed apart as `host`);
 *   - when each one leaves the process table, sampled every 250 ms by one long-running PowerShell (Get-Process by pid: the snapshot
 *     the table is read from, no handle opened on the process, so the sampling cannot hold anything open);
 *   - its thread and handle counts along the way (1 thread / 0 handles is the "zombie" shape #74 A saw);
 *   - when the root's own exit was reported to this process (the process object signalled: really ended, not just listed).
 * The number is the time from the close asked to the last app process gone, per type.
 *
 * --load runs `node --test --test-concurrency=2` over a dozen of the repo's test files beside it, over and over, for the whole run
 * (under this probe's own heavy lock, which its children inherit).
 * --condition picks what the window has open when it is closed (step 2 of the lane): tab (the default: one tab, its host started),
 * notab (closed as soon as the strip is up, before any host answered), panel (the Resources side panel docked), chat (the chat view on),
 * video (a looping background video in the strip). A condition the driver can't set up is reported, and the cycle still measured.
 * --bound S: also FAIL a cycle whose last app process is still listed S seconds after the close (the regression form).
 *
 * --ecore-load: one busy-loop node per efficiency core, pinned to it, at BelowNormal (P-cores and normal-priority work untouched);
 * --interleave: cycle 1 of every condition, then cycle 2, ... so the arms share the machine's state; a condition "<what>:boost" is
 * the diagnostic arm that sets every thread of that launch's own Electron processes back to normal priority right after the close.
 * The app's quit timeline (app/quit-log.js, CLAUDE_CUSTOM_QUIT_LOG) is on in every cycle unless --no-quit-log.
 *
 * RESULTS 2026-11-07 (Katana, i7-13620H: logical processors 0-11 P-cores, 12-15 E-cores; other lanes busy all afternoon):
 *   - the app's JavaScript quit (window close event -> closed -> window-all-closed -> before-quit -> will-quit, every listener ->
 *     process exit) took 20-80 ms in all 50 logged cycles; everything after is Chromium's native teardown.
 *   - one tab, no load of mine, 10 cycles: last app process gone median 19.3 s, max 44.4 s, 1 still there at 60 s; with
 *     `--load`, 10 cycles: median 23.3 s, max 52.6 s, 3 still there at 60 s. An hour later every condition (notab, panel, chat
 *     asked, video) went in 0.25-2.1 s: the conditions don't matter, the machine's state does.
 *   - the lingering threads are Ready, not waiting: the gpu-process's last 24-25 at priority 1-4, the renderers', utility's and
 *     browser's last one at 4. Under --ecore-load (total CPU 34-76 %): plain close >60 s in 5 of 5; the :boost arm 1.1-2.3 s,
 *     5 of 5. A kill by pid doesn't help (the killed root stayed listed, "stuck", every time under the load).
 *   - the trivial Electron under --ecore-load didn't draw its window in 120 s (4 of 4; it lacks the app's
 *     disable-renderer-backgrounding) and its killed tree stayed listed; with the E-cores free it came and went in 1.6-1.9 s.
 *
 * SAFE: every launch goes through verify/lib/launch-electron.js (ELECTRON_RUN_AS_NODE and the enclosing tab's CLAUDE_CUSTOM_* stripped,
 * the probe mark, the ledger, the exit sweep). The hosts this run started are ended at each cycle's end through seen-pids (a recorded
 * start, proven again in the kill call). A lingering process is NOT killed (a terminating process ignores it, and no handle is held to
 * prove the pid is still ours): it is measured, and the cycle waits for it, bounded, and reports the ones still there.
 */

const { execFileSync, spawn } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const census = require('./lib/proc-census');
const { readIdentity } = require('../host/host-identity');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const { snapshotFile } = require('./lib/file-snapshot');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const CYCLES = Number(argOf('cycles', 10));
const LOAD = process.argv.includes('--load');
const ECORE_LOAD = process.argv.includes('--ecore-load');
const INTERLEAVE = process.argv.includes('--interleave');
// One condition or a comma-separated list (each gets --cycles cycles, in order).
const CONDITIONS = String(argOf('condition', 'tab')).split(',').map(s => s.trim()).filter(Boolean);
const WATCH_S = Number(argOf('watch', 60));
const BOUND_S = argOf('bound', null) === null ? null : Number(argOf('bound', null));
const OUT = argOf('out', null);
// The app's quit timeline (app/quit-log.js), one file per cycle in its temp folder; --no-quit-log runs the app without it.
const QUIT_LOG = !process.argv.includes('--no-quit-log');
const BOOST = process.argv.includes('--boost');
// One Chromium switch handed to the app's Electron (step 3's comparisons, for example --app-arg --disable-gpu).
const APP_ARG = argOf('app-arg', null) || (process.argv.indexOf('--app-arg') > 0 ? process.argv[process.argv.indexOf('--app-arg') + 1] : null);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

// The type of one row, from its command line (readable only while the process runs normally).
function classify(cmd, isRoot) {
  if (!cmd) return 'unreadable';
  const m = /--type=([^\s"]+)/.exec(cmd);
  if (m) return m[1];
  if (isRoot) return 'browser';
  if (/host[\\/]host\.js/i.test(cmd)) return 'host';
  if (/bounded-watchdog\.js/i.test(cmd)) return 'host-watchdog';
  const s = /([\w.-]+\.js)/.exec(cmd);
  return s ? `node:${s[1]}` : 'node';
}

// The whole table with command lines (one CIM query), for the tree at launch.
function queryTree() {
  const script = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f $_.ProcessId,$_.ParentProcessId,$_.ThreadCount,$_.HandleCount,[int]($_.PrivatePageCount/1MB),$_.CreationDate.ToFileTimeUtc(),$_.Name,$_.CommandLine }; 'END'";
  let out;
  try { out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
  if (!/^END\s*$/m.test(out)) return null;
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.split('|');
    if (p.length < 7) continue;
    const [pid, ppid, thr, hnd, priv] = p.slice(0, 5).map(Number);
    if (![pid, ppid, thr, hnd, priv].every(Number.isFinite) || !/^\d+$/.test(p[5])) continue;
    rows.push({ pid, ppid, thr, hnd, privMB: priv, start: p[5], name: p[6], cmd: p.slice(7).join('|') });
  }
  return rows;
}

// One PowerShell that samples the given pids every 250 ms until none is listed or the watch ends. Get-Process -Id reads the
// system's process snapshot: no handle is opened on the processes, so the sampling can't keep one alive.
function startSampler(pids, watchS) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$ids = @(${pids.join(',')})`,
    '$n = 0',
    `$end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ${Math.round(watchS * 1000)}`,
    'while ($true) {',
    '  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  $ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)',
    '  $line = "T|$t"',
    // Base priority and the threads' states and current priorities come from the same snapshot (no handle opened).
    "  foreach ($p in $ps) { $th = @($p.Threads); $ready = @($th | Where-Object { [string]$_.ThreadState -eq 'Ready' }).Count; $run = @($th | Where-Object { [string]$_.ThreadState -eq 'Running' }).Count; $pr = @($th | ForEach-Object { $_.CurrentPriority } | Sort-Object); $line += ('|{0},{1},{2},{3},{4},{5},{6},{7},{8}' -f $p.Id,$th.Count,$p.HandleCount,[int]($p.PrivateMemorySize64/1MB),$p.BasePriority,$ready,$run,($(if ($pr.Count) { $pr[0] } else { '' })),($(if ($pr.Count) { $pr[-1] } else { '' }))) }",
    '  if (($n++ % 8) -eq 0) { $line += ("|cpu," + (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average) }',
    '  [Console]::Out.WriteLine($line); [Console]::Out.Flush()',
    '  if ($ps.Count -eq 0 -or $t -gt $end) { break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    "[Console]::Out.WriteLine('DONE')",
  ].join('\n');
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  noteChild(child);
  const samples = [];
  let buf = '';
  let firstResolve;
  const first = new Promise((r) => { firstResolve = r; });
  const done = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('T|')) continue;
        const parts = line.split('|');
        const t = Number(parts[1]);
        const rows = new Map();
        let cpu = null;
        for (const p of parts.slice(2)) {
          if (p.startsWith('cpu,')) { cpu = Number(p.slice(4)); continue; }
          const [pid, thr, hnd, priv, base, ready, running, minPri, maxPri] = p.split(',').map(Number);
          rows.set(pid, { thr, hnd, privMB: priv, base, ready, running, minPri, maxPri });
        }
        samples.push({ t, rows, cpu });
        firstResolve();
      }
    });
    child.on('exit', () => { firstResolve(); resolve(); });
  });
  return { child, samples, first, done };
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function waitFor(fn, ms = 20000, step = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

function command(app, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
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
}
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

async function launchApp(tmp, dev, userData, quitLogFile) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_')));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: dev,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  const keepEnv = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'];
  if (quitLogFile) { env.CLAUDE_CUSTOM_QUIT_LOG = quitLogFile; keepEnv.push('CLAUDE_CUSTOM_QUIT_LOG'); }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`, ...(APP_ARG ? [APP_ARG] : [])], { cwd: ROOT, env }, { keepEnv, label: 'probe-quit-linger' });
  const app = { port, token, child, dev, out: '', exited: false, exitAt: null };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; app.exitAt = Date.now(); });
  await child.ledgered;
  return app;
}

// The trivial Electron of verify/probe-electron-zombies.js (PR #130): one window, 3 WebContentsViews on data: pages, none of this
// app's code; it closes its views and window and calls app.exit(0) when its quit file appears.
async function launchTrivial(tmp, userData) {
  const quitFile = path.join(tmp, 'trivial-quit');
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [path.join(__dirname, 'probe-electron-zombies.js'), `--user-data-dir=${userData}`],
    { cwd: ROOT, env: { ...process.env, CC_ZOMBIE_VIEWS: '3', CC_ZOMBIE_QUIT: quitFile } }, { label: 'probe-quit-linger trivial' });
  const app = { child, quitFile, out: '', exited: false, exitAt: null };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; app.exitAt = Date.now(); });
  await child.ledgered;
  return app;
}

// --boost: one PowerShell that, every 100 ms until none is listed, sets every thread of the given pids (this launch's own
// Electron processes, read from its tree at launch) to the normal priority of its process (ProcessThread.PriorityLevel opens and
// closes a thread handle per set). A diagnostic only.
function startBooster(pids, watchS) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$ids = @(${pids.join(',')})`,
    `$end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ${Math.round(watchS * 1000)}`,
    '$ok = 0; $bad = 0; $rounds = 0',
    'while ($true) {',
    '  $ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)',
    '  if ($ps.Count -eq 0 -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt $end) { break }',
    '  $rounds++',
    "  foreach ($p in $ps) { foreach ($t in @($p.Threads)) { try { $t.PriorityLevel = 'Normal'; $ok++ } catch { $bad++ } } }",
    '  Start-Sleep -Milliseconds 100',
    '}',
    "[Console]::Out.WriteLine(\"BOOST|$rounds|$ok|$bad\")",
  ].join('\n');
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  noteChild(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const done = new Promise((resolve) => child.on('exit', resolve));
  const summary = () => {
    const m = /BOOST\|(\d+)\|(\d+)\|(\d+)/.exec(out);
    return m ? `${m[1]} rounds, ${m[2]} thread priorities set, ${m[3]} refused` : 'no report';
  };
  return { child, done, summary };
}

// Hosts whose identity file names a cwd inside this run's temp folder.
function hostsOf(tmp) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (id && id.cwd && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}

// What the window has open when it is closed. Returns a word for the report.
async function setUp(app, condition) {
  if (condition === 'notab') return 'closed as soon as the strip answered';
  const ready = await waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 45000);
  if (!ready) return 'NOT READY: the tab never started';
  if (condition === 'panel') {
    const r = await view(app, 'dock', { id: 'resources', target: { edge: 'right' } });
    const shown = await waitFor(async () => { const s = await view(app, 'resourcesState'); return s && s.shown ? s : null; }, 10000, 200);
    return shown ? 'Resources panel docked' : `panel NOT shown (${JSON.stringify(r).slice(0, 120)})`;
  }
  if (condition === 'chat') {
    const r = await view(app, 'chatDo', { what: 'toggle' });
    const on = await waitFor(async () => { const s = await view(app, 'chatState'); return s && s.ok && s.shown ? s : null; }, 10000, 200);
    return on ? 'chat view on' : `chat view NOT on (${JSON.stringify(r).slice(0, 120)})`;
  }
  if (condition === 'video') {
    // A looping test video as the tab's background (the host copies it into the temp project's own state), as
    // verify/probe-video-background.js makes it.
    const webm = path.join(path.dirname(path.dirname(app.dev)), 'background.webm');
    const made = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=3',
      '-c:v', 'libvpx-vp9', '-b:v', '400k', '-pix_fmt', 'yuv420p', webm], { windowsHide: true, encoding: 'utf8' }).status === 0;
    if (!made) return 'video NOT set up (ffmpeg could not make it)';
    await view(app, 'bgStyle', { action: 'set-background', path: webm });
    const playing = await waitFor(async () => { const s = await view(app, 'bgState'); return s && s.video && s.video.readyState >= 2 && !s.video.paused ? s : null; }, 15000, 300);
    return playing ? 'background video playing' : 'video NOT playing';
  }
  await sleep(1500);
  return 'one tab, its host started';
}

// --ecore-load: one busy-looping node per efficiency core, pinned to it and at BelowNormal priority (so normal-priority work,
// a person's included, still goes first, and the P-cores stay free). Each ends itself after maxMs whatever happens. The cores are
// read from the system's CPU sets (EfficiencyClass 0 on a hybrid CPU). Returns a stop function, or null when there are none.
function startEcoreLoad(maxMs) {
  const cpuScript = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class CccCpuSets { [DllImport("kernel32.dll")] static extern bool GetSystemCpuSetInformation(IntPtr i, uint l, out uint r, IntPtr p, uint f);',
    '  public static string E() { uint len; GetSystemCpuSetInformation(IntPtr.Zero, 0, out len, IntPtr.Zero, 0); IntPtr b = Marshal.AllocHGlobal((int)len);',
    '    try { if (!GetSystemCpuSetInformation(b, len, out len, IntPtr.Zero, 0)) return ""; var s = new System.Text.StringBuilder(); int o = 0; byte maxEff = 0;',
    '      while (o < len) { byte e = Marshal.ReadByte(b, o + 18); if (e > maxEff) maxEff = e; o += Marshal.ReadInt32(b, o); }',
    '      if (maxEff == 0) return ""; o = 0;',
    '      while (o < len) { if (Marshal.ReadByte(b, o + 18) == 0) s.Append(Marshal.ReadByte(b, o + 14)).Append(","); o += Marshal.ReadInt32(b, o); }',
    '      return s.ToString(); } finally { Marshal.FreeHGlobal(b); } } }',
    '"@',
    '[CccCpuSets]::E()',
  ].join('\n');
  let lps = [];
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', cpuScript], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    lps = out.trim().split(',').filter(x => /^\d+$/.test(x)).map(Number);
  } catch { lps = []; }
  if (!lps.length) { console.log('ecore-load: no efficiency cores found; no load'); return null; }
  const spinners = lps.map(() => noteChild(spawn(process.execPath, ['-e', `const end = Date.now() + ${maxMs}; while (Date.now() < end) {}`], { stdio: 'ignore', windowsHide: true })));
  // Pin and lower them (these are this probe's own children, by the pids it just spawned).
  const pin = spinners.map((s, i) => `$p = Get-Process -Id ${s.pid}; $p.ProcessorAffinity = [IntPtr]${2 ** lps[i]}; $p.PriorityClass = 'BelowNormal'`).join('; ');
  try { execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${pin}`], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch (err) {
    console.log(`ecore-load: could not pin the spinners (${err && err.message}); stopping them, no load`);
    for (const s of spinners) { try { s.kill(); } catch { /* gone */ } }   // kill-ok(held-handle): the spinners this probe spawned
    return null;
  }
  console.log(`ecore-load: ${spinners.length} spinners on logical processors ${lps.join(',')}, BelowNormal, each ends itself within ${Math.round(maxMs / 60000)} min`);
  return async () => {
    for (const s of spinners) if (s.exitCode === null) { try { s.kill(); } catch { /* gone */ } }   // kill-ok(held-handle): the spinners this probe spawned
    await Promise.all(spinners.map(s => new Promise((r) => { if (s.exitCode !== null) r(); else { s.once('exit', r); setTimeout(r, 5000); } })));
  };
}

// A loop of `node --test` over a dozen test files, for --load. Returns a stop function.
function startLoad() {
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js'));
  const pick = [...files.filter(f => /properties/.test(f)).slice(0, 8), ...files.filter(f => !/properties/.test(f)).slice(0, 4)].map(f => path.join('test', f));
  let stopped = false;
  let current = null;
  let runs = 0;
  const loop = () => {
    if (stopped) return;
    current = spawn(process.execPath, ['--test', '--test-concurrency=2', ...pick], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
    noteChild(current);
    runs++;
    current.on('exit', () => { current = null; setTimeout(loop, 100); });
  };
  loop();
  console.log(`load: node --test --test-concurrency=2 over ${pick.length} files, looped`);
  return async () => {
    stopped = true;
    if (current) {
      const c = current;
      try { require('../host/kill-tree').killPidTree(c.pid); } catch { /* gone */ }   // kill-ok(held-handle): the load child this probe spawned, handle held
      await new Promise((r) => { if (c.exitCode !== null) r(); else { c.once('exit', r); setTimeout(r, 10000); } });
    }
    return runs;
  };
}

// Per process: when it was first missing from the samples (s after the close), the longest 1-thread/0-handle stretch, the
// thread/handle path (only the changes).
function summarise(tracked, samples, t0) {
  return tracked.map((p) => {
    let goneAt = null;
    let zombieFrom = null;
    let zombieS = 0;
    const path_ = [];
    let last = null;
    for (const s of samples) {
      if (s.t < t0) continue;
      const r = s.rows.get(p.pid);
      if (!r) { goneAt = (s.t - t0) / 1000; break; }
      // base = the process's base priority; ready/run = threads in those states; pri = the threads' current priorities, min-max.
      const key = `${r.thr}/${r.hnd}/${r.base}/${r.ready}/${r.minPri}`;
      if (key !== last) { path_.push(`${((s.t - t0) / 1000).toFixed(2)}s:${r.thr}t/${r.hnd}h/${r.privMB}MB/b${r.base}/r${r.ready}/run${r.running}/p${r.minPri}-${r.maxPri}`); last = key; }
      if (r.thr <= 1 && r.hnd === 0) { if (zombieFrom === null) zombieFrom = s.t; zombieS = (s.t - zombieFrom) / 1000; } else zombieFrom = null;
    }
    return { pid: p.pid, type: p.type, privMBBefore: p.privMB, goneAfterS: goneAt, zombieS, path: path_ };
  });
}

// The app's quit log (app/quit-log.js) as "<s after the close> <step>", in order.
function readTimeline(file, t0) {
  if (!file || t0 === null) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map(l => /^(\d+) (.*)$/.exec(l)).filter(Boolean)
    .map(m => `${((Number(m[1]) - t0) / 1000).toFixed(2)}s ${m[2]}`);
}

async function cycle(c, tmpBase, condition) {
  const tmp = fs.mkdtempSync(path.join(tmpBase, `c${c}-`));
  const dev = path.join(tmp, 'proj', 'dev');
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  const userData = path.join(tmp, 'user-data');
  const seenPids = require('./lib/seen-pids').createSeenPids();
  let app = null;
  let sampler = null;
  let t0 = null;
  let rootStart = null;
  let booster = null;
  const quitLogFile = QUIT_LOG ? path.join(tmp, 'quit.log') : null;
  // A condition is "<what>[:boost]": the suffix turns on the --boost diagnostic for that condition's cycles only.
  const [what, suffix] = condition.split(':');
  const boost = BOOST || suffix === 'boost';
  const trivial = what === 'trivial';
  try {
    let cond;
    if (trivial) {
      app = await launchTrivial(tmp, userData);
      // Under --ecore-load its renderers start on the busy E-cores (it has no disable-renderer-backgrounding): it is given longer.
      const up = await waitFor(() => /TREE-UP/.test(app.out), ECORE_LOAD ? 120000 : 30000, 200);
      if (!up) { check(`cycle ${c}: the trivial tree came up`, false, app.out.slice(-400)); return null; }
      await sleep(1000);   // its gpu / utility children settle into the table, as verify/probe-electron-zombies.js waits
      cond = 'the trivial Electron of verify/probe-electron-zombies.js, 3 views, its own close (views, window, app.exit(0))';
    } else {
      app = await launchApp(tmp, dev, userData, quitLogFile);
      const strip = await waitFor(async () => { const st = await command(app, { cmd: 'state' }, 5000); return st && st.hosts ? st : null; }, 45000, 300);
      if (!strip) { check(`cycle ${c}: the window came up`, false, app.out.slice(-400)); return null; }
      cond = await setUp(app, what);
    }
    await sleep(500);
    const rows = queryTree();
    const tree = rows ? census.descendantsOf(rows, app.child.pid) : [];
    if (!tree.length) { check(`cycle ${c}: the tree was read before the close`, false); return null; }
    rootStart = tree.find(r => r.pid === app.child.pid).start;
    // The host subtrees are listed apart: by design they outlive the window ("closing the window detaches").
    const hostPids = new Set(tree.filter(r => /host[\\/]host\.js/i.test(r.cmd)).map(r => r.pid));
    // A host found in this launch's tree is ours now: its start is read now (seen-pids' early sighting), so the cleanup can end it.
    // see() first: an add() with no start would make the entry, and see() never reads over one (verify/lib/seen-pids.js).
    for (const pid of hostPids) seenPids.see(pid);
    // Then any start their identity file recorded while they were ours.
    for (const id of hostsOf(tmp)) seenPids.add(id.pid, id.processStartedAt);
    let grew = true;
    while (grew) { grew = false; for (const r of tree) if (!hostPids.has(r.pid) && hostPids.has(r.ppid)) { hostPids.add(r.pid); grew = true; } }
    const appProcs = tree.filter(r => !hostPids.has(r.pid) && r.name.toLowerCase() === 'electron.exe')
      .map(r => ({ pid: r.pid, privMB: r.privMB, type: classify(r.cmd, r.pid === app.child.pid) }));
    const others = tree.filter(r => !hostPids.has(r.pid) && r.name.toLowerCase() !== 'electron.exe');
    const hostProcs = tree.filter(r => hostPids.has(r.pid) && r.name.toLowerCase() === 'electron.exe').map(r => ({ pid: r.pid, type: classify(r.cmd, false) }));
    const watched = [...appProcs, ...others.map(r => ({ pid: r.pid, privMB: r.privMB, type: `other:${r.name}` }))];

    sampler = startSampler(watched.map(p => p.pid), WATCH_S);
    await sampler.first;
    t0 = Date.now();
    let closed;
    if (trivial) { fs.writeFileSync(app.quitFile, 'quit'); closed = { ok: true }; } else closed = await command(app, { cmd: 'win-close' }, 5000);
    // --boost (a diagnostic, never the app's behaviour): this launch's own Electron processes get their threads set back to normal
    // priority while they exit. If the linger goes, the exiting threads were starved, not blocked.
    booster = boost ? startBooster(appProcs.map(p => p.pid), WATCH_S) : null;
    await sampler.done;
    if (booster) { await booster.done; console.log(`    boost: ${booster.summary()}`); }
    const rootExitS = app.exitAt ? (app.exitAt - t0) / 1000 : null;
    const sum = summarise(watched, sampler.samples, t0);
    const lastGone = sum.every(r => r.goneAfterS !== null) ? Math.max(...sum.map(r => r.goneAfterS)) : null;
    const cpus = sampler.samples.filter(s => s.cpu !== null && Number.isFinite(s.cpu)).map(s => s.cpu);
    const cpuAvg = cpus.length ? Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) : null;
    console.log(`    machine CPU during the watch: ${cpuAvg === null ? 'not read' : `${cpuAvg}% average (${cpus.join(' ')})`}`);
    const line = sum.map(r => `${r.type}:${r.goneAfterS === null ? `>${WATCH_S}` : r.goneAfterS.toFixed(2)}s${r.zombieS ? `(z${r.zombieS.toFixed(1)})` : ''}`).join(' ');
    check(`cycle ${c}: measured ${watched.length} processes [${cond}]`, sampler.samples.length > 0,
      `close ${closed && closed.ok ? 'ok' : JSON.stringify(closed)}; root exit event ${rootExitS === null ? 'none' : rootExitS.toFixed(2) + 's'}; last gone ${lastGone === null ? `>${WATCH_S}` : lastGone.toFixed(2) + 's'}; ${line}`);
    if (BOUND_S !== null) check(`cycle ${c}: the last app process is gone within ${BOUND_S} s of the close`, lastGone !== null && lastGone <= BOUND_S, lastGone === null ? 'still listed' : `${lastGone.toFixed(2)} s`);
    const left = sum.filter(r => r.goneAfterS === null);
    if (left.length) console.log(`  cycle ${c}: still listed at ${WATCH_S}s, left to exit (not killed): ${left.map(r => `${r.type}:${r.pid}`).join(' ')}`);
    for (const r of sum) if (r.goneAfterS === null || r.goneAfterS > 3 || r.zombieS > 0) console.log(`    ${r.type} ${r.pid} ${r.privMBBefore}MB: ${r.path.join(' ')}${r.goneAfterS !== null ? ` gone ${r.goneAfterS.toFixed(2)}s` : ''}`);
    const timeline = readTimeline(quitLogFile, t0);
    if (timeline.length) console.log(`    quit log: ${timeline.join(' | ')}`);
    const tail = app.out.split(/\r?\n/).filter(Boolean).slice(-6);
    if (rootExitS === null && tail.length) console.log(`    the app's last output: ${tail.join(' / ').slice(0, 600)}`);
    return { cycle: c, condition, cond, load: LOAD, appArg: APP_ARG, cpuAvg, rootExitS, lastGone, hosts: hostProcs.length, timeline, procs: sum };
  } finally {
    if (sampler && sampler.child.exitCode === null) { try { sampler.child.kill(); } catch { /* gone */ } }   // kill-ok(held-handle): the sampler this probe spawned
    if (booster && booster.child.exitCode === null) { try { booster.child.kill(); } catch { /* gone */ } }   // kill-ok(held-handle): the booster this probe spawned
    if (app && !app.exited) {
      const { stopElectron } = require('./lib/launch-electron');
      // The child handle is held, so the launcher's stop is by proven pid.
      const killedAt = Date.now();
      const r = await stopElectron({ child: app.child, pid: app.child.pid }, { politeMs: 0, graceMs: 20000 });
      console.log(`    the root was still running at the end of the watch: stopped by its pid (${r.how}${app.exitAt ? `, its exit ${((app.exitAt - killedAt) / 1000).toFixed(2)} s after the kill` : ''})`);
    }
    // A host that started after the tree was read (the notab close races its start) is found the same way: an electron.exe
    // running this worktree's host.js whose parent is this launch's root and which started after it (verify/lib/proc-census.js's
    // tree rule). Its start is read now, while that row says it is ours.
    if (app && rootStart) {
      for (const r of queryTree() || []) {
        if (r.ppid === app.child.pid && /host[\\/]host\.js/i.test(r.cmd) && BigInt(r.start) >= BigInt(rootStart)) seenPids.see(r.pid);
      }
    }
    for (const id of hostsOf(tmp)) seenPids.add(id.pid, id.processStartedAt);
    const { left } = seenPids.endAll();
    if (left.length) console.log(`  cycle ${c}: hosts not ended: ${left.join(' ')}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
  }
}

async function main() {
  if (process.platform !== 'win32') { console.log('SKIP: reads the Windows process table'); return 0; }
  const LAYOUT_FILE = path.join(STATE_DIR, 'layout-global.json');
  const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
  const snaps = [snapshotFile(LAYOUT_FILE), snapshotFile(TREE_FILE)];
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-quit-linger-'));
  const stopLoad = LOAD ? startLoad() : null;
  // The spinners' own end: the longest a cycle can take (a 120 s start wait under this load, the watch, a 20 s stop, the setup),
  // for every cycle, and never more than 30 minutes. (Sized at the watch + 40 s first, they ended mid-run on 2026-11-07.)
  const stopEcore = ECORE_LOAD ? startEcoreLoad(Math.min(30 * 60000, (CYCLES * CONDITIONS.length * (WATCH_S + 200) + 60) * 1000)) : null;
  const results = [];
  // --interleave: cycle 1 of every condition, then cycle 2 of every condition, ... so the arms share the machine's state.
  const order = [];
  if (INTERLEAVE) { for (let c = 1; c <= CYCLES; c++) for (const condition of CONDITIONS) order.push([c, condition]); }
  else { for (const condition of CONDITIONS) for (let c = 1; c <= CYCLES; c++) order.push([c, condition]); }
  try {
    if (stopLoad || stopEcore) await sleep(3000);
    for (const [c, condition] of order) {
      for (const f of [LAYOUT_FILE, TREE_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
      if (CONDITIONS.length > 1) console.log(`-- ${condition}`);
      const r = await cycle(c, tmpBase, condition);
      if (r) results.push(r);
      await sleep(1000);
    }
  } finally {
    if (stopEcore) await stopEcore();
    if (stopLoad) console.log(`load: ${await stopLoad()} test runs`);
    for (const s of snaps) s.restore();
    try { fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
  }

  // Per condition, per type over its cycles: count, median and max time gone (s after the close), how many were zombie-shaped.
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
  for (const condition of CONDITIONS) {
    const rs = results.filter(r => r.condition === condition);
    const byType = {};
    for (const r of rs) for (const p of r.procs) {
      const v = byType[p.type] || (byType[p.type] = { n: 0, gone: [], still: 0, zombie: 0 });
      v.n++;
      if (p.goneAfterS === null) v.still++; else v.gone.push(p.goneAfterS);
      if (p.zombieS > 0) v.zombie++;
    }
    console.log(`\n== ${rs.length}/${CYCLES} cycles, condition=${condition}, load=${LOAD ? 'on' : 'off'}${ECORE_LOAD ? ', E-core load' : ''}${APP_ARG ? `, app arg ${APP_ARG}` : ''}${BOOST ? ', BOOST (diagnostic)' : ''}; seconds from the window's close to gone from the table`);
    for (const [type, v] of Object.entries(byType).sort()) {
      console.log(`   ${type.padEnd(22)} x${String(v.n).padEnd(3)} median ${med(v.gone) === null ? '-' : med(v.gone).toFixed(2)}  max ${v.gone.length ? Math.max(...v.gone).toFixed(2) : '-'}  still there ${v.still}  zombie-shaped ${v.zombie}`);
    }
    const lasts = rs.map(r => r.lastGone).filter(x => x !== null);
    const roots = rs.map(r => r.rootExitS).filter(x => x !== null);
    console.log(`   last app process gone:  median ${med(lasts) === null ? '-' : med(lasts).toFixed(2)}  max ${lasts.length ? Math.max(...lasts).toFixed(2) : '-'}  (${rs.length - lasts.length} never)  per cycle: ${rs.map(r => (r.lastGone === null ? `>${WATCH_S}` : r.lastGone.toFixed(1))).join(' ')}`);
    console.log(`   root exit event:        median ${med(roots) === null ? '-' : med(roots).toFixed(2)}  max ${roots.length ? Math.max(...roots).toFixed(2) : '-'}`);
    console.log(`   set up as: ${[...new Set(rs.map(r => r.cond))].join('; ')}`);
  }
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(results, null, 1)); console.log(`   raw: ${OUT}`); }
  check('every cycle was measured', results.length === CYCLES * CONDITIONS.length, `${results.length}/${CYCLES * CONDITIONS.length}`);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err && err.stack || err); process.exit(1); });
}

module.exports = { classify, summarise };
