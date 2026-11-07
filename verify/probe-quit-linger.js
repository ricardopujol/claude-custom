'use strict';
/**
 * PROBE: how long the app's OWN Electron processes stay after a quit (BACKLOG #74 A, audit B14). (re-runnable)
 *
 *   node verify/probe-quit-linger.js [--cycles 10] [--watch 60] [--condition tab[,notab,panel,chat,video,trivial][:boost]]
 *                                    [--load] [--ecore-load] [--interleave] [--bound <s>] [--out <file.json>]
 *                                    [--app-arg <one Chromium switch>] [--no-quit-log]
 *
 * It takes the machine's heavy lock itself (requiring verify/lib/launch-electron.js does), so it needs no wrapper; under
 * `node scripts/with-heavy-lock.js` it is re-entrant. Flags are checked before the lock is taken.
 *
 * verify/probe-electron-zombies.js showed a TRIVIAL Electron in the app's shape leaves nothing behind on a quiet machine (0 of 35,
 * PR #130). This one runs the real app (app/main.js, a temp container project, the host's `claude` is cmd.exe so nothing bills) and
 * quits it the way a person does: the window's close (the probe driver's win-close, which is win.close()), then the app's own quit
 * path (window-all-closed -> app.quit() -> will-quit). A close that didn't start a quit (the app still answers 5 s later: hidden to the
 * tray, or the quit held) is a FAIL of that cycle and not a number, as is a close that wasn't done, and a condition that wasn't set up.
 * From the moment the close is asked it records:
 *   - every process of that launch, with its type read from its command line WHILE it is readable (browser, gpu-process, renderer,
 *     utility; the session hosts, which by design outlive the window, are listed apart and not measured);
 *   - when each one leaves the process table: one long-running PowerShell samples them about every 250 ms (`Get-Process -Id`, plus
 *     each one's StartTime, which opens and closes a query handle, so a pid Windows has handed to a stranger is "gone", not "still
 *     listed"; verify/lib/quit-linger.js rowIsTracked). The watch runs until every one is gone, or until a sample at least --watch s
 *     after the close (the deadline is counted from the close, in Node);
 *   - its thread and handle counts, base priority, and how many of its threads are Ready, with their priority range;
 *   - the app's quit timeline (app/quit-log.js, CLAUDE_CUSTOM_QUIT_LOG), unless --no-quit-log.
 * The number is the time from the close asked to the last app process gone. Medians and maxima count the cycles still running at the
 * end of the watch as larger than every finished one (">watch"), never drop them.
 *
 * --condition: tab (one tab, its host started), notab (closed as soon as the strip answers), panel (the Resources panel docked), chat
 *   (the chat toggle; it reports `shown` only with a session reply, which the cmd.exe host never gives, so chat FAILs its set-up check
 *   by design), video (a looping VP9 background, made with ffmpeg), trivial (verify/probe-electron-zombies.js's trivial Electron).
 *   A ":boost" suffix is the diagnostic arm: right after the close, every thread of that launch's own Electron processes is set back to
 *   normal priority, each process proven by its start time before it is touched.
 * --load: `node --test --test-concurrency=2` over a dozen test files, looped beside the app.
 * --ecore-load: one busy-loop node per efficiency core, pinned to it, at BelowNormal (P-cores and normal-priority work untouched), for
 *   the whole run; each cycle records whether every spinner was still running at its close, and the summary counts the loaded ones.
 * --interleave: cycle 1 of every condition, then cycle 2, ... so the arms share the machine's state.
 * --bound S: also FAIL a cycle whose last app process is still listed S s after the close (the regression form).
 *
 * THE CHECKOUT'S STATE. Each cycle removes this checkout's .harness/state/layout-global.json and layout-tree.json (the host reads them
 * from a fixed path), so the probe REFUSES to run while a live host is open on this checkout, and puts both files back on every way
 * out: the end of the run, process exit, and Ctrl+C (the launcher's signal sweep exits, which runs the exit handler).
 *
 * RESULTS 2026-11-07 (Katana, i7-13620H: logical processors 0-11 P-cores, 12-15 E-cores; other lanes busy all afternoon). The
 * medians below are recomputed with the cycles that never finished counted as ">60" (PR #242 Dexter 3):
 *   - the app's JavaScript quit (window close event -> closed -> window-all-closed -> before-quit -> will-quit, every listener ->
 *     process exit) took 20-80 ms in all 50 logged cycles; everything after is Chromium's native teardown.
 *   - one tab, no load of mine, 10 cycles: last app process gone median 19.3 s, max >60 (1 of 10); with `--load`, 10 cycles: median
 *     27.4 s, max >60 (3 of 10). An hour later every condition (notab, panel, chat asked, video) went in 0.25-2.1 s.
 *   - the lingering threads are Ready, not waiting: the gpu-process's last 24-25 at priority 1-4, the renderers', utility's and
 *     browser's last one at 4. Under --ecore-load: plain close >60 s in 5 of 5; the :boost arm 1.1-2.3 s, 5 of 5. A kill by pid
 *     doesn't help (the killed root stayed listed, "stuck", every time under the load).
 *   - the trivial Electron under --ecore-load didn't draw its window in 120 s (4 of 4; it lacks the app's
 *     disable-renderer-backgrounding) and its killed tree stayed listed; with the E-cores free it came and went in 1.6-1.9 s.
 *
 * SAFE: every Electron goes through verify/lib/launch-electron.js (ELECTRON_RUN_AS_NODE and the enclosing tab's CLAUDE_CUSTOM_*
 * stripped, the probe mark, the ledger, the exit sweep). Hosts are ended only through seen-pids with a start recorded from the process
 * table while the row was provably this launch's (verify/lib/quit-linger.js adoptableHosts: this worktree's host.js, a child of the
 * root while the root's handle is held or started before the root's exit, and an identity file carrying this probe's mark), and the
 * kill proves that start again on a held handle. A lingering process is NOT killed: it is measured, and reported.
 */

