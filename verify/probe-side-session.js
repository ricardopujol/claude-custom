'use strict';
/**
 * The standing read-only side session (BACKLOG #81), in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node verify/probe-side-session.js [screenshot-dir]        (exit 0 = every check held)
 *
 * test/tab-shell-side.test.js pins the lifecycle and test/side-session.test.js the host-level pieces. Nothing else runs
 * app/main.js, the strip page, the tab views and a second real host together, and that is where this feature can lie:
 * the side host must really be a SECOND host on the same folder, running claude in plan mode and never with permissions
 * bypassed, must take no session lock, and must be found again as itself and never as the folder's own host.
 *
 * Against a throwaway container repo  <tmp>\proj\dev  (+ feat-a, feat-b made with `git worktree add`):
 *   open       Open side session on feat/a: a tab "feat/a · side" right after feat/a, selected, started, small, no close
 *   argv       the side claude's command line has `--permission-mode plan` and not `--dangerously-skip-permissions`; the
 *              branch tab's claude is the other way round (the ground truth of "read-only", read off the OS)
 *   hosts      two hosts for one folder: different pids and ports, the identity file says side:true for one only
 *   lock       the side host does not hold the worktree's session lock; the branch tab's host does
 *   once       opening it again spawns nothing (same pid, one tab)
 *   stays      selecting another tab leaves it running
 *   reopen     stop the side host: its tab says it ended; Open side session again starts a fresh host, still one tab
 *   adopt      close the window and reopen: the running side host comes back as the side tab, same pid, nothing spawned
 *   ends       hand-closing feat/a ends BOTH hosts and removes both tabs
 *   shots      screenshots of the strip with the side tab (two states) land in the directory named (default: the temp dir)
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing runs that bills; ELECTRON_RUN_AS_NODE is deleted
 * before each window launch (Claude Code is itself an Electron app and exports it); the registry, portraits and uploads
 * point at temp folders. The app is driven through CLAUDE_CUSTOM_TABS_PROBE (app/main.js), which does nothing when unset.
 * Every process it started is ended through host/kill-tree.js by pid AND start time (verify/lib/seen-pids.js), never by name.
 * WINDOWS ONLY (cmd.exe).
 */
const { execFileSync } = require('child_process');
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
  console.log('SKIP: this probe drives cmd.exe; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-side-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const shotDir = process.argv[2] ? path.resolve(process.argv[2]) : tmp;
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

function makeContainer() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
  git(dev, 'worktree', 'add', '-q', path.join(container, 'feat-b'), '-b', 'feat/b');
}

// --- one app instance = one "window" --------------------------------------------------
let windowNo = 0;
async function launchApp(cwd) {
  windowNo++;
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
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
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
const domOf = (s, label) => (s && Array.isArray(s.stripDom) ? s.stripDom.find(d => d.label === label) : null);
const SIDE_A = 'feat/a \u00b7 side';

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

// The raw identity files of the hosts serving `dir` (the OS-level ground truth of which hosts run), side flag included.
function identitiesUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const port = Number(f.replace(/\.json$/, ''));
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'hosts', f), 'utf8')); } catch { continue; }
    const id = readIdentity({ dir: HARNESS_DIR, port });
    if (id && raw && path.resolve(id.cwd).toLowerCase() === path.resolve(dir).toLowerCase()) out.push({ ...id, claudePid: raw.claudePid, processStartedAt: raw.processStartedAt });
  }
  return out;
}

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function commandLineOf(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  } catch { return null; }
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid); };

function killEverything() {
  for (const id of identitiesUnder(featA).concat(identitiesUnder(dev), identitiesUnder(path.join(container, 'feat-b')))) {
    seenPids.add(id.pid, id.processStartedAt);
  }
  seenPids.endAll();
}

function removeTemp() {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}
hygiene.addCleanup(killEverything);

