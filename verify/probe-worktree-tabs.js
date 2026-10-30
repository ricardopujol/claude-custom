'use strict';
/**
 * Worktree tabs, in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node verify/probe-worktree-tabs.js        (exit 0 = every check held)
 *
 * The unit tests pin the decisions (test/tab-shell.test.js, tab-lifecycle,
 * tab-model). Nothing else runs app/main.js, the strip page and the tab views
 * together, and that wiring is where the traps live: a `<script>` that
 * declares a name another one already took aborts SILENTLY in the shared
 * global scope (no unit test can see it), and an IPC gate compared to the
 * wrong webContents answers nobody. So this drives an actual Electron window.
 *
 * Against a throwaway container repo  <tmp>\proj\dev  (+ feat-a, feat-b made
 * with `git worktree add`), with one Electron process per "window":
 *   criterion 1  three tabs, dev first
 *   X5           only dev's host runs until another tab is selected
 *   (render)     the strip PAINTED the labels, and the selected view drew its page
 *   X5           selecting a tab starts its host
 *   criterion 8  close the window, reopen: every started tab reattaches, no
 *                new spawn, host pids unchanged
 *   W3           `git worktree add` while open -> a new tab within ~6 s
 *   criterion 5  hand close: that host exits, the folder is still there; reopen
 *                and the tab is back
 *   criterion 6  dev has no close, in the strip or by command
 *   raise        `raise` counts the OTHER clients: 1 with the window open, 0 after it
 *                closes (what Go to that session turns into words)
 *   launcher     opened from a sibling's folder, THAT tab is selected
 *   criterion 7  a flat repo opens single-tab
 *   explicit port  CLAUDE_CUSTOM_PORT keeps a window single-tab on one host on that
 *                port (the path every older probe and the hand check use), and the
 *                CLAUDE_CUSTOM_SCREENSHOT path captures the selected view AND the strip
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing runs
 * that bills; ELECTRON_RUN_AS_NODE is deleted before each window launch (Claude
 * Code is itself an Electron app and exports it); the registry, portraits and
 * uploads point at temp folders. The app is driven through
 * CLAUDE_CUSTOM_TABS_PROBE (app/main.js), which does nothing when unset.
 * Side effect, as in probe-session-lock-host.js: hosts allocate a port block in
 * the real ~\.claude-custom\worktree-ports.json for the temp repos; the folders
 * are deleted afterwards, so the next allocation gives the blocks back. WINDOWS
 * ONLY (cmd.exe, taskkill).
 *
 * Every host it started is killed by pid tree at the end (and on Ctrl+C), and
 * the temp repo is removed.
 */
const { spawn, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { sendControl } = require(path.join(ROOT, 'host', 'host-client'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-tabs-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const flat = path.join(tmp, 'flat');
const userData = path.join(tmp, 'user-data');
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args,
], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
let skipped = false;      // set when the app never came up, so later checks are not answered wrongly
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 20000, step = 250) {
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

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};

// --- the temp repos ---------------------------------------------------------------
function makeContainer() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', path.join(container, 'feat-a'), '-b', 'feat/a');
  git(dev, 'worktree', 'add', '-q', path.join(container, 'feat-b'), '-b', 'feat/b');
}
function makeFlat() {
  fs.mkdirSync(flat, { recursive: true });
  git(flat, 'init', '-q', '-b', 'main');
  git(flat, 'commit', '-q', '--allow-empty', '-m', 'init');
}

// --- one app instance = one "window" --------------------------------------------------
let windowNo = 0;
async function launchApp(cwd, extraEnv = {}) {
  windowNo++;
  const port = await freePort();
  // The driver runs only the commands that carry this (PR #75 M4).
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
  };
  // Claude Code is itself an Electron app: never let this leak into the window,
  // and never let a stray port/token make it single-tab or reuse a secret.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  Object.assign(env, extraEnv);
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_SCREENSHOT', 'CLAUDE_CUSTOM_SCREENSHOT_DELAY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
  hygiene.registerChild(child);
  const app = { no: windowNo, port, token, child, out: '', exited: false, exitCode: null };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', (code) => { app.exited = true; app.exitCode = code; hygiene.unregisterSpawnedTree(child.pid); });
  return app;
}

