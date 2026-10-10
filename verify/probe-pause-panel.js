'use strict';
/**
 * PROBE: Pause / Resume in the Resources panel (BACKLOG #19), in a REAL window with a REAL host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-pause-panel.js        (exit 0 = every check held)
 *   PAUSE_PROBE_SHOTS=<dir>                                              where the screenshots go
 *
 * The unit tests pin the state machine, the guard and the HTML (test/process-suspend.test.js, test/pause-state.test.js,
 * test/resource-pause.test.js, test/resources-display-pause.test.js, test/agent-pause-display.test.js). No unit test can see the page:
 * every renderer script shares ONE global scope (CLAUDE.md), so a module can load in a test and still abort in the window. This starts a
 * real window and a real session host (the same harness as verify/probe-resource-panel.js), starts a heartbeat process IN the tab's
 * shell, and checks:
 *
 *   1  resources-display.js and agent-pause-display.js loaded in the shared plain-script scope
 *   2  the heartbeat's child row offers Pause (for exactly its pid)
 *   3  Pause: the row reads "paused HH:MM", offers Resume and Stop and no Pause, and the process is suspended for real: its heartbeat
 *      file stops growing while the process stays alive (the OS says so, not the panel)
 *   4  the paused row stays in the panel's list over several samples (a suspended process uses no CPU and must not sink out of it)
 *   5  Resume: the row is running again, the heartbeat grows again
 *   6  quitting the app with a process paused wakes it first (the heartbeat keeps growing after the window is gone)
 *   7  the paused set is kept on disk while something is paused (.harness/state/paused/paused-<pid>-<start>.json) and removed on Resume (PR #158 Miguel Y4)
 *
 * SAFE, as the Resources probe: the host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is sent; every
 * CLAUDE_CUSTOM_* variable of an enclosing tab and ELECTRON_RUN_AS_NODE are stripped; the project is a temp git repo and every state folder
 * a temp folder. Only PIDs this probe started or recorded WITH their start time are ended (verify/lib/seen-pids.js); the heartbeat ends
 * itself after 150 s at the latest. Nothing is ever suspended, stopped or killed by name, and anything this probe paused is resumed on every
 * exit path.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { suspendVerified } = require(path.join(ROOT, 'host', 'process-suspend'));
const { startTimes } = require(path.join(ROOT, 'host', 'proc-start'));
const { createExec } = require(path.join(ROOT, 'host', 'resource-sampler'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-pause-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.PAUSE_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-pause-panel');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

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
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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

// pid -> the start time it had when first seen: a pid is ended at the end ONLY while it is still the process that had that start time.
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

// Whatever this probe paused is woken again on every exit path (the proof is the recorded start time, on a held handle).
let pausedByUs = null;     // { pid, start }
async function wake() {
  if (!pausedByUs) return;
  const t = pausedByUs;
  pausedByUs = null;
  try { await suspendVerified('resume', [{ pid: t.pid, start: t.start }], { exec: createExec(20000) }); } catch { /* best effort */ }
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

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readPid = (file) => { try { const n = Number(fs.readFileSync(file, 'utf8')); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } };
// The paused-set files this run's app wrote that name `pid` (host/pause-persist.js).
const PAUSED_DIR = path.join(STATE_DIR, 'paused');
const persisted = (pid) => { try { return fs.readdirSync(PAUSED_DIR).filter(n => /^paused-\d+-(\d+|unknown)\.json$/.test(n)).filter(n => fs.readFileSync(path.join(PAUSED_DIR, n), 'utf8').includes(`"pid":${pid},`)); } catch { return []; } };
const beats = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