const path = require('path');
const fs = require('fs');

// ---- flags: checked before the launcher is required (it takes the heavy lock on load) -----------------------------------------
function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function badFlag(msg) { console.error(`probe-quit-linger: ${msg}`); process.exit(2); }
function positive(name, dflt, { integer = false } = {}) {
  const raw = argValue(name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) badFlag(`--${name} needs a positive ${integer ? 'whole ' : ''}number, not ${JSON.stringify(raw)}`);
  return n;
}
const CYCLES = positive('cycles', 10, { integer: true });
const WATCH_S = positive('watch', 60);
const BOUND_S = positive('bound', null);
const OUT = argValue('out');
const LOAD = process.argv.includes('--load');
const ECORE_LOAD = process.argv.includes('--ecore-load');
const INTERLEAVE = process.argv.includes('--interleave');
const QUIT_LOG = !process.argv.includes('--no-quit-log');
const BOOST = process.argv.includes('--boost');
// One Chromium switch handed to the app's Electron (for example `--app-arg --disable-gpu`); the value may start with "--".
const APP_ARG = argValue('app-arg');
const CONDITIONS = String(argValue('condition') || 'tab').split(',').map(s => s.trim()).filter(Boolean);
const KNOWN = ['tab', 'notab', 'panel', 'chat', 'video', 'trivial'];
for (const c of CONDITIONS) {
  const [what, suffix] = c.split(':');
  if (!KNOWN.includes(what) || (suffix !== undefined && suffix !== 'boost')) badFlag(`unknown condition ${JSON.stringify(c)} (${KNOWN.join(', ')}, each optionally ":boost")`);
}
if (OUT === '' || (argValue('out') !== null && OUT.startsWith('--'))) badFlag('--out needs a file');
if (process.argv.includes('--app-arg') && !APP_ARG) badFlag('--app-arg needs a switch');
if (process.platform !== 'win32') { console.log('SKIP: reads the Windows process table'); process.exit(0); }

// ---- the rest (the launcher takes the heavy lock here, before anything is started) ---------------------------------------------
const { spawnElectron, noteChild, stopElectron, installSweep } = require('./lib/launch-electron');
const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const census = require('./lib/proc-census');
const { createSeenPids } = require('./lib/seen-pids');
const { snapshotFile } = require('./lib/file-snapshot');
const { isLiveHost } = require('./lib/live-host');
const { mark: PROBE_MARK } = require('./lib/mark-probe');
const { killProven, killPidTree } = require('../host/kill-tree');
const QL = require('./lib/quit-linger');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const STATE_DIR = path.join(HARNESS_DIR, 'state');
const LAYOUT_FILES = [path.join(STATE_DIR, 'layout-global.json'), path.join(STATE_DIR, 'layout-tree.json')];
const HOST_SCRIPT = path.join(ROOT, 'host', 'host.js');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SETTLE_MS = 5000;           // how long after the close the app's JavaScript must have stopped answering
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

// ---- the process table -----------------------------------------------------------------------------------------------------
// The whole table with command lines (one CIM query), for the tree at launch and the hosts at the end.
function queryTree() {
  const script = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f $_.ProcessId,$_.ParentProcessId,$_.ThreadCount,$_.HandleCount,[int]($_.PrivatePageCount/1MB),$_.CreationDate.ToFileTimeUtc(),$_.Name,$_.CommandLine }; 'END'";
  let out;
  try { out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
  if (!/^END\s*$/m.test(out)) return null;
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.split('|');
    if (p.length < 7) continue;
    const [pid, ppid, thr, hnd, priv] = p.slice(0, 5).map(QL.num);
    if ([pid, ppid].some(v => v === null) || !/^\d+$/.test(p[5])) continue;
    rows.push({ pid, ppid, thr, hnd, privMB: priv, start: p[5], name: p[6], cmd: p.slice(7).join('|') });
  }
  return rows;
}

