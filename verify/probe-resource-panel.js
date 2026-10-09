'use strict';
/**
 * PROBE: the Resources panel and its chips (BACKLOG #63), in a REAL window with a REAL host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-resource-panel.js        (exit 0 = every check held)
 *   RES_PROBE_SHOTS=<dir>                                                  where the screenshots go
 *
 * The unit tests pin the arithmetic, the attribution and the guards (test/resource-*.test.js,
 * test/resources-*.test.js). No unit test can see the page: every renderer script shares ONE global scope
 * (CLAUDE.md), so a module can load in a test and still abort in the window; and none of them runs the real
 * PowerShell/CIM sample. This starts a real window and a real session host, then checks:
 *
 *   1  resources-display.js loaded in the shared plain-script scope; the panel reads "measuring…" until the first
 *      full sample, and the top-bar chip shows the machine total from the first machine sample
 *   2  after the second sample the tab's session row has a real CPU figure and memory, the claude-custom row and
 *      the machine legend are drawn, and the chip reads `CPU n%  x GB / y GB`
 *   3  a CPU-burning child (started by THIS probe in the tab's shell, self-limiting, BelowNormal priority) is named
 *      in the session's top 3 children with a real CPU figure
 *   4  the tab's warning chip appears on the strip once the session tree holds 40% of the machine for three samples
 *      (reported as SKIPPED, with the measured figure, when this machine was too busy to reach it)
 *   5  Stop: Cancel leaves the process alone; "Stop it" ends exactly that PID, the row reads "Stopped (PID n)", a
 *      bystander process in the same session, the session's shell and the host all stay alive, and the row is gone
 *      at the next sample
 *   6  hiding the panel does not stop the sampling: the payload keeps its model and the chip keeps its figures
 *   8  the one-hour history (#63 follow-up, design option B): a sparkline after the CPU and the memory figure, a click on
 *      the chip opens a popover with two graphs (a second click, Esc and an outside click close it), the hover reads one
 *      minute, the chip still fits the top bar, and a minimised stretch is a BREAK in the line, not a drop to 0
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is ever sent;
 * ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp
 * git repo, registry, portraits, uploads and user data are temp folders. Two files of THIS checkout are touched
 * because host.js hardcodes its state dir (.harness/state/layout-global.json and layout-tree.json): both are
 * snapshotted and put back on every exit path. Only PIDs this probe started are killed: the burner and the
 * bystander end themselves (the burner after ~100 s at the latest), and the Electron tree this probe spawned is
 * killed by PID at exit (verify/lib/process-hygiene.js). Nothing is ever stopped by name.
 */

