'use strict';
/**
 * PROBE: Jiandu Home (documentation/DESIGN_PROJECT_HUB.md §5; plan documentation/PLAN_PROJECT_HUB.md H-PR2) in a REAL Electron window.
 * (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-home.js        (exit 0 = every check held)
 *
 *   1  a --home launch shows Home and no project window: the page is the real home.html (the display's ONE global name is there, so the
 *      IIFE loaded in a real window), its two seeded projects are cards, the process owns the app lock
 *   2  a second --home launch is handed to the running Jiandu and exits 0; there is still one Home, shown
 *   3  a real click on a card's Open opens that project in this process; Home stays open (H4) and the card says "open"
 *   4  Close window on that card closes the project window; Home stays, the process stays (the last project window is dropped)
 *   5  typing in the filter keeps the matching card; clearing it brings both back
 *   6  Pin puts the card first and writes the pin to the record
 *   7  closing Home, the last window, ends Jiandu with exit 0 (H5); the crash record is clean
 *   PR #263:
 *   1b the page itself goes to another page (a dropped link): refused, home.html stays with its bridge (Miguel B1)
 *   3b a tab that needs you (a real Stop hook down the host's pipe, its window blurred) shows on its card with no window event (Miguel Y1)
 *   3c a filter, then Home closed and shown again: every card, and an empty box (Dexter 1)
 *   6b Remove on a closed card: the card goes, the page says so after main answered, the record has it removed (Miguel G6)
 *   H-PR3:
 *   4b Stop its sessions on A (its session outlived its window): the card asks first; Cancel stops nothing; Stop ends A's host and
 *      the card says "Stopped 1 session."
 *   6c New lane on B: a form on the card, a name typed; the stand-in new-worktree.ps1 makes B\feat-probe-lane, B's window opens on it
 *      and the card says so; B's window then closes from Home
 *   6d (PR #265) a real double click (mouse input) on B's Stop its sessions: only the question shows, nothing stops
 *
 * SAFE. Scratch projects in a temp folder (never dev\), the hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), Claude Code's history is an empty
 * temp folder (CLAUDE_CUSTOM_GIT_PROJECTS_DIR), the UI state (the Home record, app.json, the crash record) is the probe's own folder, and
 * ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* the probe doesn't set are deleted. The window is a normal one placed off the desktop
 * (host/probe-window.js), never `offscreen: true`. Every host whose folder is inside the probe's temp folder is stopped by pid at the end;
 * the only processes it ends are its own children. Ricardo's running Jiandu is another install's process and is never touched.
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
const { normPath } = require(path.join(ROOT, 'host', 'project-layout'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-home-');
const userData = path.join(tmp, 'user-data');
const uiState = path.join(tmp, 'ui');
const historyDir = path.join(tmp, 'claude-projects');
fs.mkdirSync(uiState, { recursive: true });
fs.mkdirSync(historyDir, { recursive: true });

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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_REGISTRY',
  'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_UI_STATE_DIR', 'CLAUDE_CUSTOM_ONE_WINDOW_PROBE', 'CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE',
  'CLAUDE_CUSTOM_HOME', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_WORKTREE_SCRIPTS'];

// H-PR3 New lane: agent-creator's worktree scripts stood in, with the same parameters, exit codes and output shapes (as
// verify/probe-issue-intake.js). They only touch the probe's own scratch projects.
const scriptsDir = path.join(tmp, 'worktree-scripts');
fs.mkdirSync(scriptsDir, { recursive: true });
const STAND_INS = {
  'new-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Branch, [string]$Base = "develop")',
    'if ($Branch -notmatch "^(feat|fix|spike|chore|docs|refactor|test)/.+") {',
    '  [Console]::Error.WriteLine("$Branch has no prefix: use feat/, fix/, spike/, chore/, docs/, refactor/ or test/.")',
    '  exit 1',
    '}',
    '$dir = Join-Path $Project ($Branch -replace "/", "-")',
    '$dev = Join-Path $Project "dev"',
    '& git -C $dev worktree add -q $dir -b $Branch develop',
    'if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("git worktree add failed for $Branch"); exit 1 }',
    '[Console]::Out.WriteLine((@{ path = $dir; branch = $Branch } | ConvertTo-Json -Compress))',
    'exit 0',
  ],
  'setup-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Path, [int]$CommandTimeoutSeconds = 1800)',
    '[Console]::Out.WriteLine((@{ path = $Path; manifest = $true; copied = @(); kept = @(); ran = @(); log = $null } | ConvertTo-Json -Compress))',
    'exit 0',
  ],
  'remove-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Path)',
    '[Console]::Out.WriteLine("removed: $Path")',
    'exit 0',
  ],
};
for (const [name, lines] of Object.entries(STAND_INS)) fs.writeFileSync(path.join(scriptsDir, name), lines.join('\r\n') + '\r\n');

async function launchHome() {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: tmp,                    // a --home launch's folder (host/launch-target.js homeEnv): opens no project
    CLAUDE_CUSTOM_HOME: '1',
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
    CLAUDE_CUSTOM_GIT_PROJECTS_DIR: historyDir,
    CLAUDE_CUSTOM_WORKTREE_SCRIPTS: scriptsDir,
    CLAUDE_CUSTOM_ONE_WINDOW_PROBE: '1',
    CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE: '1',
  };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
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
  // by the real path: tmp is an 8.3 short name (RICARD~1) and a host made by the worktree script has the long spelling
  const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const inside = realOf(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && (path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)
      || realOf(id.cwd).toLowerCase().startsWith(inside))) out.push(id);
  }
  return out;
}
// readIdentity does not carry `processStartedAt`, so the proof comes from the identity file itself: without it seen-pids leaves a
// host running ("no proven start"), and a later run shows it as a windowless card.
function killEverything() {
  for (const id of hostsOfThisRun()) {
    const raw = readJson(path.join(HARNESS_DIR, 'hosts', `${id.port}.json`));
    seenPids.add(id.pid, raw && raw.processStartedAt);
  }
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

function makeProject(name) {
  const container = path.join(tmp, name);
  const dev = path.join(container, 'dev');
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  return { name, container, dev, key: normPath(container) };
}
// What the native hook helper does: one JSON line down the host's named pipe (as verify/probe-git-tree.js).
function fireHook(pid, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const homeOf = async (app) => { const r = await command(app, { cmd: 'home' }); return r && r.ok ? r : null; };
const windowsOf = async (app) => { const r = await command(app, { cmd: 'windows' }); return r && r.ok !== false ? r : null; };
// This run's projects only: a host another lane's probe left running shows on Home as a windowless card of its own.
const runKeys = new Set();
const ours = (h) => (h && h.dom ? h.dom.cards.filter((c) => runKeys.has(c.key)) : []);
const keysOf = (h) => ours(h).map((c) => c.key);

async function main() {
  const A = makeProject('alpha');
  const B = makeProject('beta');
  runKeys.add(A.key);
  runKeys.add(B.key);
  const now = Date.now();
  fs.writeFileSync(path.join(uiState, 'home-projects.json'), JSON.stringify({
    version: 1, projects: [{ root: A.container, lastOpened: now - 1000 }, { root: B.container, lastOpened: now - 2000 }], pins: [], removed: [],
  }));

  // 1
  const app = await launchHome();
  const h1 = await waitFor(async () => { const h = await homeOf(app); return h && h.open && h.dom && ours(h).length === 2 ? h : null; }, 60000, 500);
  check('1: a --home launch shows Home', !!h1, app.out.slice(-600));
  check('1: ...the real page: its title, and the display\'s one global name (the IIFE loaded in a real window)',
    !!h1 && h1.dom.title === 'Jiandu Home' && h1.dom.homeDisplay === 'object', JSON.stringify(h1 && h1.dom));
  check('1: ...its two projects are cards, the most recent first', JSON.stringify(keysOf(h1)) === JSON.stringify([A.key, B.key]), JSON.stringify(keysOf(h1)));
  const w1 = await windowsOf(app);
  check('1: ...and no project window opened', !!w1 && Array.isArray(w1.windows) && w1.windows.length === 0, JSON.stringify(w1));
  // 1b (Miguel B1)
  const evil = path.join(tmp, 'evil.html');
  fs.writeFileSync(evil, '<!doctype html><title>evil</title>');
  const nav = await command(app, { cmd: 'homeNavigate', url: require('url').pathToFileURL(evil).href });
  await sleep(1500);
  const h1b = await homeOf(app);
  check('1b: the page tried to leave (a dropped link) and was refused: still home.html, its bridge and its cards',
    !!nav && nav.ok === true && !!h1b && !!h1b.dom && h1b.dom.title === 'Jiandu Home' && /home\.html$/.test(h1b.dom.url) && ours(h1b).length === 2,
    JSON.stringify({ nav, dom: h1b && h1b.dom && { title: h1b.dom.title, url: h1b.dom.url, cards: h1b.dom.cards.length } }));
  check('1b: ...and main logged the refusal', /tried to navigate \(will-(?:frame-)?navigate\) and was refused/.test(app.out), app.out.slice(-400));
  const lock = await command(app, { cmd: 'appLock' });
  check('1: ...this process owns the probe\'s app lock', !!lock && lock.owns === true, JSON.stringify(lock));

  // 2
  const second = await launchHome();
  const ended = await waitFor(() => (second.exited ? true : null), 120000, 500);
  check('2: a second --home launch is handed over and exits 0', ended === true && second.exitCode === 0, second.out.slice(-400));
  const h2 = await homeOf(app);
  check('2: ...there is still one Home, open and shown', !!h2 && h2.open === true && h2.visible === true, JSON.stringify(h2 && { open: h2.open, visible: h2.visible }));

  // 3
  const clicked = await command(app, { cmd: 'homeClick', key: A.key, act: 'open' });
  check('3: a real click on Open', !!clicked && clicked.ok === true, JSON.stringify(clicked));
  const w3 = await waitFor(async () => { const w = await windowsOf(app); return w && w.windows.length === 1 ? w : null; }, 120000, 500);
  check('3: ...opens that project in this process', !!w3 && normPath(w3.windows[0].root) === A.key, JSON.stringify(w3));
  const h3 = await waitFor(async () => { const h = await homeOf(app); const c = h && h.dom && h.dom.cards.find((x) => x.key === A.key); return c && /^open/.test(c.state) ? h : null; }, 30000, 500);
  check('3: ...Home stays open (H4) and the card says open', !!h3 && h3.open === true, JSON.stringify(h3 && h3.dom));

  // 3b (Miguel Y1): a real permission_prompt down A's host pipe; only a strip push carries it (no window event)
  const aHost = await waitFor(() => hostsOfThisRun().find((id) => normPath(id.cwd) === normPath(A.dev)) || null, 30000, 500);
  check('3b: A\'s host is up (its hook pipe is named by its pid)', !!aHost && Number.isInteger(aHost.pid), JSON.stringify(hostsOfThisRun()));
  // A's tab page and its terminal are up, so the page hears the host's hook (as verify/probe-tray.js pageUp)
  const aRoot = w3 ? w3.windows[0].root : undefined;
  const pageUp = await waitFor(async () => { const st = await command(app, { cmd: 'state', window: aRoot }); const v = st && st.viewDom; return v && v.hasTerm === true && v.xterm > 0 ? true : null; }, 30000, 300);
  check('3b: A\'s tab page and its terminal are up', pageUp === true);
  await sleep(1500);
  // nobody is looking at A's tab (as verify/probe-tray.js): a cue on a tab you look at clears at once
  const blur = await command(app, { cmd: 'windowBlur', window: aRoot });
  check('3b: A\'s window is blurred (nobody is looking: the cue holds)', !!blur && blur.ok !== false, JSON.stringify(blur));
  const fired = aHost ? await fireHook(aHost.pid, 'Stop', {}) : false;
  check('3b: the Stop hook line reached A\'s host', fired === true);
  const needsCard = (h) => { const c = h && h.dom && h.dom.cards.find((x) => x.key === A.key); return c && /needs you/.test(c.state) && /\bneeds\b/.test(c.cls) ? c : null; };
  const h3b = await waitFor(async () => { const h = await homeOf(app); return needsCard(h) ? h : null; }, 8000, 250);
  check('3b: a tab that needs you shows on its card and in the summary, from the strip push', !!h3b && /needs you/.test(h3b.dom.summary),
    JSON.stringify(h3b ? h3b.dom.summary : { home: ((await homeOf(app)) || {}).dom,
      strip: ((await command(app, { cmd: 'state', window: aRoot })) || {}).stripDom }));

  // 3c (Dexter 1): A's window keeps the process while Home is closed
  const typedZz = await command(app, { cmd: 'homeType', text: 'zz' });
  // 30 s (PR #265 Miguel G7): right after 3b, main is busy with A's host start and the windowless reads
  const h3c = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && h.dom.empty ? h : null; }, 30000, 200);
  check('3c: a filter that matches nothing says so', !!h3c && /No project matches "zz"/.test(h3c.dom.empty),
    JSON.stringify({ typed: typedZz, dom: h3c ? h3c.dom : ((await homeOf(app)) || {}).dom }));
  await command(app, { cmd: 'homeClose' });
  const shut = await waitFor(async () => { const h = await command(app, { cmd: 'home' }); return h && h.ok && h.open === false ? h : null; }, 10000, 200);
  check('3c: ...Home closed, and the process stays (A\'s window)', !!shut && !app.exited, JSON.stringify(shut));
  await command(app, { cmd: 'homeShow' });
  const h3d = await waitFor(async () => { const h = await homeOf(app); return h && h.open && h.dom && ours(h).length === 2 ? h : null; }, 20000, 300);
  check('3c: ...shown again: every card, and an empty filter box (main and the page agree)', !!h3d && h3d.dom.filter === '' && !h3d.dom.empty,
    JSON.stringify(h3d ? { filter: h3d.dom.filter, empty: h3d.dom.empty } : ((await homeOf(app)) || {}).dom));

  // 4
  const closed = await command(app, { cmd: 'homeClick', key: A.key, act: 'close-window' });
  check('4: a real click on Close window', !!closed && closed.ok === true, JSON.stringify(closed));
  const w4 = await waitFor(async () => { const w = await windowsOf(app); return w && w.windows.length === 0 ? w : null; }, 60000, 500);
  check('4: ...the project window closed and left the registry', !!w4, JSON.stringify(await windowsOf(app)));
  await sleep(1500);
  const h4 = await homeOf(app);
  check('4: ...Home and the process stay', !app.exited && !!h4 && h4.open === true, app.out.slice(-400));
  const c4 = h4 && h4.dom ? h4.dom.cards.find((x) => x.key === A.key) : null;
  check('4: ...and the card is closed again', !!c4 && c4.state === 'closed', JSON.stringify(c4));

  // 4b (H-PR3, H8): A's session outlived its window. Home shown again reads the windowless sessions: A has one.
  const aHostPid = aHost && Number.isInteger(aHost.pid) ? aHost.pid : null;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };   // kill-ok(signal 0): only asks whether the pid lives
  // The host lists itself windowless a moment after its window went, so Home is shown again (a forced read) until it does.
  const cardA = async () => { const h = await homeOf(app); return h && h.dom ? h.dom.cards.find((x) => x.key === A.key) || null : null; };
  const w4b = await waitFor(async () => {
    await command(app, { cmd: 'homeShow' });
    await sleep(1500);
    const c = await cardA();
    return c && c.state === '1 session, no window' ? c : null;
  }, 60000, 1000);
  check('4b: A\'s session runs with no window, and its card says so', !!w4b, JSON.stringify(await cardA()));
  await command(app, { cmd: 'homeClick', key: A.key, act: 'stop-sessions' });
  const asked = await waitFor(async () => { const c = await cardA(); return c && c.ask ? c : null; }, 5000, 200);
  check('4b: Stop its sessions asks on the card first (H8, no popup)', !!asked && asked.ask === 'Stop 1 session in alpha?', JSON.stringify(asked || (await cardA())));
  await command(app, { cmd: 'homeClick', key: A.key, act: 'stop-cancel' });
  await sleep(2000);
  const kept = await cardA();
  check('4b: ...Cancel stops nothing: no question, the session and its host still there',
    !!kept && !kept.ask && kept.state === '1 session, no window' && aHostPid !== null && alive(aHostPid), JSON.stringify(kept));
  await command(app, { cmd: 'homeClick', key: A.key, act: 'stop-sessions' });
  await waitFor(async () => { const c = await cardA(); return c && c.ask ? c : null; }, 5000, 200);
  const stop = await command(app, { cmd: 'homeClick', key: A.key, act: 'stop-confirm' });
  check('4b: a real click on Stop', !!stop && stop.ok === true, JSON.stringify(stop));
  const stopped = await waitFor(async () => { const c = await cardA(); return c && c.note === 'Stopped 1 session.' && c.state === 'closed' ? c : null; }, 90000, 500);
  check('4b: ...the card says how many stopped, and is closed', !!stopped, JSON.stringify(await cardA()));
  const hostEnded = await waitFor(() => (aHostPid !== null && !alive(aHostPid) ? true : null), 20000, 500);
  check('4b: ...and A\'s host ended', hostEnded === true, `pid ${aHostPid}`);

  // 5
  await command(app, { cmd: 'homeType', text: 'bet' });
  const h5 = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && ours(h).length === 1 ? h : null; }, 10000, 200);
  check('5: typing in the filter keeps the matching card', JSON.stringify(keysOf(h5)) === JSON.stringify([B.key]), JSON.stringify(keysOf(h5)));
  await command(app, { cmd: 'homeType', text: '' });
  const h5b = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && ours(h).length === 2 ? h : null; }, 10000, 200);
  check('5: ...clearing it brings both back', !!h5b);

  // 6
  await command(app, { cmd: 'homeClick', key: B.key, act: 'pin' });
  const h6 = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && h.dom.cards[0] && h.dom.cards[0].key === B.key ? h : null; }, 10000, 200);
  check('6: Pin puts the card first, marked pinned', !!h6 && /\bpinned\b/.test(h6.dom.cards[0].cls), JSON.stringify(h6 && h6.dom.cards));
  const rec = readJson(path.join(uiState, 'home-projects.json'));
  check('6: ...and the pin is in the record', !!rec && Array.isArray(rec.pins) && rec.pins.some((p) => normPath(p) === B.key), JSON.stringify(rec));

  // 6c (H-PR3 New lane): on B, closed and with no window: the form on the card, then the strip's + in B's window
  const cardB = async () => { const h = await homeOf(app); return h && h.dom ? h.dom.cards.find((x) => x.key === B.key) || null : null; };
  await command(app, { cmd: 'homeClick', key: B.key, act: 'new-lane' });
  const formUp = await waitFor(async () => { const c = await cardB(); return c && c.form ? c : null; }, 5000, 200);
  check('6c: New lane opens a form on the card', !!formUp, JSON.stringify(await cardB()));
  const typed = await command(app, { cmd: 'homeField', key: B.key, field: 'name', value: 'probe-lane' });
  check('6c: ...a name typed into it (the type prefix stays feat/)', !!typed && typed.ok === true, JSON.stringify(typed));
  await command(app, { cmd: 'homeClick', key: B.key, act: 'lane-create' });
  const laneDir = path.join(B.container, 'feat-probe-lane');
  const made = await waitFor(async () => { const c = await cardB(); return c && c.note === 'feat/probe-lane opened in its window.' ? c : null; }, 120000, 500);
  check('6c: ...the card says the lane opened in its window', !!made, JSON.stringify(await cardB()));
  check('6c: ...the worktree is there, made by the worktree script', fs.existsSync(laneDir), laneDir);
  const w6c = await windowsOf(app);
  const bWin = w6c && Array.isArray(w6c.windows) ? w6c.windows.find((w) => normPath(w.root) === B.key) : null;
  check('6c: ...B\'s window opened, with the new lane selected', !!bWin && typeof bWin.selectedKey === 'string' && normPath(bWin.selectedKey) === normPath(laneDir),
    JSON.stringify(w6c));
  await command(app, { cmd: 'homeClick', key: B.key, act: 'close-window' });
  const closedB = await waitFor(async () => { const w = await windowsOf(app); return w && w.windows.length === 0 ? w : null; }, 60000, 500);
  check('6c: ...and B\'s window closes from Home again', !!closedB, JSON.stringify(await windowsOf(app)));

  // 6d (PR #265 Dexter's note): a REAL double click on B's "Stop its sessions" (B's dev and lane sessions outlived its window). The
  // first click asks main; the second lands on whatever is under the pointer. Nothing may stop: only the question shows.
  const bHosts = () => hostsOfThisRun().filter((id) => /[\\/]beta([\\/]|$)/i.test(id.cwd));     // this run's only beta is B
  const w6d = await waitFor(async () => {
    await command(app, { cmd: 'homeShow' });
    await sleep(1500);
    const c = await cardB();
    return c && /sessions?, no window$/.test(c.state) ? c : null;
  }, 60000, 1000);
  check('6d: B\'s sessions run with no window, and its card says so', !!w6d, JSON.stringify(await cardB()));
  const before6d = bHosts().map((id) => id.pid);
  const dbl = await command(app, { cmd: 'homeDblClick', key: B.key, act: 'stop-sessions' });
  check('6d: a real double click on Stop its sessions', !!dbl && dbl.ok === true, JSON.stringify(dbl));
  const asked6d = await waitFor(async () => { const c = await cardB(); return c && c.ask ? c : null; }, 15000, 250);
  await sleep(3000);
  const after6d = await cardB();
  check('6d: ...only the question shows; nothing stopped', !!asked6d && !!after6d && !!after6d.ask && !/Stopp/.test(after6d.note || '')
    && before6d.length > 0 && before6d.every(alive), JSON.stringify({ card: after6d, hosts: before6d.map((p) => [p, alive(p)]) }));
  await command(app, { cmd: 'homeClick', key: B.key, act: 'stop-cancel' });

  // 6b (Miguel G6 / Y3): A is closed again, so it offers Remove
  const rm = await command(app, { cmd: 'homeClick', key: A.key, act: 'remove' });
  check('6b: a real click on Remove from the list', !!rm && rm.ok === true, JSON.stringify(rm));
  const h6b = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && !h.dom.cards.some((x) => x.key === A.key) && /removed from the list/.test(h.dom.notice) ? h : null; }, 10000, 200);
  check('6b: ...the card goes, and the page says so (from main\'s answer)', !!h6b && /^alpha removed from the list\. Its folder is not touched\.$/.test(h6b.dom.notice),
    JSON.stringify(h6b ? h6b.dom.notice : ((await homeOf(app)) || {}).dom));
  const rec6 = readJson(path.join(uiState, 'home-projects.json'));
  check('6b: ...the record has it removed, and its folder is still there',
    !!rec6 && Array.isArray(rec6.removed) && rec6.removed.some((p) => normPath(p) === A.key) && fs.existsSync(A.dev), JSON.stringify(rec6));

  // 7
  const bye = await command(app, { cmd: 'homeClose' });
  check('7: Home\'s own close', !!bye && bye.ok === true, JSON.stringify(bye));
  const gone = await waitFor(() => (app.exited ? true : null), 60000, 500);
  check('7: ...with no window left, Jiandu ends with exit 0 (H5)', gone === true && app.exitCode === 0, `exit ${app.exitCode}; ${app.out.slice(-400)}`);
  const record = readJson(path.join(uiState, 'open-windows.json'));
  check('7: ...and the crash record is clean', !!record && record.clean === true, JSON.stringify(record));
  return [app, second];
}

let all = [];
main()
  .then((apps) => { all = apps; })
  .catch((err) => { console.log('FAIL  the probe threw: ' + ((err && err.stack) || err)); failures++; })
  .finally(async () => {
    for (const a of all) if (a && !a.exited) { try { process.kill(a.child.pid); } catch { /* gone */ } }   // kill-ok(held-handle): this probe's own Electron child, its handle still held (it has not exited)
    killEverything();
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