const tokenOf = (port) => fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${port}.token`), 'utf8').trim();
const pngOk = (f) => { try { const b = fs.readFileSync(f); return b.length > 2000 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'; } catch { return false; } };

// --- the probe ---------------------------------------------------------------------------
async function main() {
  console.log('temp repo:', tmp);
  fs.mkdirSync(shotDir, { recursive: true });
  makeContainer();

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
  check('three tabs, dev first, and no side tab until one is asked for',
    !!s && JSON.stringify(labelsOf(s)) === JSON.stringify(['develop', 'feat/a', 'feat/b']), s ? labelsOf(s).join(', ') : 'no tabs');
  if (!s) { skipped = true; return; }

  // The branch tab's own session first, so there are two hosts on one folder to tell apart.
  const sel = await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
  s = await state(app);
  remember(s);
  const aHost = hostOf(s, 'feat/a');
  check("feat/a's own host is running", !!sel.ok && sel.started === true && !!aHost && alive(aHost.pid), JSON.stringify(sel));
  if (!aHost) { skipped = true; return; }

  // ===== open =====
  const opened = await command(app, { cmd: 'side-open', label: 'feat/a' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SIDE_A) && tabOf(x, SIDE_A).started ? x : null; }, 40000);
  remember(s);
  check('Open side session on feat/a: the tab "feat/a \u00b7 side" is there, started, and the open succeeded', !!s && opened.ok === true, JSON.stringify(opened));
  if (!s) { skipped = true; return; }
  check('it sits right after its branch tab, before feat/b',
    JSON.stringify(labelsOf(s)) === JSON.stringify(['develop', 'feat/a', SIDE_A, 'feat/b']), labelsOf(s).join(', '));
  const sideTab = tabOf(s, SIDE_A);
  check('it is selected, a reader, and not closable', sideTab.selected === true && sideTab.role === 'reader' && sideTab.closable === false, JSON.stringify(sideTab));
  s = await waitFor(async () => { const x = await state(app); return domOf(x, SIDE_A) ? x : null; }, 15000) || s;
  const dom = domOf(s, SIDE_A);
  check('the strip PAINTED it as a small side tab with no close button', !!dom && dom.side === true && dom.hasClose === false, JSON.stringify(dom));
  check('and its hover says what it is', !!dom && /read-only side session/.test(dom.title || ''), dom && dom.title);
  check('the side tab\'s page rendered and connected (xterm mounted)', !!(await waitFor(async () => {
    const x = await state(app);
    return x.viewDom && x.viewDom.xterm > 0 && x.viewDom.hasTerm ? x : null;
  }, 30000)));
  const shot1 = path.join(shotDir, 'side-session-open.png');
  const r1 = await command(app, { cmd: 'screenshot', file: shot1 });
  check('a screenshot of the strip with the side tab selected is a real image', !!r1.ok && pngOk(r1.stripFile), r1.stripFile);

  // ===== hosts, argv, lock =====
  const sideHost = hostOf(s, SIDE_A);
  check('a SECOND host: its own pid and port, the branch tab\'s host untouched',
    !!sideHost && sideHost.pid !== aHost.pid && sideHost.port !== aHost.port && alive(aHost.pid) && alive(sideHost.pid),
    sideHost && `side ${sideHost.pid}:${sideHost.port}, branch ${aHost.pid}:${aHost.port}`);
  const ids = identitiesUnder(featA);
  const sideId = ids.find(i => i.pid === (sideHost && sideHost.pid));
  const mainId = ids.find(i => i.pid === aHost.pid);
  check('the identity files say so: side:true for the side host only, both serving feat-a',
    !!sideId && !!mainId && sideId.side === true && mainId.side !== true, JSON.stringify(ids.map(i => ({ pid: i.pid, side: i.side === true }))));
  if (sideId) seenPids.add(sideId.pid, sideId.processStartedAt);
  if (mainId) seenPids.add(mainId.pid, mainId.processStartedAt);

  const sideLine = await waitFor(async () => {
    const id = identitiesUnder(featA).find(i => i.pid === (sideHost && sideHost.pid));
    return id && id.claudePid ? commandLineOf(id.claudePid) : null;
  }, 20000, 500);
  const mainLine = await waitFor(async () => {
    const id = identitiesUnder(featA).find(i => i.pid === aHost.pid);
    return id && id.claudePid ? commandLineOf(id.claudePid) : null;
  }, 20000, 500);
  check('the side claude runs with --permission-mode plan and WITHOUT --dangerously-skip-permissions',
    !!sideLine && /--permission-mode\s+plan/.test(sideLine) && !/--dangerously-skip-permissions/.test(sideLine), sideLine || 'no command line');
  check('the branch tab\'s claude is the other way round (bypass, no plan mode)',
    !!mainLine && /--dangerously-skip-permissions/.test(mainLine) && !/--permission-mode/.test(mainLine), mainLine || 'no command line');

  // The session lock lives in the worktree's git dir: the branch tab's host holds it, the side host does not.
  const gitDir = git(featA, 'rev-parse', '--git-dir').trim();
  const lockDir = path.isAbsolute(gitDir) ? gitDir : path.join(featA, gitDir);
  let lockPid = null;
  try {
    const name = fs.readdirSync(lockDir).find(f => /lock/i.test(f) && /claude-custom|session/i.test(f));
    if (name) lockPid = JSON.parse(fs.readFileSync(path.join(lockDir, name), 'utf8')).pid;
  } catch { /* reported below */ }
  check('the session lock names the branch tab\'s host, never the side host',
    Number.isInteger(lockPid) && lockPid === aHost.pid && lockPid !== (sideHost && sideHost.pid), `lock pid ${lockPid}, branch host ${aHost.pid}`);

  // ===== once, stays =====
  const hostCount = identitiesUnder(featA).length;
  const again = await command(app, { cmd: 'side-open', label: 'feat/a' }, 60000);
  s = await state(app);
  check('opening it again goes to the live one and spawns nothing',
    again.ok === true && again.already === true && identitiesUnder(featA).length === hostCount && labelsOf(s).filter(l => l === SIDE_A).length === 1
    && (hostOf(s, SIDE_A) || {}).pid === sideHost.pid, JSON.stringify(again));
  await command(app, { cmd: 'select', label: 'feat/b' }, 60000);
  await sleep(3500);   // a poll happens
  s = await state(app);
  remember(s);
  check('it stays: another tab selected, a poll passed, the side tab and its host are still there',
    !!tabOf(s, SIDE_A) && alive(sideHost.pid), labelsOf(s).join(', '));

  // ===== reopen: stop the side host =====
  const stopped = await sendControl({ port: sideHost.port, token: tokenOf(sideHost.port), msg: { type: 'stop' } });
  const gone = await waitFor(async () => !alive(sideHost.pid), 15000, 250);
  // The reply to a stop is the socket closing; a host that takes a moment to tear down can outlast the client's 3 s wait, so
  // the answer is reported, and what is judged is whether the host is really gone.
  check('stopping the side host ends it (the branch tab\'s host is untouched)', !!gone && alive(aHost.pid), JSON.stringify(stopped));
  const endedState = await waitFor(async () => { const x = await state(app); return /ended/.test(((tabOf(x, SIDE_A) || {}).phaseText) || '') ? x : null; }, 15000, 400);
  check('its tab says the side session ended and how to reopen it', !!endedState, endedState ? tabOf(endedState, SIDE_A).phaseText : 'no phase text');
  const reopened = await command(app, { cmd: 'side-open', label: 'feat/a' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SIDE_A) && tabOf(x, SIDE_A).started && hostOf(x, SIDE_A) && alive(hostOf(x, SIDE_A).pid) ? x : null; }, 40000);
  remember(s);
  const newSide = s && hostOf(s, SIDE_A);
  check('Open side session again starts a FRESH host, and there is still one side tab',
    reopened.ok === true && !!newSide && newSide.pid !== sideHost.pid && labelsOf(s).filter(l => l === SIDE_A).length === 1,
    newSide && `new pid ${newSide.pid}, old ${sideHost.pid}`);
  const shot2 = path.join(shotDir, 'side-session-reopened.png');
  const r2 = await command(app, { cmd: 'screenshot', file: shot2 });
  check('a screenshot of the reopened side session is a real image', !!r2.ok && pngOk(r2.stripFile), r2.stripFile);

  // ===== adopt: close the window, reopen =====
  const before = { side: newSide && newSide.pid, count: identitiesUnder(featA).length };
  await quit(app);
  check('closing the window leaves the side host running (detach), like every host', !!before.side && alive(before.side));
  app = await launchApp(container);
  s = await driverUp(app);
  if (!s) { check('the window reopened', false, app.out.split('\n').slice(-15).join('\n')); skipped = true; return; }
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SIDE_A) && tabOf(x, SIDE_A).started ? x : null; }, 40000);
  remember(s);
  check('reopened: the running side host came back as the side tab, same pid, nothing spawned',
    !!s && (hostOf(s, SIDE_A) || {}).pid === before.side && identitiesUnder(featA).length === before.count,
    s && `${(hostOf(s, SIDE_A) || {}).pid}/${before.side}, hosts ${identitiesUnder(featA).length}/${before.count}`);
  check('and the branch tab did not pick the side host up as its own',
    !!s && !!hostOf(s, 'feat/a') && hostOf(s, 'feat/a').pid === aHost.pid, s && `feat/a host ${(hostOf(s, 'feat/a') || {}).pid}/${aHost.pid}`);

  // ===== ends with its branch tab =====
  const closed = await command(app, { cmd: 'close', label: 'feat/a' });
  const bothGone = await waitFor(async () => !alive(aHost.pid) && !alive(before.side), 20000, 300);
  s = await state(app);
  check('hand-closing feat/a ends BOTH hosts', closed.ok === true && !!bothGone, JSON.stringify(closed));
  check('and both tabs leave the strip', !!s && !tabOf(s, 'feat/a') && !tabOf(s, SIDE_A), labelsOf(s).join(', '));
  check('the folder is still there', fs.existsSync(featA));
  await quit(app);
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.log(`FAIL  the probe threw: ${err && err.stack || err}`);
    failures++;
  } finally {
    hygiene._emergencyCleanup('done');     // ends the window(s) and, via the cleanup, every host it started
    await sleep(800);
    removeTemp();
  }
  if (skipped) {
    console.log(`\n${failures} FAILED -- the app or a host did not start, so the rest was never measured`);
    process.exit(1);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