// One command, one reply. The driver answers newline-JSON on 127.0.0.1.
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

const state = (app) => command(app, { cmd: 'state' });
const labelsOf = (s) => (s && s.tabs ? s.tabs.map(t => t.label) : []);
const tabOf = (s, label) => (s && s.tabs ? s.tabs.find(t => t.label === label) : null);
const hostOf = (s, label) => (s && s.hosts ? s.hosts.find(h => h.label === label) : null);

async function driverUp(app) {
  return waitFor(async () => {
    if (app.exited) throw new Error('the app exited');
    const s = await state(app);
    return s && s.ok ? s : null;
  }, 40000, 500);
}

async function quit(app) {
  if (!app.exited) await command(app, { cmd: 'quit' }, 5000);
  await waitFor(() => app.exited, 15000, 200);
  if (!app.exited) hygiene._emergencyCleanup('quit-timeout');
}

// Identity files of the hosts serving folders inside `dir`: the ground truth of
// "which hosts are running", independent of what the window says.
function hostsUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const port = Number(f.replace(/\.json$/, ''));
    const id = readIdentity({ dir: HARNESS_DIR, port });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(dir).toLowerCase())) out.push(id);
  }
  return out;
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid); };

function killEverything() {
  for (const id of hostsUnder(tmp)) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}