// Every host identity file of this checkout, read raw: readIdentity drops `probeMark` and `processStartedAt`, which are the proof.
function readHostIds() {
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'hosts', f), 'utf8'));
      if (d && Number.isInteger(d.pid) && d.pid > 0) out.push({ pid: d.pid, cwd: d.cwd, probeMark: d.probeMark, processStartedAt: d.processStartedAt });
    } catch { /* half-written or not JSON */ }
  }
  return out;
}

// ---- the sampler ------------------------------------------------------------------------------------------------------------
// One PowerShell sampling the pids about every 250 ms until Node stops it (its own hard end is a backstop for an orphaned one). The
// machine CPU is read on every 8th sample, never on the first (a cold CIM load is 1-3 s).
function startSampler(pids) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$ids = @(${pids.join(',')})`,
    '$n = 0',
    `$hardEnd = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ${Math.round((WATCH_S + 180) * 1000)}`,
    'while ($true) {',
    '  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  $ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)',
    '  $line = "T|$t"',
    "  foreach ($p in $ps) { $th = @($p.Threads); $ready = @($th | Where-Object { [string]$_.ThreadState -eq 'Ready' }).Count; $run = @($th | Where-Object { [string]$_.ThreadState -eq 'Running' }).Count; $pr = @($th | ForEach-Object { $_.CurrentPriority } | Sort-Object); $st = ''; try { $st = [string]$p.StartTime.ToFileTimeUtc() } catch { $st = '' }; $line += ('|{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10}' -f $p.Id,$th.Count,$p.HandleCount,[int]($p.PrivateMemorySize64/1MB),$p.BasePriority,$ready,$run,($(if ($pr.Count) { $pr[0] } else { '' })),($(if ($pr.Count) { $pr[-1] } else { '' })),$st,$p.ProcessName) }",
    '  if (($n % 8) -eq 7) { $line += ("|cpu," + (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average) }',
    '  $n++',
    '  [Console]::Out.WriteLine($line); [Console]::Out.Flush()',
    '  if ($t -gt $hardEnd) { break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
  ].join('\n');
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  noteChild(child);
  const samples = [];
  const listeners = new Set();
  let ended = false;
  let error = null;
  let firstResolve;
  const first = new Promise((r) => { firstResolve = r; });
  const firstTimer = setTimeout(() => firstResolve(), 30000);          // no first sample in 30 s: the cycle FAILs, nothing hangs
  const notify = () => { for (const f of [...listeners]) f(); };
  const end = (err) => { ended = true; if (err) error = err; clearTimeout(firstTimer); firstResolve(); notify(); };
  child.on('error', (err) => end(err && err.message));
  child.on('exit', () => end(null));
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const s = QL.parseSampleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (!s) continue;
      samples.push(s);
      clearTimeout(firstTimer);
      firstResolve();
      notify();
    }
  });
  // Resolves 'gone' | 'watched' (verify/lib/quit-linger.js watchState), 'ended' (the sampler stopped by itself or failed to start),
  // or 'stalled' (no deciding sample 20 s past the deadline). The deadline is counted from t0, the close (PR #242 Dexter 4).
  const waitWatch = (t0, watchMs, tracked) => new Promise((resolve) => {
    let timer = null;
    const done = (why) => { clearTimeout(timer); listeners.delete(look); resolve(why); };
    const look = () => { const st = QL.watchState(samples, t0, watchMs, tracked); if (st) done(st); else if (ended) done('ended'); };
    timer = setTimeout(() => done('stalled'), Math.max(0, t0 + watchMs - Date.now()) + 20000);
    listeners.add(look);
    look();
  });
  const stop = () => { clearTimeout(firstTimer); if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { /* gone */ } } };   // kill-ok(held-handle): the sampler this probe spawned
  return { child, samples, first, waitWatch, stop, error: () => error };
}

// ---- the :boost diagnostic -------------------------------------------------------------------------------------------------
// Every 100 ms until none of them is left: for each { pid, start } (this launch's own Electron processes, starts from the launch-time
// table), the process's StartTime is read and compared (within 1 us, the CIM precision) BEFORE any of its threads is touched; a pid
// that is someone else's now is never written (PR #242 Dexter 2, Miguel F2). Bounded in PowerShell and from Node.
function startBooster(items) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$items = @()',
    ...items.map(it => `$items += ,@([long]${it.pid}, [long]${it.start})`),
    `$end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ${Math.round((WATCH_S + 30) * 1000)}`,
    '$ok = 0; $bad = 0; $other = 0; $rounds = 0',
    'while ($true) {',
    '  $live = 0',
    '  foreach ($it in $items) {',
    '    $p = $null; try { $p = Get-Process -Id $it[0] -ErrorAction Stop } catch { continue }',
    '    $s = $null; try { $s = [long]$p.StartTime.ToFileTimeUtc() } catch { $s = $null }',
    '    if ($s -eq $null -or [math]::Abs($s - $it[1]) -gt 10) { $other++; continue }',
    '    $live++',
    "    foreach ($t in @($p.Threads)) { try { $t.PriorityLevel = 'Normal'; $ok++ } catch { $bad++ } }",
    '  }',
    '  if ($live -eq 0 -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt $end) { break }',
    '  $rounds++',
    '  Start-Sleep -Milliseconds 100',
    '}',
    "[Console]::Out.WriteLine(\"BOOST|$rounds|$ok|$bad|$other\")",
  ].join('\n');
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  noteChild(child);
  let out = '';
  let error = null;
  child.stdout.on('data', d => { out += d; });
  const done = new Promise((resolve) => { child.on('exit', resolve); child.on('error', (err) => { error = err && err.message; resolve(); }); });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { /* gone */ } } };   // kill-ok(held-handle): the booster this probe spawned
  const summary = () => {
    if (error) return `could not start (${error})`;
    const m = /BOOST\|(\d+)\|(\d+)\|(\d+)\|(\d+)/.exec(out);
    return m ? `${m[1]} rounds, ${m[2]} thread priorities set, ${m[3]} refused, ${m[4]} reads of a pid that wasn't (or no longer was) ours` : 'no report (stopped)';
  };
  return { child, done, stop, summary };
}

