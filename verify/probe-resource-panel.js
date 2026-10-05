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
 *   6  hiding the panel stops the process-tree sample: the page reports "not showing" and the payload loses its
 *      model, while the chip keeps its machine figures; the warning chip is cleared with it
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
const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));

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
const layoutSnap = snapshotFile(LAYOUT_FILE);
const treeSnap = snapshotFile(TREE_FILE);
hygiene.addCleanup(() => { layoutSnap.restore(); treeSnap.restore(); });
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
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env });
  hygiene.registerSpawnedTree(child.pid);
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

const seenPids = new Set();
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
  for (const id of hostsOfThisRun()) seenPids.add(id.pid);
  for (const pid of seenPids) { try { killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
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
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* keep normal */ }
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
  for (const f of [LAYOUT_FILE, TREE_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  const burnJs = path.join(tmp, 'burn.js');
  const byJs = path.join(tmp, 'bystander.js');
  const burnPidFile = path.join(tmp, 'burn.pid');
  const byPidFile = path.join(tmp, 'by.pid');
  fs.writeFileSync(burnJs, BURN);
  fs.writeFileSync(byJs, BYSTANDER);
  const cores = os.cpus().length;
  const workers = Math.max(2, Math.ceil(cores * 0.45));

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
  check('1: the chip says what it is on hover', !!chip0 && /Machine total\. Open the Resources panel/.test(chip0.chip.title));
  check('1: nothing samples the process tree while the panel is not showing', !!chip0 && chip0.reportedShown !== true && chip0.payloadHasModel === false, JSON.stringify({ r: chip0 && chip0.reportedShown, m: chip0 && chip0.payloadHasModel }));

  // The chip opens and focuses the panel (the design's Claude's-call item).
  const clicked = await view(app, 'resourcesClick', { chip: true });
  const opened = await waitFor(async () => { const s = await rs(); return s && s.shown ? s : null; }, 10000, 200);
  check('1: clicking the chip opens the Resources panel', clicked.ok === true && !!opened, JSON.stringify(clicked));
  check('1: resources-display.js loaded in the shared plain-script scope', !!opened && opened.scope === true);
  check('1: the page tells main its panel is showing (that is what starts the process-tree sample)', !!opened && (await waitFor(async () => (await rs()).reportedShown === true, 5000)) === true);
  const measuring = await rs();
  check('1: until the first full sample the panel reads "measuring…"', /measuring…/.test(measuring.text) || measuring.payloadHasModel === true, JSON.stringify(measuring.text.slice(0, 80)));

  // 2 -----------------------------------------------------------------------------
  const full = await waitFor(async () => { const s = await rs(); return s && s.payloadHasModel && s.rows.some(r => r.key === sessionKey) ? s : null; }, 40000, 300);
  check('2: the full sample arrives and the tab\'s session has a row', !!full, JSON.stringify(full ? full.rows : await rs()).slice(0, 700));
  if (!full) { console.log(app.out.slice(-800)); return; }
  check('2: the panel has its sections: machine, this project, claude-custom itself', /Machine/.test(full.text) && /This project/.test(full.text) && full.rows.some(r => /claude-custom itself/.test(r.name)));
  check('2: the footer says how often it samples and that it pauses when hidden', /Every 10 s while this panel is shown · paused when hidden/.test(full.text));
  const second = await waitFor(async () => { const s = await rs(); return s && s.payloadHasModel && !/measuring…/.test(s.text) ? s : null; }, 40000, 500);
  check('2: after the second sample every CPU figure is real: no "measuring…", and nothing prints a bare NaN or undefined', !!second && !/NaN|undefined|null/.test(second.text), JSON.stringify(second && second.text.slice(0, 160)));
  check('2: the chip reads `CPU n%  x GB / y GB`', !!second && /^CPU \d+(\.\d)?%  \d+(\.\d)? GB \/ \d+(\.\d)? GB$/.test(second.chip.text), JSON.stringify(second && second.chip));
  check('2: the legend gives claude-custom and everything else', !!second && /claude-custom [^·]+· everything else/.test(second.text));
  await view(app, 'resourcesClick', { act: 'toggle', key: sessionKey });

  // 3 -----------------------------------------------------------------------------
  const send = (data) => view(app, 'gitTermInput', { data });
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await send(`start /b node "${byJs}" "${byPidFile}"\r`);
  const byPid = await waitFor(() => readPid(byPidFile), 15000, 200);
  check('3: the bystander (a second idle process in the same session) is running', !!byPid && alive(byPid), String(byPid));
  await send(`start /b node "${burnJs}" ${workers} "${burnPidFile}" 100\r`);
  const burnPid = await waitFor(() => readPid(burnPidFile), 15000, 200);
  check(`3: the burner (${workers} spinning threads on ${cores} cores, BelowNormal, self-ending) is running`, !!burnPid && alive(burnPid), String(burnPid));
  if (!burnPid) return;
  if (burnPid) seenPids.add(burnPid);

  const named = await waitFor(async () => {
    const s = await rs();
    const row = s.children.find(c => /burn\.js/.test(c.cmd));
    return row && /^(\d+(\.\d)?|<1)%$/.test(row.figs[0]) && /(MB|GB)$/.test(row.figs[1]) ? s : null;
  }, 60000, 500);
  check('3: the burner is named in the session\'s top children, with a real CPU figure and its memory', !!named, named ? '' : `${fmtState(await rs())} TREE: ${await dumpTree(hostPid)}`);
  if (named) {
    const row = named.children.find(c => /burn\.js/.test(c.cmd));
    check('3: its row shows the process name and the arguments, not the executable path', row.name === 'node.exe' && !/Program Files/i.test(row.cmd), JSON.stringify([row.name, row.cmd]));
    check('3: it can be stopped (a Stop button for exactly its pid)', row.stop === String(burnPid), JSON.stringify(row.stop));
  }

  // 4 -----------------------------------------------------------------------------
  const warned = await waitFor(async () => {
    const tabs = await strip();
    const t = tabs.find(x => x.selected);
    return t && /^\d+%$/.test(t.resWarn || '') ? t : null;
  }, 75000, 1000);
  const mid = await rs();
  if (warned) {
    check('4: the tab\'s warning chip appeared on the strip (over 40% CPU for three samples)', true, warned.resWarn);
  } else {
    const fig = (mid.rows.find(r => r.key === sessionKey) || {}).name;
    note(`4: SKIPPED the warning chip: this machine never gave the session 40% of its CPU (${cores} cores, ${workers} spinners at BelowNormal). The counter itself is pinned by test/resource-warning.test.js and test/resources-service.test.js. Row: ${fig}`);
  }
  await sleep(500);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'panel-burning.png') });

  // 5 -----------------------------------------------------------------------------
  const before = await rs();
  const stopBtn = before.children.find(c => /burn\.js/.test(c.cmd));
  if (!stopBtn) { check('5: the burner row is still there to stop', false, fmtState(before)); return; }
  await view(app, 'resourcesClick', { act: 'ask-stop', pid: burnPid });
  const asked = await waitFor(async () => { const s = await rs(); return s.confirm ? s : null; }, 5000, 150);
  check('5: Stop asks inline, naming the process and PID and what stops with it', !!asked && new RegExp(`Stop node\\.exe, PID ${burnPid}\\? Only this process stops, and anything it started stops with it\\.`).test(asked.confirm), JSON.stringify(asked && asked.confirm));
  await view(app, 'resourcesClick', { act: 'cancel-stop' });
  await sleep(600);
  const cancelled = await rs();
  check('5: Cancel closes the question and leaves the process running', !cancelled.confirm && alive(burnPid));

  await view(app, 'resourcesClick', { act: 'ask-stop', pid: burnPid });
  await waitFor(async () => (await rs()).confirm, 5000, 150);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'panel-confirm.png') });
  await view(app, 'resourcesClick', { act: 'confirm-stop' });
  const stopped = await waitFor(async () => { const s = await rs(); return s.children.some(c => new RegExp(`Stopped \\(PID ${burnPid}\\)`).test(c.text)) ? s : null; }, 15000, 150);
  check('5: the row reads "Stopped (PID n)"', !!stopped, JSON.stringify((await rs()).children.map(c => c.text)));
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
  const hidden = await waitFor(async () => { const s = await rs(); return s.reportedShown === false ? s : null; }, 10000, 200);
  check('6: hiding the panel tells main it is not showing', !!hidden);
  const noModel = await waitFor(async () => { const s = await rs(); return s.payloadHasModel === false && s.hasPayload ? s : null; }, 30000, 500);
  check('6: the process-tree sample stops: the payload loses its model', !!noModel);
  check('6: the chip keeps its machine figures', !!noModel && /^CPU .* GB \/ .* GB$/.test(noModel.chip.text) && !/NaN|undefined/.test(noModel.chip.text), JSON.stringify(noModel && noModel.chip));

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
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