function removeTemp() {
  // Unlink any junction/symlink first: removing through one would empty its
  // target. (None is made here; this is the habit, and it costs nothing.)
  for (const base of [dev, path.join(container, 'feat-a'), path.join(container, 'feat-b'), path.join(container, 'feat-c'), flat]) {
    const nm = path.join(base, 'node_modules');
    try { if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm); } catch { /* none */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}
hygiene.addCleanup(killEverything);

// --- the probe ---------------------------------------------------------------------------
async function main() {
  console.log('temp repo:', tmp);
  makeContainer();

  // ===== window 1 =====
  let app = await launchApp(container);
  let s = await driverUp(app);
  if (!s) {
    check('the window came up and its driver answers', false, `\n${app.out.split('\n').slice(-25).join('\n')}`);
    skipped = true;
    await quit(app);
    return;
  }
  check('the window came up and its driver answers', true, `pid ${app.child.pid}`);

  s = await waitFor(async () => { const x = await state(app); return labelsOf(x).length >= 3 ? x : null; }, 30000);
  remember(s);
  check('three tabs, dev first (criterion 1)',
    !!s && JSON.stringify(labelsOf(s)) === JSON.stringify(['develop', 'feat/a', 'feat/b']), s ? labelsOf(s).join(', ') : 'no tabs');
  check('the mode is tabs (a container, no explicit port)', !!s && s.mode === 'tabs', s && s.mode);

  // dev is selected and starts by itself.
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'develop') && tabOf(x, 'develop').started ? x : null; }, 40000);
  remember(s);
  check("dev's session started", !!s && !!tabOf(s, 'develop').started);
  const devHost = s && hostOf(s, 'develop');
  check("dev's host is running (its identity file names a live pid)", !!devHost && Number.isInteger(devHost.pid) && alive(devHost.pid),
    devHost && `pid ${devHost.pid} port ${devHost.port}`);
  if (!devHost || !Number.isInteger(devHost.pid)) skipped = true;

  if (!skipped) {
    // X5: nothing else runs. Judged from the identity files, not from the window.
    const running = hostsUnder(container);
    check('only dev\'s host runs until another tab is selected (X5)',
      running.length === 1 && path.resolve(running[0].cwd).toLowerCase() === path.resolve(dev).toLowerCase(),
      running.map(r => path.basename(r.cwd)).join(', '));
    check('the other lanes are not started (and, since #139, are Lanes menu rows rather than tabs)',
      !tabOf(s, 'feat/a').started && !tabOf(s, 'feat/b').started && s.lanes.notStarted.length === 2);

    // Criterion 6 (strip) and the render check: what the strip PAGE painted.
    s = await waitFor(async () => { const x = await state(app); return x.stripDom && x.stripDom.length === 1 ? x : null; }, 15000) || s;
    const dom = s.stripDom;
    check('the strip PAINTED dev alone (1B: the lanes nobody started are menu rows) (the page rendered)',
      Array.isArray(dom) && JSON.stringify(dom.map(d => d.label)) === JSON.stringify(['develop']),
      JSON.stringify(dom));
    check('the painted strip marks dev selected',
      Array.isArray(dom) && dom.length === 1 && dom[0].selected && !dom[0].dim);
    check('dev has no close button in the strip (criterion 6)',
      Array.isArray(dom) && dom.length === 1 && dom[0].hasClose === false);

    // The selected view: xterm mounted (renderer.js ran to the end: a duplicate
    // top-level name in the shared script scope would have aborted a file), and
    // the host's hello reached it (the header names the project and branch).
    const withView = await waitFor(async () => {
      const x = await state(app);
      return x.viewDom && x.viewDom.xterm > 0 && x.viewDom.hasTerm && /develop/.test(x.viewDom.title || '') ? x : null;
    }, 30000);
    check("the selected tab's page rendered and connected (xterm mounted, header shows the branch)", !!withView,
      JSON.stringify((withView || (await state(app))).viewDom));
    const shot = path.join(tmp, 'shot.png');
    const r = await command(app, { cmd: 'screenshot', file: shot });
    const pngOk = (f) => { try { const b = fs.readFileSync(f); return b.length > 2000 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'; } catch { return false; } };
    check('a screenshot of the strip is a real image', !!r.ok && pngOk(r.stripFile), r.ok ? `${r.stripBytes} bytes` : r.error);
    check('a screenshot of the selected view is a real image', !!r.ok && pngOk(shot), r.ok ? `${r.viewBytes} bytes` : r.error);

    // Criterion 6, by command: dev cannot be closed.
    const devClose = await command(app, { cmd: 'close', label: 'develop' });
    s = await state(app);
    check('dev cannot be closed by command either (criterion 6)', devClose.ok === false && !!tabOf(s, 'develop'),
      JSON.stringify(devClose));

    // X5: selecting a tab starts its host.
    const sel = await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
    s = await state(app);
    remember(s);
    const aHost = hostOf(s, 'feat/a');
    check('selecting a tab starts its session (X5)', !!sel.ok && sel.started === true && !!aHost && alive(aHost.pid),
      JSON.stringify(sel));
    check('and it is its own host on its own port', !!aHost && !!devHost && aHost.pid !== devHost.pid && aHost.port !== devHost.port,
      aHost && `pid ${aHost.pid} port ${aHost.port}`);
    check('feat/b is still not started', !!tabOf(s, 'feat/b') && !tabOf(s, 'feat/b').started);
    check('the strip shows feat/a selected', (await state(app)).tabs.find(t => t.selected).label === 'feat/a');

    // ===== no menu bar; Ctrl+Tab from the keyboard path =====
    check('the window has no menu bar (no application menu, none on the window)', (await state(app)).noMenuBar === true,
      String((await state(app)).noMenuBar));
    // A synthetic key sent to the SELECTED VIEW's webContents: it goes through
    // before-input-event, the same path as a real key while typing in the terminal.
    const selectedLabel = async () => ((await state(app)).tabs.find(t => t.selected) || {}).label;
    const kPrev = await command(app, { cmd: 'key', key: 'Tab', modifiers: ['control', 'shift'] });
    const afterPrev = await waitFor(async () => (await selectedLabel()) === 'develop', 5000, 200);
    check('Ctrl+Shift+Tab sent to the selected view selects the previous tab', !!kPrev.ok && !!afterPrev, JSON.stringify(kPrev));
    const kNext = await command(app, { cmd: 'key', key: 'Tab', modifiers: ['control'] });
    const afterNext = await waitFor(async () => (await selectedLabel()) === 'feat/a', 5000, 200);
    check('Ctrl+Tab sent to the selected view selects the next tab', !!kNext.ok && !!afterNext, JSON.stringify(kNext));
    const kPlain = await command(app, { cmd: 'key', key: 'Tab', modifiers: [] });
    await sleep(800);
    check('a plain Tab is NOT intercepted (the selection does not move)', !!kPlain.ok && (await selectedLabel()) === 'feat/a');

    // ===== raise: windows counts the window(s), never the sender =====
    const tokenOf = (port) => fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${port}.token`), 'utf8').trim();
    const raiseOpen = aHost ? await sendControl({ port: aHost.port, token: tokenOf(aHost.port), msg: { type: 'raise' } }) : null;
    check('a raise to a host with its window open answers windows: 1 (the sender is not a window)',
      !!raiseOpen && raiseOpen.ok === true && raiseOpen.reply.windows === 1, JSON.stringify(raiseOpen));

    // ===== criterion 8: close the window, reopen =====
    const before = { dev: devHost.pid, a: aHost && aHost.pid, count: hostsUnder(container).length };
    await quit(app);
    check('closing the window leaves the hosts running (detach)', alive(before.dev) && alive(before.a));
    const raiseShut = aHost ? await waitFor(async () => {
      const r = await sendControl({ port: aHost.port, token: tokenOf(aHost.port), msg: { type: 'raise' } });
      return r.ok && r.reply.windows === 0 ? r : null;
    }, 8000, 300) : null;
    check('with the window closed, a raise answers windows: 0 -- "no window open" is reachable', !!raiseShut);

    app = await launchApp(container);
    s = await driverUp(app);
    if (!s) { check('the window reopened', false, app.out.split('\n').slice(-15).join('\n')); skipped = true; return; }
    s = await waitFor(async () => {
      const x = await state(app);
      return tabOf(x, 'develop') && tabOf(x, 'develop').started && tabOf(x, 'feat/a') && tabOf(x, 'feat/a').started ? x : null;
    }, 40000);
    remember(s);
    check('reopened: every started tab reattached, without being selected (criterion 8)', !!s);
    if (s) {
      check('and feat/b, which was never started, is still not', !tabOf(s, 'feat/b').started);
      check('reattached to the SAME hosts: pids unchanged, no new spawn (criterion 8)',
        hostOf(s, 'develop').pid === before.dev && hostOf(s, 'feat/a').pid === before.a && hostsUnder(container).length === before.count,
        `dev ${hostOf(s, 'develop').pid}/${before.dev}, feat/a ${hostOf(s, 'feat/a').pid}/${before.a}, hosts ${hostsUnder(container).length}/${before.count}`);
    }

    // ===== W3: a worktree added while the window is open =====
    const t0 = Date.now();
    git(dev, 'worktree', 'add', '-q', path.join(container, 'feat-c'), '-b', 'feat/c');
    const appeared = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/c') ? x : null; }, 12000, 300);
    const took = Date.now() - t0;
    check('a worktree added while open becomes a tab within ~6 s (W3)', !!appeared && took <= 7000, `${took} ms`);
    check('and it is not started', !!appeared && !tabOf(appeared, 'feat/c').started);

    // ===== criterion 5: hand close =====
    const aPid = hostOf(await state(app), 'feat/a').pid;
    const closed = await command(app, { cmd: 'close', label: 'feat/a' });
    check('hand close succeeds (auto-confirmed under the driver)', closed.ok === true, JSON.stringify(closed));
    const gone = await waitFor(async () => !alive(aPid), 15000, 250);
    check("hand close ends that tab's host (criterion 5)", !!gone && Number.isInteger(aPid), `pid ${aPid}`);
    s = await state(app);
    check('and the tab is gone from the strip', !tabOf(s, 'feat/a'), labelsOf(s).join(', '));
    check('the folder is still there, and git still lists the worktree',
      fs.existsSync(path.join(container, 'feat-a')) &&
      /feat-a/.test(git(dev, 'worktree', 'list', '--porcelain')));
    await sleep(3500);   // a poll happens: git still lists it, so it must stay closed
    check('it stays closed while git lists it (dismissed for this window)', !tabOf(await state(app), 'feat/a'));
    check('the other hosts are unaffected', alive(before.dev));

    // ===== the launcher: opened from a sibling's folder, THAT tab is selected =====
    await quit(app);
    app = await launchApp(path.join(container, 'feat-b'));
    s = await driverUp(app);
    if (!s) { check('the window reopened from a sibling', false, app.out.split('\n').slice(-15).join('\n')); return; }
    s = await waitFor(async () => { const x = await state(app); return labelsOf(x).length >= 3 ? x : null; }, 30000);
    remember(s);
    check('reopened: the closed tab stays closed (#141 closed stays closed: it is kept per project) and is a closed Lanes row',
      !!s && !tabOf(s, 'feat/a') && labelsOf(s).length === 3 && s.lanes.notStarted.some(r => r.label === 'feat/a' && r.closed === true), s && labelsOf(s).join(', '));
    // Judged before the Reopen: since #139 a Reopen selects the lane it brings back (a Lanes row is a click), so feat/a is selected after it.
    check('launched from feat-b\'s folder: THAT tab is selected', !!s && (tabOf(s, 'feat/b') || {}).selected === true,
      s && s.tabs.filter(t => t.selected).map(t => t.label).join(','));
    const back = await command(app, { cmd: 'reopen' });
    s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/a') ? x : null; }, 15000);
    check('Reopen brings it back, and selects it (a Lanes row is a click)', back.ok === true && !!s && (tabOf(s, 'feat/a') || {}).selected === true);
    const bUp = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/b') && tabOf(x, 'feat/b').started ? x : null; }, 40000);
    remember(bUp);
    check('and the selected tab started', !!bUp);
    check('dev\'s session was reattached, not respawned',
      !!bUp && hostOf(bUp, 'develop') && hostOf(bUp, 'develop').pid === before.dev);
    await quit(app);

    // ===== PR #75 F1 / criterion 8: a stepped tab survives its neighbour closing =====
    // Two worktrees whose paths hash to ONE port. The second's host is stepped
    // up; close the first by hand, close the window, reopen: the second must
    // still be attached (the old walk met the first's FREE port and drew it
    // "not started" while its session ran on).
    const { portForCwd } = require(path.join(ROOT, 'host', 'port-for-project'));
    const coll = path.join(tmp, 'coll');
    const names = Array.from({ length: 200 }, (_, i) => `w${i}`);
    const seenHash = new Map();
    let pair = null;
    for (const n of names) {
      const h = portForCwd(path.join(coll, n));
      if (seenHash.has(h)) { pair = [seenHash.get(h), n]; break; }
      seenHash.set(h, n);
    }
    if (!pair) {
      console.log('SKIP  no two worktree names collided on the port hash; the stepped-tab check was not run');
    } else {
      const cdev = path.join(coll, 'dev');
      fs.mkdirSync(cdev, { recursive: true });
      git(cdev, 'init', '-q', '-b', 'develop');
      git(cdev, 'commit', '-q', '--allow-empty', '-m', 'init');
      for (const n of pair) git(cdev, 'worktree', 'add', '-q', path.join(coll, n), '-b', `feat/${n}`);
      const [first, second] = pair.map(n => `feat/${n}`);
      app = await launchApp(coll);
      s = await driverUp(app);
      if (!s) { check('the collision window came up', false, app.out.split('\n').slice(-15).join('\n')); return; }
      await waitFor(async () => { const x = await state(app); return labelsOf(x).length >= 3 ? x : null; }, 30000);
      await command(app, { cmd: 'select', label: first }, 60000);
      await command(app, { cmd: 'select', label: second }, 60000);
      s = await state(app);
      remember(s);
      const h1 = hostOf(s, first);
      const h2 = hostOf(s, second);
      check('two worktrees hashing to one port: the second is STEPPED to another port',
        !!h1 && !!h2 && h1.port !== h2.port && alive(h1.pid) && alive(h2.pid),
        h1 && h2 && `${first} ${h1.port}, ${second} ${h2.port}`);
      if (h1 && h2) {
        const closed1 = await command(app, { cmd: 'close', label: first });
        const gone1 = await waitFor(async () => !alive(h1.pid), 15000, 250);
        check('the first is closed by hand and its host ends', closed1.ok === true && !!gone1, JSON.stringify(closed1));
        const count = hostsUnder(coll).length;
        await quit(app);
        app = await launchApp(coll);
        s = await driverUp(app);
        if (!s) { check('the collision window reopened', false, app.out.split('\n').slice(-15).join('\n')); return; }
        s = await waitFor(async () => {
          const x = await state(app);
          return tabOf(x, second) && tabOf(x, second).started ? x : null;
        }, 40000);
        remember(s);
        check('reopened: the stepped tab is still ATTACHED to its own host, pid unchanged, nothing spawned',
          !!s && hostOf(s, second) && hostOf(s, second).pid === h2.pid && hostsUnder(coll).length === count,
          s ? `${second}: ${hostOf(s, second) && hostOf(s, second).pid}/${h2.pid}, hosts ${hostsUnder(coll).length}/${count}` : JSON.stringify(await state(app)).slice(0, 1500));
        await quit(app);
      }
    }

    // ===== criterion 7: a flat repo is single-tab =====
    makeFlat();
    app = await launchApp(flat);
    s = await driverUp(app);
    if (!s) { check('the flat window came up', false, app.out.split('\n').slice(-15).join('\n')); return; }
    s = await waitFor(async () => { const x = await state(app); return x.tabs && x.tabs[0] && x.tabs[0].started ? x : null; }, 40000);
    remember(s);
    check('a flat repo opens single-tab (criterion 7)', !!s && s.mode === 'single' && s.tabs.length === 1,
      s && `${s.mode}, ${s.tabs.length} tab(s)`);
    check('with no close, in the model or in the strip',
      !!s && s.tabs[0].closable === false && Array.isArray(s.stripDom) && s.stripDom.length === 1 && s.stripDom[0].hasClose === false);
    check('and its session started', !!s && s.tabs[0].started && !!hostOf(s, s.tabs[0].label) && alive(hostOf(s, s.tabs[0].label).pid));
    await quit(app);

    // ===== CLAUDE_CUSTOM_PORT: one host on one folder, by port, unchanged =====
    // The launch every older probe and the hand check use. Even at a CONTAINER
    // path it must stay one tab on that folder, on exactly that port.
    const xport = await freePort();
    const shot2 = path.join(tmp, 'explicit.png');
    app = await launchApp(container, {
      CLAUDE_CUSTOM_PORT: String(xport), CLAUDE_CUSTOM_TOKEN: 'probe-explicit-token',
      CLAUDE_CUSTOM_SCREENSHOT: shot2, CLAUDE_CUSTOM_SCREENSHOT_DELAY: '16000',
    });
    const up = await waitFor(() => app.exited || /probe driver listening/.test(app.out), 40000, 250);
    check('the explicit-port window came up', !!up && !app.exited, app.exited ? `exited ${app.exitCode}` : '');
    const listeningNow = await waitFor(() => new Promise((res) => {
      const sock = net.connect({ host: '127.0.0.1', port: xport });
      sock.once('connect', () => { sock.destroy(); res(true); });
      sock.once('error', () => res(false));
    }), 30000, 300);
    const xid = await waitFor(() => readIdentity({ dir: HARNESS_DIR, port: xport }), 10000, 250);
    if (xid) seenPids.add(xid.pid, xid.processStartedAt);
    check('its host is on EXACTLY the named port and serves the folder it was given',
      !!listeningNow && !!xid && path.resolve(xid.cwd).toLowerCase() === path.resolve(container).toLowerCase(),
      xid ? `port ${xport}, cwd ${xid.cwd}` : 'no identity');
    const xs = await state(app);
    check('and the window is single-tab, not a tab shell (CLAUDE_CUSTOM_PORT set)',
      !!xs && xs.mode === 'single' && xs.tabs.length === 1 && xs.tabs[0].closable === false, xs && `${xs.mode}, ${(xs.tabs || []).length} tab(s)`);
    await waitFor(() => app.exited, 40000, 300);
    check('the screenshot path finished and exited on its own', app.exited && app.exitCode === 0, `exit ${app.exitCode}`);
    const pngOk2 = (f) => { try { const b = fs.readFileSync(f); return b.length > 2000 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'; } catch { return false; } };
    check('it captured the selected view', pngOk2(shot2), shot2);
    check('and the strip beside it', pngOk2(shot2.replace(/.png$/i, '.strip.png')));
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.log(`FAIL  the probe threw: ${err && err.stack || err}`);
    failures++;
  } finally {
    hygiene._emergencyCleanup('done');     // kills the window(s) and, via the cleanup, every host it started
    await sleep(800);
    removeTemp();
  }
  // A SKIPPED run is not a passing run (see verify/probe-multi-project.js): the
  // checks that were never answered must not read as success.
  if (skipped) {
    console.log(`\n${failures} FAILED -- the app or dev's host did not start, so the rest was never measured`);
    process.exit(1);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