// ---- the app's driver --------------------------------------------------------------------------------------------------------
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

function track(child, extra) {
  const app = { child, out: '', exited: false, exitAt: null, ...extra };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; app.exitAt = Date.now(); });
  return app;
}

async function launchApp(tmp, dev, userData, quitLogFile) {
  const port = await freePort();
  const token = crypto.randomBytes(16).toString('hex');
  // The probe's own CLAUDE_CUSTOM_* are named in keepEnv; spawnElectron's probeEnv strips the enclosing tab's and keeps
  // CLAUDE_CUSTOM_PROBE_VISIBLE (PR #242 Miguel S5).
  const env = {
    ...process.env,
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
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`, ...(APP_ARG ? [APP_ARG] : [])], { cwd: ROOT, env }, { keepEnv, label: 'probe-quit-linger' });
  const app = track(child, { port, token, dev });
  await child.ledgered;
  return app;
}

// The trivial Electron of verify/probe-electron-zombies.js (PR #130): one window, 3 WebContentsViews on data: pages, none of this
// app's code; it closes its views and window and calls app.exit(0) when its quit file appears.
async function launchTrivial(tmp, userData) {
  const quitFile = path.join(tmp, 'trivial-quit');
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [path.join(__dirname, 'probe-electron-zombies.js'), `--user-data-dir=${userData}`],
    { cwd: ROOT, env: { ...process.env, CC_ZOMBIE_VIEWS: '3', CC_ZOMBIE_QUIT: quitFile } }, { label: 'probe-quit-linger trivial' });
  const app = track(child, { quitFile });
  await child.ledgered;
  return app;
}

// What the window has open when it is closed: { ok, text } (PR #242 Miguel F6: a condition that wasn't set up is a FAIL).
async function setUp(app, what) {
  if (what === 'notab') return { ok: true, text: 'closed as soon as the strip answered' };
  const ready = await waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 45000);
  if (!ready) return { ok: false, text: 'the tab never started' };
  if (what === 'panel') {
    const r = await view(app, 'dock', { id: 'resources', target: { edge: 'right' } });
    const shown = await waitFor(async () => { const s = await view(app, 'resourcesState'); return s && s.shown ? s : null; }, 10000, 200);
    return shown ? { ok: true, text: 'Resources panel docked' } : { ok: false, text: `panel not shown (${JSON.stringify(r).slice(0, 120)})` };
  }
  if (what === 'chat') {
    const r = await view(app, 'chatDo', { what: 'toggle' });
    const on = await waitFor(async () => { const s = await view(app, 'chatState'); return s && s.ok && s.shown ? s : null; }, 10000, 200);
    return on ? { ok: true, text: 'chat view on' } : { ok: false, text: `chat view not on (${JSON.stringify(r).slice(0, 120)})` };
  }
  if (what === 'video') {
    // A looping test video as the tab's background (the host copies it into the temp project's own state), as
    // verify/probe-video-background.js makes it.
    const webm = path.join(path.dirname(path.dirname(app.dev)), 'background.webm');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=3',
      '-c:v', 'libvpx-vp9', '-b:v', '400k', '-pix_fmt', 'yuv420p', webm], { windowsHide: true, encoding: 'utf8', timeout: 60000 }).status === 0;
    if (!made) return { ok: false, text: 'ffmpeg could not make the video' };
    await view(app, 'bgStyle', { action: 'set-background', path: webm });
    const playing = await waitFor(async () => { const s = await view(app, 'bgState'); return s && s.video && s.video.readyState >= 2 && !s.video.paused ? s : null; }, 15000, 300);
    return playing ? { ok: true, text: 'background video playing' } : { ok: false, text: 'the video never played' };
  }
  await sleep(1500);
  return { ok: true, text: 'one tab, its host started' };
}

// ---- loads -----------------------------------------------------------------------------------------------------------------
// --ecore-load: one busy-looping node per efficiency core, pinned to it at BelowNormal. Each ends itself after maxMs whatever happens.
// Returns { stop, alive } or null when there are no efficiency cores (or they couldn't be pinned).
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
  const spinners = lps.map(() => noteChild(spawn(process.execPath, ['-e', `const end = Date.now() + ${Math.round(maxMs)}; while (Date.now() < end) {}`], { stdio: 'ignore', windowsHide: true })));
  for (const s of spinners) s.on('error', () => { /* reported through alive() */ });
  // Pin and lower them (this probe's own children, by the pids it just spawned and still holds).
  const pin = spinners.map((s, i) => `$p = Get-Process -Id ${s.pid}; $p.ProcessorAffinity = [IntPtr]${2 ** lps[i]}; $p.PriorityClass = 'BelowNormal'`).join('; ');
  const kill = () => { for (const s of spinners) if (s.exitCode === null && s.signalCode === null) { try { s.kill(); } catch { /* gone */ } } };   // kill-ok(held-handle): the spinners this probe spawned
  try { execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${pin}`], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch (err) {
    console.log(`ecore-load: could not pin the spinners (${err && err.message}); stopping them, no load`);
    kill();
    return null;
  }
  console.log(`ecore-load: ${spinners.length} spinners on logical processors ${lps.join(',')}, BelowNormal, each ends itself within ${Math.round(maxMs / 60000)} min`);
  return {
    alive: () => spinners.every(s => s.exitCode === null && s.signalCode === null && Number.isInteger(s.pid)),
    stop: async () => {
      kill();
      await Promise.all(spinners.map(s => new Promise((r) => { if (s.exitCode !== null || s.signalCode !== null) r(); else { s.once('exit', r); setTimeout(r, 5000); } })));
    },
  };
}

