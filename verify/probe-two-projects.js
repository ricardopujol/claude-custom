'use strict';
/**
 * PROBE: two project windows in ONE Electron process (single-instance PR 2, DESIGN_SINGLE_INSTANCE.md 3.2 and 7.2) in REAL windows.
 * (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-two-projects.js        (exit 0 = every check held)
 *
 * It is still one LAUNCH = one process (the app lock is PR 3). The probe driver's `openProject` opens a second project's window in the
 * process that is already running, and every command names its window by project root (`window`), so this proves the routing: each
 * window's IPC reaches its own state, install-wide settings reach both, a project's layout stays its own, closing one window leaves the
 * other running, and closing the last ends the process.
 *
 *   1  launch A: `windows` lists one window; note the Electron main pid
 *   2  `openProject` B: `windows` lists two, the SAME pid, one Electron main under the probe's user-data; B's state is B's tabs; A's did not
 *      move; `openProject` on an open root focuses it (existing); outside the temp folder it is refused; an unknown `window` is refused
 *   3  routing: `select` in B moves B's selected tab and not A's; the Lean button in B's strip makes B lean and not A; Ctrl+Shift+F in B's view
 *      turns B's focus mode on and not A's
 *   4  install-wide: the interface font written to the shared store reaches BOTH windows' strips (main pushes to every window)
 *   5  per-project layout: a dock change in A is written to A's own `.claude-custom\layout-tree.json` and B's file is untouched
 *   6  `win-close` on B: `windows` lists one, the process is alive, B's session host is still running (a window closing detaches), A
 *      still polls (a worktree added to A on disk shows as a tab) and answers
 *   7  `win-close` on A, the last window: the quit path runs (window-all-closed, before-quit, every will-quit listener: read from the quit log) and the process exits 0
 *
 * SAFE. Two scratch projects in a temp folder (never dev\), the hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), ELECTRON_RUN_AS_NODE and
 * every CLAUDE_CUSTOM_* the probe doesn't set are deleted by the launcher, registry / portraits / uploads / UI state / user data are temp
 * folders (ONE_WINDOW_PROBE is NOT set: the claim is off for probe windows). Every host whose folder is inside the probe's temp folder is
 * stopped by pid at the end.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-two-projects-');
const userData = path.join(tmp, 'user-data');
const uiState = path.join(tmp, 'ui-state');
fs.mkdirSync(uiState, { recursive: true });

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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_UI_STATE_DIR', 'CLAUDE_CUSTOM_QUIT_LOG'];
const QUIT_LOG = path.join(tmp, 'quit.log');   // the quit's own timeline (app/quit-log.js): which step of the way out ran, however long Chromium then takes

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
    CLAUDE_CUSTOM_QUIT_LOG: QUIT_LOG,
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false, exitCode: null };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', (code) => { app.exited = true; app.exitCode = code; hygiene.unregisterSpawnedTree(child.pid); });
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

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

function makeProject(name) {
  const container = path.join(tmp, name);
  const dev = path.join(container, 'dev');
  const featA = path.join(container, 'feat-a');
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
  return { container, dev, featA, layoutFile: path.join(dev, '.claude-custom', 'layout-tree.json') };
}

const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// A window's command: `window` names it by project root (the launch window when absent).
async function stateOf(app, root) {
  const st = await command(app, { cmd: 'state', ...(root ? { window: root } : {}) });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
}
const win = (app, root, cmd) => command(app, { ...cmd, window: root });

async function windowUp(app, root) {
  return waitFor(async () => {
    const st = await stateOf(app, root);
    return st && st.ok && st.stripDom && Array.isArray(st.hosts) && st.hosts.length >= 2 && st.hosts.every(h => h.started !== undefined) ? st : null;
  }, 150000);
}

// Electron MAIN processes (not helpers) started with this probe's user-data dir: a read-only look at the process table.
function electronMainsUnderUserData() {
  try {
    const needle = userData.replace(/'/g, "''");
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*--user-data-dir=${needle}*' -and $_.CommandLine -notlike '*--type=*' }).Count`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return Number(out.trim());
  } catch { return null; }
}

async function main() {
  const A = makeProject('proj-a');
  const B = makeProject('proj-b');

  // 1 ---------------------------------------------------------------------------------
  const app = await launchApp(A.container);
  const stA0 = await windowUp(app);
  check('1: A (the launch window) came up with its tabs', !!stA0, stA0 ? '' : app.out.slice(-600));
  if (!stA0) return;
  const w1 = await command(app, { cmd: 'windows' });
  check('1: `windows` lists one window, the launch window', w1.ok === true && w1.windows.length === 1 && w1.windows[0].launch === true, JSON.stringify(w1));
  const aRoot = w1.windows[0].root;
  const pid = w1.pid;
  check('1: the pid it reports is the Electron main this probe started', pid === app.child.pid, `pid=${pid} child=${app.child.pid}`);
  const aDevKey = (stA0.hosts.find(h => h.label === 'develop') || {}).key;
  check('1: A has develop selected', !!aDevKey && stA0.selectedKey === aDevKey);

  // 2 ---------------------------------------------------------------------------------
  const refused = await command(app, { cmd: 'openProject', cwd: ROOT });
  check('2: openProject refuses a folder outside the temp folder (never a real project)', refused.ok === false && /scratch folder/.test(refused.error || ''), JSON.stringify(refused));
  const noWin = await command(app, { cmd: 'state', window: path.join(tmp, 'nope') });
  check('2: an unknown `window` is refused', noWin.ok === false && noWin.error === 'no such window', JSON.stringify(noWin));
  const opened = await command(app, { cmd: 'openProject', cwd: B.dev }, 120000);
  check('2: openProject B opened a second project window in this process', opened.ok === true && opened.existing === false && opened.pid === pid, JSON.stringify(opened));
  const bRoot = opened.root;
  const w2 = await command(app, { cmd: 'windows' });
  check('2: `windows` lists two windows, in the SAME process', w2.ok === true && w2.windows.length === 2 && w2.pid === pid && w2.windows.some(w => w.root === bRoot), JSON.stringify(w2));
  const mains = electronMainsUnderUserData();
  check('2: ...and there is exactly one Electron main process under the probe\'s user-data', mains === 1, `mains=${mains}`);
  const stB = await windowUp(app, bRoot);
  check('2: B\'s state shows B\'s tabs (develop and feat/a, inside B)', !!stB && stB.hosts.every(h => h.cwd.toLowerCase().startsWith(path.resolve(B.container).toLowerCase())) && stB.hosts.length === 2,
    stB ? JSON.stringify(stB.hosts.map(h => [h.label, h.cwd])) : 'no B state');
  const stA1 = await stateOf(app, aRoot);
  check('2: A\'s state did not move', stA1.selectedKey === aDevKey && stA1.hosts.length === 2, `selected=${stA1.selectedKey}`);
  const again = await command(app, { cmd: 'openProject', cwd: B.dev });
  check('2: openProject on an open root focuses it instead (existing: true), still two windows', again.ok === true && again.existing === true && (await command(app, { cmd: 'windows' })).windows.length === 2, JSON.stringify(again));
  if (!stB) return;
  const bDevKey = (stB.hosts.find(h => h.label === 'develop') || {}).key;
  const bFeatKey = (stB.hosts.find(h => h.label === 'feat/a') || {}).key;
  const bHostPids = stB.hosts.map(h => h.pid).filter(Number.isInteger);

  // 3 ---------------------------------------------------------------------------------
  const sel = await win(app, bRoot, { cmd: 'select', label: 'feat/a' });
  const stB3 = await waitFor(async () => { const s = await stateOf(app, bRoot); return s.selectedKey === bFeatKey ? s : null; }, 30000);
  const stA3 = await stateOf(app, aRoot);
  check('3: select in B moves B\'s selected tab to feat/a', sel.ok === true && !!stB3 && !!bFeatKey, JSON.stringify(sel));
  check('3: ...and A\'s selected tab did not move', stA3.selectedKey === aDevKey, `A selected=${stA3.selectedKey}`);

  const lean = await win(app, bRoot, { cmd: 'strip-lean', button: 'lean-btn' });
  const bLean = await waitFor(async () => { const s = await stateOf(app, bRoot); return s.stripChrome && s.stripChrome.lean && s.stripChrome.lean.bodyLean ? s : null; }, 15000);
  const aLean = await stateOf(app, aRoot);
  check('3: pressing Lean in B\'s strip makes B lean', lean.ok === true && !!bLean && bLean.lean && bLean.lean.on === true, JSON.stringify(lean));
  check('3: ...and A is not lean (its strip, and its own state)', aLean.stripChrome.lean.bodyLean === false && aLean.lean && aLean.lean.on === false,
    JSON.stringify({ strip: aLean.stripChrome.lean.bodyLean, lean: aLean.lean }));
  await win(app, bRoot, { cmd: 'strip-lean', button: 'lean-back' });   // B back to normal: nothing left for the next check

  await sleep(500);
  const key = await win(app, bRoot, { cmd: 'key', key: 'F', modifiers: ['control', 'shift'] });
  const bFocus = await waitFor(async () => { const s = await stateOf(app, bRoot); return s.focusMode === true ? s : null; }, 15000);
  const aFocus = await stateOf(app, aRoot);
  check('3: Ctrl+Shift+F in B\'s view turns B\'s focus mode on', key.ok === true && !!bFocus, JSON.stringify(key));
  check('3: ...and A\'s focus mode stays off', aFocus.focusMode === false, `A focusMode=${aFocus.focusMode}`);
  await win(app, bRoot, { cmd: 'key', key: 'F', modifiers: ['control', 'shift'] });

  // 4 ---------------------------------------------------------------------------------
  fs.writeFileSync(path.join(uiState, 'fonts-global.json.tmp'), JSON.stringify({ uiFont: 'Consolas' }));
  fs.renameSync(path.join(uiState, 'fonts-global.json.tmp'), path.join(uiState, 'fonts-global.json'));
  const fontBoth = await waitFor(async () => {
    const a = await stateOf(app, aRoot); const b = await stateOf(app, bRoot);
    return /Consolas/.test(a.fontUi || '') && /Consolas/.test(b.fontUi || '') ? { a: a.fontUi, b: b.fontUi } : null;
  }, 20000);
  check('4: an install-wide setting (the interface font) reaches the strips of BOTH windows', !!fontBoth, fontBoth ? JSON.stringify(fontBoth) : 'one of them never got it');

  // 5 ---------------------------------------------------------------------------------
  const bBefore = readText(B.layoutFile);
  const aBefore = readText(A.layoutFile);
  const hide = await win(app, aRoot, { cmd: 'view', action: 'hide', args: { id: 'git' } });
  const aWrote = await waitFor(() => { const t = readText(A.layoutFile); return t !== null && t !== aBefore ? t : null; }, 20000);
  await sleep(1500);
  check('5: a dock change in A (hide a panel) is written to A\'s own layout file', hide.ok === true && !!aWrote, JSON.stringify(hide).slice(0, 200));
  check('5: ...and B\'s layout file is exactly what it was', readText(B.layoutFile) === bBefore, `B before=${bBefore === null ? 'missing' : bBefore.length + ' bytes'}`);

  // 6 ---------------------------------------------------------------------------------
  const closed = await win(app, bRoot, { cmd: 'win-close' });
  const w6 = await waitFor(async () => { const w = await command(app, { cmd: 'windows' }); return w.ok && w.windows.length === 1 ? w : null; }, 30000);
  check('6: closing B leaves one window, and it is A', closed.ok === true && !!w6 && w6.windows[0].root === aRoot, JSON.stringify(w6));
  check('6: ...the process is still alive', isRunning(pid) && !app.exited);
  check('6: ...and B\'s session hosts are still running (a window closing detaches, it does not end the session)', bHostPids.length > 0 && bHostPids.every(isRunning), `pids=${bHostPids.join(',')}`);
  const noB = await win(app, bRoot, { cmd: 'state' });
  check('6: B is no longer addressable', noB.ok === false && noB.error === 'no such window', JSON.stringify(noB));
  git(A.dev, 'worktree', 'add', '-q', path.join(A.container, 'feat-b'), '-b', 'feat/b');
  const polled = await waitFor(async () => { const s = await stateOf(app, aRoot); return s.ok && s.hosts.some(h => h.label === 'feat/b') ? s : null; }, 30000, 500);
  check('6: A still polls: a worktree added on disk shows as a tab within a few polls', !!polled);
  check('6: ...and A answers', (await stateOf(app, aRoot)).ok === true);

  // 7 ---------------------------------------------------------------------------------
  const quitLines = () => (readText(QUIT_LOG) || '').split('\n');
  check('7: (control) closing B, a window of two, did not start a quit', !quitLines().some(l => /window-all-closed|before-quit/.test(l)), quitLines().slice(0, 6).join(' | '));
  await win(app, aRoot, { cmd: 'win-close' });
  const quitPath = await waitFor(() => (quitLines().some(l => /will-quit last/.test(l)) ? true : null), 60000, 500);
  check('7: closing the last window runs the quit path (window-all-closed, before-quit, every will-quit listener)', quitPath === true
    && ['window-all-closed', 'before-quit'].every(s => quitLines().some(l => l.endsWith(` ${s}`))), quitLines().filter(Boolean).slice(-8).join(' | '));
  // Chromium's own shutdown can take minutes on this machine (BACKLOG #74 A, verify/probe-quit-linger.js), so the exit is polled for ten.
  const gone = await waitFor(() => (app.exited ? true : null), 600000, 1000);
  check('7: ...and the process ends with exit code 0', gone === true && app.exitCode === 0, `exited=${app.exited} code=${app.exitCode}`);
}

main()
  .catch((err) => { console.log('FAIL  the probe threw: ' + ((err && err.stack) || err)); failures++; })
  .finally(() => {
    killEverything();
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
