'use strict';
/**
 * PROBE: GPU usage in the top-bar chip, its popover and the Resources tab (BACKLOG #82), in a REAL window with a REAL host.
 * (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-gpu-usage.js              (exit 0 = every check held)
 *   GPU_PROBE_SHOTS=<dir>                                                   where the screenshots go
 *
 * Take the heavy-work lock first (C:\Users\ricar\.claude\scripts\heavy-lock.ps1): this starts Electron and a real
 * PowerShell/WMI sample every 10 s.
 *
 * The unit tests pin the arithmetic and the markup (test/resource-gpu.test.js, test/resources-display-gpu.test.js,
 * test/resources-history-gpu.test.js). No unit test can see the page: every renderer script shares ONE global scope
 * (CLAUDE.md), and none runs the real GPU counters. This starts a real window and checks:
 *
 *   1  the chip carries a GPU figure with its own sparkline (CPU, memory, GPU: three), and still fits the top bar
 *   2  the Resources tab has the GPU section: busy and memory bars, the two last-hour graphs, the processes holding GPU memory
 *   3  the chip's popover has four graphs (cpu, mem, gpu, gpumem), sits inside the window, and the GPU hover reads a real value
 *   4  scene "model loaded": when Ollama has a model loaded (/api/ps; nothing is loaded by this probe), the process holding it
 *      is listed with its memory; then ONE short LOCAL generation (no billed call) makes the GPU busy and the chip shows it
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is ever sent to Claude;
 * ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp git repo,
 * registry, portraits, uploads and user data are temp folders. Layout files of THIS checkout are snapshotted and put back.
 * Only the Electron tree this probe spawned is ended, by PID (verify/lib/process-hygiene.js). Nothing is stopped by name.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-gpu-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.GPU_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-gpu-usage');
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
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
  seenPids.endAll();
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

// Ollama (local, free): a loaded model is looked up, never loaded by this probe; one short generation keeps the GPU busy.
function ollama(method, pathname, body, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: 11434, path: pathname, method, timeout: timeoutMs, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE, CHIP_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const rs = () => view(app, 'resourcesState');

  // 1 -----------------------------------------------------------------------------
  const chip = await waitFor(async () => { const s = await rs(); return s && s.hasPayload && s.chip && /GPU/.test(s.chip.text) && s.hist.spark.length === 3 ? s : null; }, 60000, 300);
  check('1: the chip has a GPU figure after the memory one, with its own sparkline (three in all)', !!chip, JSON.stringify(chip && chip.chip));
  const real = await waitFor(async () => { const s = await rs(); return s && s.chip && /^CPU \d+(\.\d)?%  \d+(\.\d)? GB \/ \d+(\.\d)? GB  GPU (\d+(\.\d)?%|<1%)$/.test(s.chip.text) ? s : null; }, 60000, 500);
  check('1: after the second sample the chip reads `CPU n%  x GB / y GB  GPU n%` (a measured GPU %, not a dash)', !!real, JSON.stringify((await rs()).chip));
  const fits = await rs();
  check('1: the chip still fits the top bar at this window width', fits.hist.chipClipped === false && fits.hist.barClipped === false && fits.hist.chipRect && fits.hist.chipRect.x + fits.hist.chipRect.w <= fits.hist.winW, JSON.stringify({ chip: fits.hist.chipRect, win: fits.hist.winW }));
  const gpuLine = await waitFor(async () => { const s = await rs(); return s.hist.spark.length === 3 && s.hist.spark[2].polylines + s.hist.spark[2].dots >= 1 ? s : null; }, 60000, 500);
  check('1: the GPU sparkline has a line in it once there are samples', !!gpuLine, JSON.stringify((await rs()).hist.spark));

  // 2 -----------------------------------------------------------------------------
  await view(app, 'select', { id: 'resources' });
  const tab = await waitFor(async () => { const s = await rs(); return s && s.shown && /Holding GPU memory/.test(s.text) ? s : null; }, 30000, 300);
  check('2: the Resources tab has a GPU section with its process list', !!tab, tab ? '' : JSON.stringify((await rs()).text.slice(0, 300)));
  if (!tab) { console.log(app.out.slice(-600)); return; }
  check('2: the section follows Machine and says busy and memory used of total', /Machine[\s\S]*GPU\s*[\d—<][^·]*·\s*[\d.]+ (MB|GB) \/ [\d.]+ (MB|GB)/.test(tab.text), JSON.stringify(tab.text.match(/GPU\s[^]{0,60}/)));
  check('2: it draws no NaN, undefined or null', !/NaN|undefined|null/.test(tab.text));
  const withGraphs = await waitFor(async () => { const s = await rs(); return s.gpuSec && s.gpuSec.graphs.length === 2 && s.gpuSec.graphs.every(g => g.rest >= 1 || g.dots >= 1) ? s : null; }, 60000, 500);
  check('2: the section holds the two last-hour graphs (GPU busy, GPU memory), each with an area drawn', !!withGraphs, JSON.stringify((await rs()).gpuSec));
  const sec = await rs();
  check('2: the process rows sit inside the panel and show a name, a busy figure and a memory figure', sec.gpuSec && sec.gpuSec.rows.length >= 1 && sec.gpuSec.rows.every(r => r.name && r.figs.length === 2 && r.inside), JSON.stringify(sec.gpuSec && sec.gpuSec.rows.slice(0, 4)));
  await view(app, 'resourcesHistoryDo', { op: 'scroll-gpu' });
  await sleep(500);
  const idleShot = path.join(shots, 'gpu-tab-idle.png');
  await command(app, { cmd: 'screenshot', file: idleShot });
  note(`screenshot (Resources tab, GPU section): ${idleShot}`);

  // 3 -----------------------------------------------------------------------------
  await view(app, 'resourcesClick', { chip: true });
  const popped = await waitFor(async () => { const s = await rs(); return s.hist.open && s.hist.graphs.length === 4 ? s : null; }, 8000, 150);
  check('3: the popover has four graphs: cpu, mem, gpu, gpumem', !!popped && popped.hist.graphs.map(g => g.kind).join() === 'cpu,mem,gpu,gpumem', JSON.stringify(popped && popped.hist.graphs.map(g => g.kind)));
  check('3: the GPU graphs draw their area and mark the latest point', !!popped && popped.hist.graphs.slice(2).every(g => (g.rest >= 1 || g.dots >= 1) && g.latest === 1 && g.ours === 0), JSON.stringify(popped && popped.hist.graphs.slice(2)));
  check('3: the popover sits fully inside the window, under the chip', !!popped && popped.hist.popRect.x >= 0 && popped.hist.popRect.x + popped.hist.popRect.w <= popped.hist.winW && popped.hist.popRect.y + popped.hist.popRect.h <= popped.hist.winH && popped.hist.popRect.y >= popped.hist.chipRect.y + popped.hist.chipRect.h, JSON.stringify(popped && [popped.hist.popRect, popped.hist.chipRect, popped.hist.winH]));
  await view(app, 'resourcesHistoryDo', { op: 'hover', kind: 'gpu', frac: 0.995 });
  const hov = await waitFor(async () => { const s = await rs(); const g = s.hist.graphs.find(x => x.kind === 'gpu'); return g && g.cursor && /^now · GPU (\d+(\.\d)?%|<1%)$/.test(g.readout) ? s : null; }, 6000, 150);
  check('3: hovering the newest minute of the GPU graph reads a real value and shows a cursor', !!hov, JSON.stringify((await rs()).hist.graphs.find(x => x.kind === 'gpu')));
  await view(app, 'resourcesHistoryDo', { op: 'hover', kind: 'gpumem', frac: 0.995 });
  const hovMem = await waitFor(async () => { const s = await rs(); const g = s.hist.graphs.find(x => x.kind === 'gpumem'); return g && g.cursor && /^now · GPU memory [\d.]+ (MB|GB) of [\d.]+ (MB|GB)$/.test(g.readout) ? s : null; }, 6000, 150);
  check('3: and the GPU memory graph reads "used of total"', !!hovMem, JSON.stringify((await rs()).hist.graphs.find(x => x.kind === 'gpumem')));
  await sleep(300);
  const popShot = path.join(shots, 'gpu-popover.png');
  await command(app, { cmd: 'screenshot', file: popShot });
  note(`screenshot (chip popover): ${popShot}`);
  await view(app, 'resourcesHistoryDo', { op: 'esc' });

  // 4 -----------------------------------------------------------------------------
  const ps = await ollama('GET', '/api/ps', null, 4000);
  const model = ps && Array.isArray(ps.models) && ps.models[0] ? ps.models[0].name : null;
  if (!model) {
    note('scene "model loaded": SKIPPED, Ollama is not running or has no model loaded (this probe never loads one)');
  } else {
    note(`Ollama has ${model} loaded (${Math.round((ps.models[0].size_vram || 0) / 1048576)} MB in VRAM)`);
    const withModel = await waitFor(async () => { const s = await rs(); return s.gpuSec && s.gpuSec.rows.some(r => /llama|ollama/i.test(r.name)) ? s : null; }, 30000, 500);
    check('4: the process holding the loaded model is listed, with its memory', !!withModel, JSON.stringify((await rs()).gpuSec && (await rs()).gpuSec.rows.slice(0, 5)));
    // ONE short local generation: no billed call. It runs while the sampler reads, so a sample lands inside it.
    const job = ollama('POST', '/api/generate', { model, prompt: 'Write a long, detailed essay about the sea and its tides.', stream: false, options: { num_predict: 600 } }, 120000);
    const busy = await waitFor(async () => { const s = await rs(); const m = s && s.machine && s.machine.gpu; return m && typeof m.busy === 'number' && m.busy >= 5 ? s : null; }, 45000, 500);
    check('4: while the model generates, the chip shows the GPU busy (>= 5%)', !!busy, JSON.stringify((await rs()).machine && (await rs()).machine.gpu));
    if (busy) {
      await view(app, 'resourcesHistoryDo', { op: 'scroll-gpu' });
      await sleep(300);
      const busyShot = path.join(shots, 'gpu-tab-busy.png');
      await command(app, { cmd: 'screenshot', file: busyShot });
      note(`screenshot (Resources tab, model generating): ${busyShot}`);
      // the row's own figure can land a sample after the chip's (a runner that restarted is "—" for one interval): wait for it
      const rowNow = await waitFor(async () => { const s2 = await rs(); const r = s2.gpuSec && s2.gpuSec.rows.find(x => /llama|ollama/i.test(x.name)); return r && /^<?\d/.test(r.figs[0]) ? r : null; }, 20000, 500);
      check('4: its row shows a busy figure, not a dash', !!rowNow, JSON.stringify(rowNow || (await rs()).gpuSec));
    }
    await job;
  }

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