// --load: a loop of `node --test` over a dozen test files. Returns a stop function.
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
    current.on('error', () => {});
    current.on('exit', () => { current = null; setTimeout(loop, 100); });
  };
  loop();
  console.log(`load: node --test --test-concurrency=2 over ${pick.length} files, looped`);
  return async () => {
    stopped = true;
    if (current) {
      const c = current;
      try { killPidTree(c.pid); } catch { /* gone */ }   // kill-ok(held-handle): the load child this probe spawned, handle held
      await new Promise((r) => { if (c.exitCode !== null) r(); else { c.once('exit', r); setTimeout(r, 10000); } });
    }
    return runs;
  };
}

// ---- one cycle --------------------------------------------------------------------------------------------------------------
// The hosts this launch may end, from the table now (verify/lib/quit-linger.js adoptableHosts), recorded with the table's start.
// `rootAlive` is read synchronously right before the (synchronous) table query: while this event loop is blocked, the root's
// 'exit' can't be processed, so its process handle is still held and its pid can't belong to anyone else.
function adoptHosts(ctx) {
  const { app } = ctx;
  if (!app || !ctx.rootStart || ctx.trivial) return;
  if (!PROBE_MARK) { console.log(`  cycle ${ctx.c}: no probe mark in this process; no host is adopted (left to verify/sweep-orphans.js)`); return; }
  const rootAlive = !app.exited;
  const rows = queryTree();
  if (!rows) return;
  const adopted = QL.adoptableHosts({ rows, ids: readHostIds(), rootPid: app.child.pid, rootStart: ctx.rootStart, rootAlive, rootExitMs: app.exitAt,
    hostScript: HOST_SCRIPT, mark: PROBE_MARK, insideDir: ctx.tmp });
  for (const h of adopted) ctx.seenPids.add(h.pid, h.start);
}