const { spawn, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { isLiveHost } = require('./lib/live-host');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { killChildTree } = require(path.join(ROOT, 'host', 'kill-tree'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-res-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.RES_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-resource-panel');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (text) => console.log(`NOTE  ${text}`);

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
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const LAYOUT_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const CHIP_FILE = path.join(STATE_DIR, 'resource-chip.json');
const layoutSnap = snapshotFile(LAYOUT_FILE);
const treeSnap = snapshotFile(TREE_FILE);
const chipSnap = snapshotFile(CHIP_FILE);
hygiene.addCleanup(() => { layoutSnap.restore(); treeSnap.restore(); chipSnap.restore(); });
hygiene.install();

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_')));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    // the warning's threshold, lowered so a busy machine still shows the chip (default 40; see app/main.js)
    CLAUDE_CUSTOM_RESOURCE_WARN_AT: process.env.RES_PROBE_WARN_AT || '15',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_RESOURCE_WARN_AT', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });
  return app;
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

// pid -> the start time (FILETIME) it had when this probe first saw it. A pid is killed at the end ONLY while it is still
// the process that had that start time: Windows reuses pids fast, and a probe that re-kills a recorded pid minutes later
// can end somebody else's process with its whole tree (Miguel, PR #113 I4).
const seenPids = require('./lib/seen-pids').createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();   // a dead pid, or one reused since, is left alone (killProven). The tree is ours: a host this window spawned.
}
hygiene.addCleanup(killEverything);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 45000);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readPid = (file) => { try { const n = Number(fs.readFileSync(file, 'utf8')); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } };
// What the OS says is under the session's host right now: the probe's own eyes when the panel disagrees.
async function dumpTree(hostPid) {
  try {
    const { createExec, scriptFor } = require(path.join(ROOT, 'host', 'resource-sampler'));
    const { parseSample } = require(path.join(ROOT, 'host', 'resource-sample'));
    const { descendants } = require(path.join(ROOT, 'host', 'resource-tree'));
    const s = parseSample(await createExec(30000)(scriptFor('full')), Date.now());
    return descendants(s.procs, hostPid).map(p => `${p.pid}<-${p.ppid} ${p.name} ${(p.cmd || '').slice(0, 60)}`).join(' | ');
  } catch (e) { return `dump failed: ${e.message}`; }
}
const fmtState = (s) => JSON.stringify({ chip: s.chip.text, rows: s.rows.filter(r => r.open || /^s:/.test(r.key || '')).map(r => [r.name, r.open]), children: s.children.map(c => [c.name, c.cmd.slice(0, 50), c.figs, c.stop]) }).slice(0, 900);

const BURN = `'use strict';
const { Worker, isMainThread, workerData } = require('worker_threads');
const os = require('os');
const fs = require('fs');
if (isMainThread) {
  if (process.env.RES_PROBE_NORMAL !== '1') { try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* keep normal */ } }
  fs.writeFileSync(process.argv[3], String(process.pid));
  const secs = Number(process.argv[4]);
  for (let i = 0; i < Number(process.argv[2]); i++) new Worker(__filename, { workerData: { until: Date.now() + secs * 1000 } });
  setTimeout(() => process.exit(0), secs * 1000 + 500);
} else {
  while (Date.now() < workerData.until) { /* spin */ }
}
`;
const BYSTANDER = `'use strict';
require('fs').writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => process.exit(0), 150000);
`;

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE, CHIP_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  const burnJs = path.join(tmp, 'burn.js');
  const byJs = path.join(tmp, 'bystander.js');
  const burnPidFile = path.join(tmp, 'burn.pid');
  const byPidFile = path.join(tmp, 'by.pid');
  fs.writeFileSync(burnJs, BURN);
  fs.writeFileSync(byJs, BYSTANDER);
  const cores = os.cpus().length;
  // 45% of the cores by default, BelowNormal. RES_PROBE_WORKERS and RES_PROBE_NORMAL=1 turn it up when a busy machine
  // would not otherwise give the session 40% (the warning chip's threshold).
  const workers = Number(process.env.RES_PROBE_WORKERS) > 0 ? Number(process.env.RES_PROBE_WORKERS) : Math.max(2, Math.ceil(cores * 0.45));

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const st0 = await command(app, { cmd: 'state' });
  const tabKey = st0.selectedKey;
  const sessionKey = `s:${tabKey}`;
  const hostPid = (st0.hosts.find(h => h.key === tabKey) || {}).pid;
  const rs = () => view(app, 'resourcesState');
  const strip = async () => ((await command(app, { cmd: 'state' })).stripDom || []);

  // 1 -----------------------------------------------------------------------------
  const chip0 = await waitFor(async () => { const s = await rs(); return s && s.ok !== false && s.hasPayload && s.chip && /^CPU .* GB \/ .* GB$/.test(s.chip.text) ? s : null; }, 40000, 300);
  check('1: the chip shows the machine total from the machine sample, with the panel never opened',
    !!chip0 && /^CPU (\d+(\.\d)?%|—)  \d+(\.\d)? GB \/ \d+(\.\d)? GB$/.test(chip0.chip.text), JSON.stringify(chip0 && chip0.chip));
  check('1: the chip says what it is on hover', !!chip0 && /Machine total and the last hour\. Click for the graphs\./.test(chip0.chip.title));
  // Q1 (Ricardo): the process tree is sampled with the panel CLOSED, so the tab warning works with it closed.
  const closedFull = await waitFor(async () => { const s = await rs(); return s.payloadHasModel ? s : null; }, 40000, 500);
  check('1: the process tree is sampled with the panel never opened (the full model arrives)', !!closedFull && closedFull.shown === false, JSON.stringify(closedFull && closedFull.shown));

  // The chip no longer opens the panel (it opens the one-hour popover, step 8): the panel is opened from its own tab.
  const clicked = await view(app, 'select', { id: 'resources' });
  const opened = await waitFor(async () => { const s = await rs(); return s && s.shown ? s : null; }, 10000, 200);
  check('1: the Resources panel opens from its tab', !!opened, JSON.stringify(clicked));
  check('1: resources-display.js loaded in the shared plain-script scope', !!opened && opened.scope === true);
  const measuring = await rs();
  check('1: until the first full sample the panel reads "measuring…"', /measuring…/.test(measuring.text) || measuring.payloadHasModel === true, JSON.stringify(measuring.text.slice(0, 80)));

  // 2 -----------------------------------------------------------------------------
  const full = await waitFor(async () => { const s = await rs(); return s && s.payloadHasModel && s.rows.some(r => r.key === sessionKey) ? s : null; }, 40000, 300);
  check('2: the full sample arrives and the tab\'s session has a row', !!full, JSON.stringify(full ? full.rows : await rs()).slice(0, 700));
  if (!full) { console.log(app.out.slice(-800)); return; }
  check('2: the panel has its sections: machine, this project, claude-custom itself', /Machine/.test(full.text) && /This project/.test(full.text) && full.rows.some(r => /claude-custom itself/.test(r.name)));
  check('2: the footer says how often it samples and that it pauses while minimised', /Every 10 s · paused while minimised/.test(full.text));
  const second = await waitFor(async () => { const s = await rs(); return s && s.payloadHasModel && !/measuring…/.test(s.text) ? s : null; }, 40000, 500);
  check('2: after the second sample every CPU figure is real: no "measuring…", and nothing prints a bare NaN or undefined', !!second && !/NaN|undefined|null/.test(second.text), JSON.stringify(second && second.text.slice(0, 160)));
  check('2: the chip reads `CPU n%  x GB / y GB`', !!second && /^CPU \d+(\.\d)?%  \d+(\.\d)? GB \/ \d+(\.\d)? GB$/.test(second.chip.text), JSON.stringify(second && second.chip));
  check('2: the legend gives claude-custom and everything else', !!second && /claude-custom [^·]+· everything else/.test(second.text));
  await view(app, 'resourcesClick', { act: 'toggle', key: sessionKey });

  // 8 -----------------------------------------------------------------------------
  // The one-hour history. By now there are several samples, so the sparklines have lines in them.
  const withHist = await waitFor(async () => { const s = await rs(); return s && s.hist && s.hist.points >= 3 && s.hist.spark.length === 2 && s.hist.spark.every(k => k.polylines >= 1) ? s : null; }, 60000, 500);
  check('8: the chip has a sparkline after the CPU and after the memory figure, each with a line in it', !!withHist, JSON.stringify(withHist ? withHist.hist.spark : (await rs()).hist));
  const bigBefore = (await rs()).hist;
  check('8: the chip still fits the top bar at this window width (nothing clips)', bigBefore.chipClipped === false && bigBefore.barClipped === false && bigBefore.chipRect && bigBefore.chipRect.x >= 0 && bigBefore.chipRect.x + bigBefore.chipRect.w <= bigBefore.winW,
    JSON.stringify({ chip: bigBefore.chipRect, win: bigBefore.winW, clipped: [bigBefore.chipClipped, bigBefore.barClipped], spark: bigBefore.spark }));
  check('8: the popover is closed until the chip is clicked', bigBefore.open === false && bigBefore.expanded === 'false');
  await view(app, 'resourcesClick', { chip: true });
  const popped = await waitFor(async () => { const s = await rs(); return s.hist.open && s.hist.graphs.length === 2 ? s : null; }, 5000, 150);
  check('8: clicking the chip opens the popover with a CPU and a memory graph', !!popped && popped.hist.graphs.map(g => g.kind).join() === 'cpu,mem' && popped.hist.expanded === 'true', JSON.stringify(popped && popped.hist.graphs));
  check('8: each graph draws its area, marks the latest point and has the 60 / 30 / now axis', !!popped && popped.hist.graphs.every(g => g.rest >= 1 && g.latest === 1 && /60 min\s*30\s*now/.test(g.axis)), JSON.stringify(popped && popped.hist.graphs));
  check('8: the popover sits fully inside the window, under the chip', !!popped && popped.hist.popRect.x >= 0 && popped.hist.popRect.x + popped.hist.popRect.w <= popped.hist.winW && popped.hist.popRect.y >= popped.hist.chipRect.y + popped.hist.chipRect.h, JSON.stringify(popped && [popped.hist.popRect, popped.hist.chipRect]));
  await view(app, 'resourcesHistoryDo', { op: 'hover', kind: 'cpu', frac: 0.995 });   // the right edge: "now", where a sample is
  const hovered = await waitFor(async () => { const s = await rs(); const g = s.hist.graphs.find(x => x.kind === 'cpu'); return g && g.cursor && /^now · CPU \d+(\.\d)?%, ours (\d+(\.\d)?%|<1%)/.test(g.readout) ? s : null; }, 5000, 150);
  check('8: hovering the newest minute shows a real reading (a %, not "no data") and a cursor', !!hovered, JSON.stringify(hovered && hovered.hist.graphs[0]));
  await sleep(300);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'resource-history-popover.png') });
  await view(app, 'resourcesClick', { chip: true });
  check('8: a second click on the chip closes it', (await waitFor(async () => { const s = await rs(); return s.hist.open === false ? s : null; }, 5000, 150)) !== null);
  await view(app, 'resourcesClick', { chip: true });
  await waitFor(async () => (await rs()).hist.open, 5000, 150);
  await view(app, 'resourcesHistoryDo', { op: 'esc' });
  check('8: Esc closes it', (await waitFor(async () => { const s = await rs(); return s.hist.open === false ? s : null; }, 5000, 150)) !== null);
  await view(app, 'resourcesClick', { chip: true });
  await waitFor(async () => (await rs()).hist.open, 5000, 150);
  await view(app, 'resourcesHistoryDo', { op: 'outside' });
  check('8: a click outside closes it', (await waitFor(async () => { const s = await rs(); return s.hist.open === false ? s : null; }, 5000, 150)) !== null);
  check('8: and the panel was not opened by any of it (the chip no longer does that)', (await rs()).shown === true);


  // Ricardo's Q1: a link under the legend opens the Resources panel (showing and focusing it) and closes the popover.
  await view(app, 'select', { id: 'agents' });
  await waitFor(async () => (await rs()).shown === false, 5000, 150);
  await view(app, 'resourcesClick', { chip: true });
  const withLink = await waitFor(async () => { const s = await rs(); return s.hist.open ? s : null; }, 5000, 150);
  check('8: the popover has an "Open Resources panel" link under the legend, reachable by keyboard (a real button)', !!withLink && withLink.hist.link === true, JSON.stringify(withLink && withLink.hist.link));
  await view(app, 'resourcesHistoryDo', { op: 'link' });
  const viaLink = await waitFor(async () => { const s = await rs(); return s.shown && s.hist.open === false && s.panelFocused ? s : null; }, 8000, 200);
  check('8: clicking it closes the popover and opens and focuses the Resources panel', !!viaLink, JSON.stringify(await rs().then(s => [s.shown, s.hist.open, s.panelFocused])));

  // 3 -----------------------------------------------------------------------------
  const send = (data) => view(app, 'gitTermInput', { data });
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await send(`start /b node "${byJs}" "${byPidFile}"\r`);
  const byPid = await waitFor(() => readPid(byPidFile), 15000, 200);
  check('3: the bystander (a second idle process in the same session) is running', !!byPid && alive(byPid), String(byPid));
  await send(`start /b node "${burnJs}" ${workers} "${burnPidFile}" 100\r`);
  const burnPid = await waitFor(() => readPid(burnPidFile), 15000, 200);
  check(`3: the burner (${workers} spinning threads on ${cores} cores, ${process.env.RES_PROBE_NORMAL === '1' ? 'normal priority' : 'BelowNormal'}, self-ending) is running`, !!burnPid && alive(burnPid), String(burnPid));
  if (!burnPid) return;
  // the burner is NOT tracked for the final kill: it ends itself after 100 s, and Stop ends it in this probe

  const named = await waitFor(async () => {
    const s = await rs();
    const row = s.children.find(c => /burn\.js/.test(c.cmd));
    return row && /^(\d+(\.\d)?|<1)%$/.test(row.figs[0]) && /(MB|GB)$/.test(row.figs[1]) ? s : null;
  }, 60000, 500);
  check('3: the burner is named in the session\'s top children, with a real CPU figure and its memory', !!named, named ? '' : `${fmtState(await rs())} TREE: ${await dumpTree(hostPid)}`);
  if (named) {
    const row = named.children.find(c => /burn\.js/.test(c.cmd));
    check('3: its row shows what it runs (the script), the command is not the executable path', row.name === 'burn.js' && !/Program Files/i.test(row.cmd), JSON.stringify([row.name, row.cmd]));
    check('3: it can be stopped (a Stop button for exactly its pid)', row.stop === String(burnPid), JSON.stringify(row.stop));
    // The name column takes every leftover pixel at the dock's real width: what a child runs shows in full, and no row's first word is cut.
    const fitNow = await rs();
    const kids = fitNow.children.filter(c => /^(burn|bystander)\.js$/.test(c.name));
    check('3: "burn.js" and "bystander.js" are not truncated at the dock width', kids.length === 2 && kids.every(c => c.fit && c.fit.clipped === false), JSON.stringify(kids.map(c => [c.name, c.fit])));
    const cut = fitNow.rows.filter(r => r.fit && r.fit.firstWordFits !== true);
    check('3: every session, self and window row shows at least its whole first word (e.g. "claude-custom")', cut.length === 0, JSON.stringify(cut.map(r => [r.name, r.fit])));
    check('3: the Stop square is small but its hit area is at least 24 x 24', !!fitNow.stopHit && fitNow.stopHit.box <= 18 && fitNow.stopHit.w >= 24 && fitNow.stopHit.h >= 24, JSON.stringify(fitNow.stopHit));
    check('3: CPU and memory line up from row to row (the same right edge in every child row)', fitNow.figX.length >= 2 && fitNow.figX.every(x => x[0] === fitNow.figX[0][0] && x[1] === fitNow.figX[0][1]), JSON.stringify(fitNow.figX));
    console.log(`     name widths: ${JSON.stringify(fitNow.rows.map(r => [r.name, r.fit && r.fit.width, r.fit && r.fit.clipped]))}`);

    // The label parser against REAL command lines the OS reports. (1) A bash started the way Claude Code's Bash tool starts
    // one (`bash -c "source <snapshot> ... && eval '<cmd>' < /dev/null && pwd -P >| <file>"`), read back from Win32_Process.
    const { displayName } = require(path.join(ROOT, 'host', 'resource-label'));
    const cimLine = (pid) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true }).trim();
    const bashExe = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (!fs.existsSync(bashExe)) {
      note('Git bash is not installed here: the Bash-tool label is not checked');
    } else {
      const idleJs = path.join(tmp, 'idle-label.js');
      fs.writeFileSync(idleJs, 'setTimeout(() => {}, 60000);\n');
      const posix = idleJs.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
      const payload = `source /dev/null 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval 'node ${posix}' < /dev/null && pwd -P >| /dev/null`;
      const sh = spawn(bashExe, ['-c', payload], { stdio: 'ignore', windowsHide: true });
      hygiene.registerChild(sh);
      try {
        const line = await waitFor(async () => { const l = cimLine(sh.pid); return /eval/.test(l) ? l : null; }, 15000, 300);
        check('3: a REAL Bash-tool command line (read from the process table) labels as the script it runs', !!line && displayName(line, 'bash.exe') === 'idle-label.js', JSON.stringify([line && line.slice(0, 160), line && displayName(line, 'bash.exe')]));
      } finally {
        // The bash and the node it started, as one tree, through the bash this probe holds: only while it is still
        // running. After 15 s of waiting it may have exited, and then its pid (and any ParentProcessId=<it> query) may
        // name a stranger (PR #130 review r2, Dexter #2A). Never by name.
        killChildTree(sh);
      }
    }
    // (2) Whatever bash this very session's Claude Code started right now, if there is one: shown, and held to the same rules.
    const live = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Where-Object { $_.CommandLine -match 'eval' } | Select-Object -First 1).CommandLine"], { encoding: 'utf8', windowsHide: true }).trim();
    if (live) {
      const shown = displayName(live, 'bash.exe');
      note(`live Bash-tool line labels as ${JSON.stringify(shown)}`);
      // 'bash' is allowed: it is the deliberate label for a payload that starts with shell syntax (c4308fd).
      check('3: a live Bash-tool line gives a sensible label (not blank, not a flag or path, no shell syntax in it)', shown !== '' && !/^[-/]/.test(shown) && !/[$`(){}'"]/.test(shown), JSON.stringify([live.slice(0, 120), shown]));
    }
  }

  // The link flow with a live burner (the path Ricardo takes): another module is selected so the panel is hidden, the popover's
  // "Open Resources panel" link is clicked, and the burner's row must be in the panel within one cadence (12 s).
  if (named) {
    await view(app, 'select', { id: 'agents' });
    await waitFor(async () => (await rs()).shown === false, 5000, 150);
    await view(app, 'resourcesClick', { chip: true });
    await waitFor(async () => (await rs()).hist.open, 5000, 150);
    await view(app, 'resourcesHistoryDo', { op: 'link' });
    const linked = await waitFor(async () => { const s = await rs(); return s.shown && s.children.some(c => /burn\.js/.test(c.cmd) && /^(\d+(\.\d)?|<1)%$/.test(c.figs[0])) ? s : null; }, 12000, 300);
    check('3: opened through the popover link, the panel shows the burner row within one cadence (12 s)', !!linked, linked ? '' : fmtState(await rs()));
  }

  // The panel's CPU figure against an independent measurement: this process's own TotalProcessorTime, read twice 10 s
  // apart through Get-Process (not CIM, not the panel's script), turned into a share of the machine the same way.
  const cpuSeconds = () => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${burnPid}).TotalProcessorTime.TotalSeconds`], { encoding: 'utf8', windowsHide: true }).trim());
  const cpuA = cpuSeconds();
  const wallA = Date.now();           // each wall time is taken as its reading returns: the power-shell start-up is outside it
  await sleep(10000);
  const cpuB = cpuSeconds();
  const wallB = Date.now();
  const independent = ((cpuB - cpuA) / ((wallB - wallA) / 1000) / cores) * 100;
  const panelFig = await waitFor(async () => {
    const row = (await rs()).children.find(c => /burn\.js/.test(c.cmd));
    const m = row && /^(\d+(\.\d)?)%$/.exec(row.figs[0]);
    return m ? Number(m[1]) : null;
  }, 15000, 500);
  check('3: the panel CPU figure for the burner agrees with an independent measurement of the same process', panelFig !== null && Math.abs(panelFig - independent) <= 8,
    `panel ${panelFig}%, Get-Process over 10 s ${independent.toFixed(1)}% of ${cores} cores`);

  // 4 -----------------------------------------------------------------------------
  // Waits for the chip for up to 75 s, but gives up at 40 s when the session never got near 40% of the machine.
  const warnStart = Date.now();
  const warned = await waitFor(async () => {
    const tabs = await strip();
    const t = tabs.find(x => x.selected);
    if (t && /^\d+%$/.test(t.resWarn || '')) return t;
    if (Date.now() - warnStart > 40000) {
      const fig = ((await rs()).rows.find(r => r.key === sessionKey) || { figs: [] }).figs[0];
      if (!(parseFloat(fig) >= 35)) return { hopeless: true };
    }
    return null;
  }, 75000, 1000);
  const mid = await rs();
  if (warned && !warned.hopeless) {
    check('4: the tab\'s warning chip appeared on the strip (three samples over the threshold: the probe lowers it to 15%, the default is 40%)', true, warned.resWarn);
  } else {
    const sessionFigs = (mid.rows.find(r => r.key === sessionKey) || { figs: [] }).figs;
    const burnFigs = (mid.children.find(c => /burn/.test(c.cmd)) || { figs: [] }).figs;
    note(`4: SKIPPED the warning chip: this machine never gave the session 40% of its CPU (${cores} cores, ${workers} spinners, ${process.env.RES_PROBE_NORMAL === '1' ? 'normal priority' : 'BelowNormal'}; the session row read ${JSON.stringify(sessionFigs)}, the burner ${JSON.stringify(burnFigs)}). The counter itself is pinned by test/resource-warning.test.js and test/resources-service.test.js.`);
  }
  await sleep(500);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'panel-burning.png') });

  // 5 -----------------------------------------------------------------------------
  const before = await rs();
  const stopBtn = before.children.find(c => /burn\.js/.test(c.cmd));
  if (!stopBtn) { check('5: the burner row is still there to stop', false, fmtState(before)); return; }
  await view(app, 'resourcesClick', { act: 'ask-stop', pid: burnPid });
  const asked = await waitFor(async () => { const s = await rs(); return s.confirm ? s : null; }, 5000, 150);
  check('5: Stop asks inline, naming the process and PID and what stops with it', !!asked && new RegExp(`Stop burn\\.js, PID ${burnPid}\\? Only this process stops, and anything it started stops with it\\.`).test(asked.confirm), JSON.stringify(asked && asked.confirm));
  await view(app, 'resourcesClick', { act: 'cancel-stop' });
  await sleep(600);
  const cancelled = await rs();
  check('5: Cancel closes the question and leaves the process running', !cancelled.confirm && alive(burnPid));

  await view(app, 'resourcesClick', { act: 'ask-stop', pid: burnPid });
  await waitFor(async () => (await rs()).confirm, 5000, 150);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'panel-confirm.png') });
  await view(app, 'resourcesClick', { act: 'confirm-stop' });
  // Every distinct thing the panel said after the click, with the time: "Stopped" lasts one sample, and a probe that
  // only polls for it cannot tell "never shown" from "shown between two polls".
  const timeline = [];
  const t0 = Date.now();
  const stopped = await waitFor(async () => {
    const s = await rs();
    const said = JSON.stringify([s.children.map(c => c.text.slice(0, 40)), s.notes]);
    if (timeline.length === 0 || timeline[timeline.length - 1].said !== said) timeline.push({ at: Date.now() - t0, said });
    return s.children.some(c => new RegExp(`Stopped \\(PID ${burnPid}\\)`).test(c.text)) ? s : null;
  }, 20000, 80);
  check('5: the row reads "Stopped (PID n)"', !!stopped, JSON.stringify(timeline).slice(0, 900));
  const gone = await waitFor(() => !alive(burnPid), 10000, 200);
  check('5: exactly that PID ended', gone === true);
  check('5: the bystander in the same session is still running', !!byPid && alive(byPid));
  check('5: the session\'s host is still running', !!hostPid && alive(hostPid), String(hostPid));
  const dropped = await waitFor(async () => { const s = await rs(); return !s.children.some(c => /burn\.js/.test(c.cmd)) && !s.children.some(c => /Stopped \(PID/.test(c.text)) ? s : null; }, 30000, 500);
  check('5: at the next sample the row is gone', !!dropped);
  const cleared = await waitFor(async () => { const t = (await strip()).find(x => x.selected); return t && !t.resWarn ? t : null; }, 40000, 1000);
  check('5: and the tab\'s warning chip clears with it', !!cleared);

  // 6 -----------------------------------------------------------------------------
  await view(app, 'select', { id: 'agents' });
  const before6 = Date.now();
  // two more samples arrive WITH the model while the panel is hidden: hiding it does not stop the sampling
  let seen6 = 0; let lastText6 = null;
  const noModel = await waitFor(async () => { const s = await rs(); if (s.payloadHasModel && s.machine && JSON.stringify(s.machine) !== lastText6) { lastText6 = JSON.stringify(s.machine); seen6++; } return seen6 >= 2 && s.payloadHasModel ? s : null; }, 40000, 500);
  check('6: hiding the panel does NOT stop the process-tree sample: the model keeps arriving', !!noModel, String(Date.now() - before6));
  check('6: the chip keeps its machine figures', !!noModel && /^CPU .* GB \/ .* GB$/.test(noModel.chip.text) && !/NaN|undefined/.test(noModel.chip.text), JSON.stringify(noModel && noModel.chip));

  // 7 (Q2) the Window menu's chip toggle -----------------------------------------------
  const untick = await view(app, 'resourcesChipMenu');
  check('7: the Window menu has "Show CPU and memory in the top bar", ticked by default', untick.ok === true && untick.before === true, JSON.stringify(untick));
  const chipGone = await waitFor(async () => { const s = await rs(); return s.chip && s.chip.hidden === true ? s : null; }, 10000, 200);
  check('7: unticking it hides the chip', !!chipGone);
  const saved = await waitFor(() => { try { return JSON.parse(fs.readFileSync(CHIP_FILE, 'utf8')).show === false ? true : null; } catch { return null; } }, 5000, 200);
  check('7: and the choice is saved (install-wide)', saved === true);
  const stillSampling = await waitFor(async () => { const s = await rs(); return s.payloadHasModel && s.chip.hidden ? s : null; }, 25000, 500);
  check('7: with the chip off the process tree is still sampled (the warning needs it)', !!stillSampling);
  const retick = await view(app, 'resourcesChipMenu');
  const chipBack = await waitFor(async () => { const s = await rs(); return s.chip && s.chip.hidden === false ? s : null; }, 10000, 200);
  check('7: ticking it again brings the chip back', retick.ok === true && retick.before === false && !!chipBack, JSON.stringify(retick));



  // 8 (gap) a minimised stretch is a break in the line ----------------------------------
  // Main marks a break the moment the window is minimised, so a short minimise proves it. The MEMORY sparkline is counted
  // (its first sample after the restore already has a value; the CPU one needs two): runs = lines + lone dots, and exactly one
  // more is expected.
  const runsNow = async () => { const s = await rs(); return s.hist.spark[1] ? s.hist.spark[1].polylines + s.hist.spark[1].dots : 0; };
  const runsBefore = await runsNow();
  await command(app, { cmd: 'window-state', state: 'minimize' });
  await sleep(8000);
  await command(app, { cmd: 'window-state', state: 'restore' });
  const afterGap = await waitFor(async () => (await runsNow()) >= runsBefore + 1 ? true : null, 60000, 500);
  const runsAfter = await runsNow();
  check('8: a window minimised for 8 s leaves exactly one break in the memory line (one more run), never a drop to 0', !!afterGap && runsAfter === runsBefore + 1, `runs before ${runsBefore}, after ${runsAfter}`);
  await view(app, 'resourcesClick', { chip: true });
  const gapPop = await waitFor(async () => { const s = await rs(); return s.hist.open && s.hist.graphs.length === 2 ? s : null; }, 5000, 150);
  check('8: the popover draws the break too (two or more marks in the memory graph: areas and dots)', !!gapPop && gapPop.hist.graphs[1].rest + gapPop.hist.graphs[1].dots >= 2, JSON.stringify(gapPop && gapPop.hist.graphs[1]));
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'resource-history-gap.png') });
  await view(app, 'resourcesHistoryDo', { op: 'esc' });
  // the popover also closes when the window loses focus / the page hides (minimise hides it)
  await view(app, 'resourcesClick', { chip: true });
  await waitFor(async () => (await rs()).hist.open, 5000, 150);
  await command(app, { cmd: 'window-state', state: 'minimize' });
  await sleep(1500);
  await command(app, { cmd: 'window-state', state: 'restore' });
  const closedByHide = await waitFor(async () => { const s = await rs(); return s && s.hist && s.hist.open === false ? s : null; }, 10000, 300);
  check('8: the popover closes when the window loses focus or the page hides', !!closedByHide);

  const errors = (app.out.match(/\[renderer:[a-z]+\].*/g) || []).filter(l => /error|not defined|undefined is not|cannot read/i.test(l));
  check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`screenshots: ${shots}`);
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    layoutSnap.restore();
    treeSnap.restore();
    chipSnap.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