const HEARTBEAT = `'use strict';
const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => fs.appendFileSync(process.argv[3], Date.now() + '\\n'), 200);
setTimeout(() => process.exit(0), 150000);
`;

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  const hbJs = path.join(tmp, 'heartbeat.js');
  const hbPidFile = path.join(tmp, 'hb.pid');
  const hbFile = path.join(tmp, 'hb.txt');
  fs.writeFileSync(hbJs, HEARTBEAT);

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const st0 = await command(app, { cmd: 'state' });
  const tabKey = st0.selectedKey;
  const sessionKey = `s:${tabKey}`;
  const rs = () => view(app, 'resourcesState');

  await view(app, 'select', { id: 'resources' });
  const opened = await waitFor(async () => { const s = await rs(); return s && s.shown ? s : null; }, 10000, 200);
  check('1: the Resources panel opens', !!opened);
  check('1: resources-display.js and agent-pause-display.js loaded in the shared plain-script scope', !!opened && opened.scope === true && opened.pauseScope === true, JSON.stringify(opened && [opened.scope, opened.pauseScope]));
  const full = await waitFor(async () => { const s = await rs(); return s && s.payloadHasModel && s.rows.some(r => r.key === sessionKey) ? s : null; }, 60000, 300);
  check('the tab\'s session has a row', !!full);
  if (!full) { console.log(app.out.slice(-800)); return; }
  await view(app, 'resourcesClick', { act: 'toggle', key: sessionKey });

  // the heartbeat process, started IN the tab's shell
  const send = (data) => view(app, 'gitTermInput', { data });
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await send(`start /b node "${hbJs}" "${hbPidFile}" "${hbFile}"\r`);
  const hbPid = await waitFor(() => readPid(hbPidFile), 15000, 200);
  check('the heartbeat process is running', !!hbPid && alive(hbPid), String(hbPid));
  if (!hbPid) return;
  seenPids.see(hbPid);
  const hbStart = (await startTimes([hbPid])).get(hbPid);

  // 2 -----------------------------------------------------------------------------
  const offered = await waitFor(async () => {
    const s = await rs();
    const row = s.children.find(c => /heartbeat\.js/.test(c.cmd));
    return row && row.pause === String(hbPid) ? s : null;
  }, 60000, 500);
  check('2: the heartbeat\'s row offers Pause, for exactly its pid', !!offered, JSON.stringify((await rs()).children.map(c => [c.name, c.pause, c.stop])));
  if (!offered) return;

  // 3 -----------------------------------------------------------------------------
  const grew0 = beats(hbFile);
  await sleep(1200);
  check('3: before the pause the heartbeat is growing', beats(hbFile) > grew0);
  await view(app, 'resourcesClick', { act: 'pause', pid: hbPid });
  pausedByUs = { pid: hbPid, start: hbStart };
  const paused = await waitFor(async () => {
    const s = await rs();
    const row = s.children.find(c => /heartbeat\.js/.test(c.cmd));
    return row && row.paused && row.resume === String(hbPid) ? s : null;
  }, 30000, 300);
  check('3: the row reads "paused HH:MM" and offers Resume (and Stop), not Pause', !!paused, JSON.stringify((await rs()).children.map(c => [c.name, c.pause, c.resume, c.paused, c.text.slice(0, 60)])));
  if (paused) {
    const row = paused.children.find(c => /heartbeat\.js/.test(c.cmd));
    check('3: it says paused with a clock time', /paused \d\d:\d\d/.test(row.text), row.text.slice(0, 80));
    check('3: Stop is still offered on it', row.stop === String(hbPid));
    check('3: Pause is not offered on it', row.pause === null);
  }
  check('7: while it is paused the set is on disk (a crash can be undone at the next start)', persisted(hbPid).length === 1, JSON.stringify(persisted(hbPid)));
  const frozenAt = beats(hbFile);
  await sleep(4000);
  const frozenAfter = beats(hbFile);
  check('3: the process is really suspended: its heartbeat did not grow in 4 s, and it is still alive', frozenAfter <= frozenAt + 1 && alive(hbPid), `${frozenAt} -> ${frozenAfter}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'panel-paused.png') });

  // 4 -----------------------------------------------------------------------------
  let seenSamples = 0;
  let last = null;
  const stays = await waitFor(async () => {
    const s = await rs();
    const row = s.children.find(c => /heartbeat\.js/.test(c.cmd));
    if (!row || !row.paused) return { gone: true };
    const sig = JSON.stringify(s.machine);
    if (sig !== last) { last = sig; seenSamples++; }
    return seenSamples >= 3 ? s : null;
  }, 60000, 500);
  check('4: the paused row is still in the list after three more samples', !!stays && !stays.gone, JSON.stringify(stays && stays.gone ? 'row left' : seenSamples));

  // 5 -----------------------------------------------------------------------------
  await view(app, 'resourcesClick', { act: 'resume', pid: hbPid });
  const running = await waitFor(async () => {
    const s = await rs();
    const row = s.children.find(c => /heartbeat\.js/.test(c.cmd));
    return row && !row.paused && row.pause === String(hbPid) ? s : null;
  }, 30000, 300);
  pausedByUs = running ? null : pausedByUs;
  check('5: Resume: the row is running again and offers Pause', !!running, JSON.stringify((await rs()).children.map(c => [c.name, c.pause, c.resume, c.paused])));
  check('7: and once resumed the file no longer names it', persisted(hbPid).length === 0, JSON.stringify(persisted(hbPid)));
  const resumedAt = beats(hbFile);
  await sleep(1500);
  check('5: the heartbeat grows again', beats(hbFile) > resumedAt, `${resumedAt} -> ${beats(hbFile)}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'panel-resumed.png') });

  // 6 -----------------------------------------------------------------------------
  await view(app, 'resourcesClick', { act: 'pause', pid: hbPid });
  pausedByUs = { pid: hbPid, start: hbStart };
  const again = await waitFor(async () => { const s = await rs(); const row = s.children.find(c => /heartbeat\.js/.test(c.cmd)); return row && row.paused ? s : null; }, 30000, 300);
  check('6: paused again before the quit', !!again);
  const beforeQuit = beats(hbFile);
  await sleep(1500);
  const stillFrozen = beats(hbFile) <= beforeQuit + 1;
  check('6: and it is frozen', stillFrozen, `${beforeQuit} -> ${beats(hbFile)}`);
  // The way a closed window quits (app.quit(), will-quit runs), not the harness's hard exit.
  await command(app, { cmd: 'quit', graceful: true });
  await waitFor(() => app.exited, 30000);
  check('6: the app has quit', app.exited === true);
  const atQuit = beats(hbFile);
  const woke = await waitFor(() => (beats(hbFile) > atQuit + 2 ? true : null), 20000, 300);
  check('6: quitting with a process paused woke it first (its heartbeat grows with the window gone)', woke === true && alive(hbPid), `${atQuit} -> ${beats(hbFile)}`);
  if (woke) pausedByUs = null;

  const errors = (app.out.match(/\[renderer:[a-z]+\].*/g) || []).filter(l => /error|not defined|undefined is not|cannot read/i.test(l));
  check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`screenshots: ${shots}`);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(async () => {
    await wake();
    killEverything();
    layoutSnap.restore();
    treeSnap.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