async function launchAndSetUp(ctx, what) {
  if (ctx.trivial) {
    ctx.app = await launchTrivial(ctx.tmp, ctx.userData);
    // Under --ecore-load its renderers start on the busy E-cores (it has no disable-renderer-backgrounding): it is given longer.
    const up = await waitFor(() => /TREE-UP/.test(ctx.app.out), ECORE_LOAD ? 120000 : 30000, 200);
    if (!up) return { ok: false, text: `the trivial tree never came up ${ctx.app.out.slice(-200)}` };
    await sleep(1000);   // its gpu / utility children settle into the table, as verify/probe-electron-zombies.js waits
    return { ok: true, text: 'the trivial Electron of verify/probe-electron-zombies.js, 3 views, its own close (views, window, app.exit(0))' };
  }
  ctx.app = await launchApp(ctx.tmp, ctx.dev, ctx.userData, ctx.quitLogFile);
  const strip = await waitFor(async () => { const st = await command(ctx.app, { cmd: 'state' }, 5000); return st && st.hosts ? st : null; }, 45000, 300);
  if (!strip) return { ok: false, text: `the window never answered ${ctx.app.out.slice(-200)}` };
  return setUp(ctx.app, what);
}

// The launch's processes, read from the table while every command line is readable.
function readLaunchTree(ctx) {
  const rows = queryTree();
  const tree = rows ? census.descendantsOf(rows, ctx.app.child.pid) : [];
  if (!tree.length) return null;
  ctx.rootStart = tree.find(r => r.pid === ctx.app.child.pid).start;
  // The host subtrees are listed apart: by design they outlive the window ("closing the window detaches").
  const hostPids = new Set(tree.filter(r => /host[\\/]host\.js/i.test(r.cmd)).map(r => r.pid));
  let grew = true;
  while (grew) { grew = false; for (const r of tree) if (!hostPids.has(r.pid) && hostPids.has(r.ppid)) { hostPids.add(r.pid); grew = true; } }
  const asTracked = (r, type) => ({ pid: r.pid, start: r.start, name: r.name, privMB: r.privMB, type });
  const appProcs = tree.filter(r => !hostPids.has(r.pid) && r.name.toLowerCase() === 'electron.exe').map(r => asTracked(r, QL.classify(r.cmd, r.pid === ctx.app.child.pid)));
  const others = tree.filter(r => !hostPids.has(r.pid) && r.name.toLowerCase() !== 'electron.exe').map(r => asTracked(r, `other:${r.name}`));
  return { appProcs, watched: [...appProcs, ...others], hosts: [...hostPids].length };
}

async function measure(ctx, condition, ecore) {
  const { c } = ctx;
  const [what, suffix] = condition.split(':');
  const boost = BOOST || suffix === 'boost';
  const setup = await launchAndSetUp(ctx, what);
  check(`cycle ${c} [${condition}]: set up`, setup.ok, setup.text);
  if (!setup.ok) return null;
  await sleep(500);
  const tree = readLaunchTree(ctx);
  if (!tree) { check(`cycle ${c} [${condition}]: the tree was read before the close`, false); return null; }
  adoptHosts(ctx);

  ctx.sampler = startSampler(tree.watched.map(p => p.pid));
  await ctx.sampler.first;
  if (!ctx.sampler.samples.length) { check(`cycle ${c} [${condition}]: the sampler started`, false, ctx.sampler.error() || 'no sample in 30 s'); return null; }
  const loaded = ecore ? ecore.alive() : null;
  const t0 = Date.now();
  let reply;
  if (ctx.trivial) { fs.writeFileSync(ctx.app.quitFile, 'quit'); reply = { ok: true }; } else reply = await command(ctx.app, { cmd: 'win-close' }, 15000);
  if (boost && reply && reply.ok) ctx.booster = startBooster(tree.appProcs.map(p => ({ pid: p.pid, start: p.start })));
  // Did the close start a quit? (PR #242 Miguel F1, Dexter 5.) The app's JavaScript must have stopped answering SETTLE_MS after it.
  let answering = false;
  if (reply && reply.ok && !ctx.trivial) {
    await sleep(Math.max(0, t0 + SETTLE_MS - Date.now()));
    const st = await command(ctx.app, { cmd: 'state' }, 3000);
    answering = !!(st && st.ok === true);
  }
  const verdict = QL.closeVerdict(reply, answering);
  check(`cycle ${c} [${condition}]: the close started a quit`, verdict.ok, verdict.why);
  if (!verdict.ok) return null;

  const watchEnd = await ctx.sampler.waitWatch(t0, WATCH_S * 1000, tree.watched);
  ctx.sampler.stop();
  if (ctx.booster) { await Promise.race([ctx.booster.done, sleep(1000)]); ctx.booster.stop(); console.log(`    boost: ${ctx.booster.summary()}`); }
  if (watchEnd === 'ended' || watchEnd === 'stalled') {
    check(`cycle ${c} [${condition}]: the sampler kept answering through the watch`, false, `${watchEnd}${ctx.sampler.error() ? `: ${ctx.sampler.error()}` : ''}`);
    return null;
  }
  return report(ctx, { condition, cond: setup.text, t0, tree, loaded });
}

function report(ctx, { condition, cond, t0, tree, loaded }) {
  const { c, app } = ctx;
  const samples = ctx.sampler.samples.filter(s => s.t >= t0);
  const watchedS = samples.length ? (samples[samples.length - 1].t - t0) / 1000 : 0;
  const rootExitS = app.exitAt ? (app.exitAt - t0) / 1000 : null;
  const sum = QL.summarise(tree.watched, ctx.sampler.samples, t0);
  const lastGone = sum.some(r => r.goneAfterS === null) ? null : Math.max(...sum.map(r => r.goneAfterS));
  const cpus = samples.map(s => s.cpu).filter(v => typeof v === 'number');
  const cpuAvg = cpus.length ? Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) : null;
  console.log(`    machine CPU during the watch: ${cpuAvg === null ? 'not read' : `${cpuAvg}% average (${cpus.join(' ')})`}${loaded === false ? '; the E-core spinners had ENDED by this close' : ''}`);
  const line = sum.map(r => `${r.type}:${r.goneAfterS === null ? `>${watchedS.toFixed(0)}` : r.goneAfterS.toFixed(2)}s${r.zombieSeen ? `(z${r.zombieS.toFixed(1)})` : ''}`).join(' ');
  check(`cycle ${c} [${condition}]: measured ${tree.watched.length} processes [${cond}]`, true,
    `root exit event ${rootExitS === null ? 'none' : `${rootExitS.toFixed(2)}s`}; last gone ${lastGone === null ? `>${watchedS.toFixed(1)} (still listed at the watch's last sample)` : `${lastGone.toFixed(2)}s`}; ${line}`);
  if (BOUND_S !== null) check(`cycle ${c} [${condition}]: the last app process is gone within ${BOUND_S} s of the close`, lastGone !== null ? lastGone <= BOUND_S : false, lastGone === null ? `still listed ${watchedS.toFixed(1)} s after the close` : `${lastGone.toFixed(2)} s`);
  const left = sum.filter(r => r.goneAfterS === null);
  if (left.length) console.log(`  cycle ${c}: still listed ${watchedS.toFixed(1)} s after the close, left to exit (not killed): ${left.map(r => `${r.type}:${r.pid}`).join(' ')}`);
  for (const r of sum) if (r.goneAfterS === null || r.goneAfterS > 3 || r.zombieSeen) console.log(`    ${r.type} ${r.pid} ${r.privMBBefore}MB: ${r.path.join(' ')}${r.goneAfterS !== null ? ` gone ${r.goneAfterS.toFixed(2)}s` : ''}`);
  let timeline = [];
  if (ctx.quitLogFile) { try { timeline = QL.readTimeline(fs.readFileSync(ctx.quitLogFile, 'utf8'), t0); } catch { timeline = []; } }
  if (timeline.length) console.log(`    quit log: ${timeline.join(' | ')}`);
  return { cycle: c, condition, cond, load: LOAD, loaded, appArg: APP_ARG, cpuAvg, rootExitS, lastGone, watchedS, hosts: tree.hosts, timeline, procs: sum };
}

async function cleanup(ctx) {
  if (ctx.sampler) ctx.sampler.stop();
  if (ctx.booster) ctx.booster.stop();
  const { app } = ctx;
  // Hosts first, while the root may still be running (its held handle is what makes a "child of the root" row provable).
  adoptHosts(ctx);
  if (app && !app.exited) {
    const killedAt = Date.now();
    // The child handle is held, so the launcher's stop is by proven pid.
    const r = await stopElectron({ child: app.child, pid: app.child.pid }, { politeMs: 0, graceMs: 20000 });
    console.log(`    the root was still running at the end: stopped by its pid (${r.how}${app.exitAt ? `, its exit ${((app.exitAt - killedAt) / 1000).toFixed(2)} s after the kill` : ''})`);
  }
  const { left } = ctx.seenPids.endAll();
  if (left.length) console.log(`  cycle ${ctx.c}: hosts not ended: ${left.join(' ')}`);
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
}

async function cycle(c, tmpBase, condition, ecore) {
  const tmp = fs.mkdtempSync(path.join(tmpBase, `c${c}-`));
  const dev = path.join(tmp, 'proj', 'dev');
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  const ctx = {
    c, tmp, dev, userData: path.join(tmp, 'user-data'), quitLogFile: QUIT_LOG ? path.join(tmp, 'quit.log') : null,
    trivial: condition.split(':')[0] === 'trivial', app: null, rootStart: null, sampler: null, booster: null,
    // A host's start is recorded from the CIM table (whole microseconds); the kill proves it on a held handle within 1 us.
    seenPids: createSeenPids({ prove: (pid, start) => killProven(pid, start, { toleranceTicks: 10 }) }),
  };
  try { return await measure(ctx, condition, ecore); } finally { await cleanup(ctx); }
}

// ---- the run ----------------------------------------------------------------------------------------------------------------
async function main() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-quit-linger-'));
  // Miguel B1: this probe moves the checkout's own .harness/state/layout-*.json, so never beside a live host of this checkout.
  const foreign = await QL.findForeignHost(readHostIds(), tmpBase, (id) => isLiveHost(id));
  if (foreign) {
    console.log(`REFUSED: a live host (pid ${foreign.pid}, ${foreign.cwd}) is open on this checkout. The probe moves .harness/state/layout-*.json; close that window, or run the probe from another checkout.`);
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best effort */ }
    return 2;
  }
  // The files are put back on EVERY way out: Ctrl+C goes through the launcher's signal sweep, which exits, which runs this.
  installSweep();
  const snaps = LAYOUT_FILES.map(f => snapshotFile(f));
  const restoreState = () => { for (const s of snaps) s.restore(); };
  process.on('exit', restoreState);

  const stopLoad = LOAD ? startLoad() : null;
  // The spinners live for the whole run (the longest a cycle can take: a 120 s start wait under the load, the watch, a 20 s stop,
  // the set-up, for every cycle; 4 hours at most); each cycle still records whether they were all running at its close (Dexter 6).
  const total = CYCLES * CONDITIONS.length;
  const ecore = ECORE_LOAD ? startEcoreLoad(Math.min(4 * 3600000, (total * (WATCH_S + 240) + 120) * 1000)) : null;
  const results = [];
  const order = [];
  if (INTERLEAVE) { for (let c = 1; c <= CYCLES; c++) for (const condition of CONDITIONS) order.push([c, condition]); }
  else { for (const condition of CONDITIONS) for (let c = 1; c <= CYCLES; c++) order.push([c, condition]); }
  try {
    if (stopLoad || ecore) await sleep(3000);
    for (const [c, condition] of order) {
      for (const f of LAYOUT_FILES) { try { fs.unlinkSync(f); } catch { /* none */ } }
      const r = await cycle(c, tmpBase, condition, ecore);
      if (r) results.push(r);
      await sleep(1000);
    }
  } finally {
    if (ecore) await ecore.stop();
    if (stopLoad) console.log(`load: ${await stopLoad()} test runs`);
    restoreState();
    try { fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
  }
  summary(results);
  check('every cycle was measured', results.length === total, `${results.length}/${total}`);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

// Per condition, per type: count, median and max time gone (the ones still listed at the watch's end count as ">watch"), how many
// were still there, and how many were seen at 1 thread / 0 handles.
function summary(results) {
  for (const condition of CONDITIONS) {
    const rs = results.filter(r => r.condition === condition);
    const byType = {};
    for (const r of rs) for (const p of r.procs) (byType[p.type] = byType[p.type] || []).push(p);
    const loadNote = ECORE_LOAD ? `, E-core load on ${rs.filter(r => r.loaded === true).length} of ${rs.length} cycles` : '';
    console.log(`\n== ${rs.length}/${CYCLES} cycles, condition=${condition}, load=${LOAD ? 'on' : 'off'}${loadNote}${APP_ARG ? `, app arg ${APP_ARG}` : ''}${BOOST ? ', BOOST (diagnostic)' : ''}; seconds from the window's close to gone from the table`);
    for (const [type, ps] of Object.entries(byType).sort()) {
      const st = QL.censoredStats(ps.map(p => p.goneAfterS));
      console.log(`   ${type.padEnd(22)} x${String(st.n).padEnd(3)} median ${QL.fmtS(st.median, WATCH_S)}  max ${QL.fmtS(st.max, WATCH_S)}  still there ${st.still}  zombie-shaped ${ps.filter(p => p.zombieSeen).length}`);
    }
    const lasts = QL.censoredStats(rs.map(r => r.lastGone));
    const roots = QL.censoredStats(rs.map(r => r.rootExitS));
    console.log(`   last app process gone:  median ${QL.fmtS(lasts.median, WATCH_S)}  max ${QL.fmtS(lasts.max, WATCH_S)}  (${lasts.still} still listed at the watch's end)  per cycle: ${rs.map(r => (r.lastGone === null ? `>${WATCH_S}` : r.lastGone.toFixed(1))).join(' ')}`);
    console.log(`   root exit event:        median ${QL.fmtS(roots.median, WATCH_S)}  max ${QL.fmtS(roots.max, WATCH_S)}`);
  }
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(results, null, 1)); console.log(`   raw: ${OUT}`); }
}

main().then((code) => process.exit(code), (err) => { console.error(err && err.stack || err); process.exit(1); });
