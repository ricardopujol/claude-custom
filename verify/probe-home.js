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
  'CLAUDE_CUSTOM_HOME', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR'];

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
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  return { name, container, dev, key: normPath(container) };
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const homeOf = async (app) => { const r = await command(app, { cmd: 'home' }); return r && r.ok ? r : null; };
const windowsOf = async (app) => { const r = await command(app, { cmd: 'windows' }); return r && r.ok !== false ? r : null; };
const keysOf = (h) => (h && h.dom ? h.dom.cards.map((c) => c.key) : []);

async function main() {
  const A = makeProject('alpha');
  const B = makeProject('beta');
  const now = Date.now();
  fs.writeFileSync(path.join(uiState, 'home-projects.json'), JSON.stringify({
    version: 1, projects: [{ root: A.container, lastOpened: now - 1000 }, { root: B.container, lastOpened: now - 2000 }], pins: [], removed: [],
  }));

  // 1
  const app = await launchHome();
  const h1 = await waitFor(async () => { const h = await homeOf(app); return h && h.open && h.dom && h.dom.cards.length === 2 ? h : null; }, 60000, 500);
  check('1: a --home launch shows Home', !!h1, app.out.slice(-600));
  check('1: ...the real page: its title, and the display\'s one global name (the IIFE loaded in a real window)',
    !!h1 && h1.dom.title === 'Jiandu Home' && h1.dom.homeDisplay === 'object', JSON.stringify(h1 && h1.dom));
  check('1: ...its two projects are cards, the most recent first', JSON.stringify(keysOf(h1)) === JSON.stringify([A.key, B.key]), JSON.stringify(keysOf(h1)));
  const w1 = await windowsOf(app);
  check('1: ...and no project window opened', !!w1 && Array.isArray(w1.windows) && w1.windows.length === 0, JSON.stringify(w1));
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

  // 5
  await command(app, { cmd: 'homeType', text: 'bet' });
  const h5 = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && h.dom.cards.length === 1 ? h : null; }, 10000, 200);
  check('5: typing in the filter keeps the matching card', JSON.stringify(keysOf(h5)) === JSON.stringify([B.key]), JSON.stringify(keysOf(h5)));
  await command(app, { cmd: 'homeType', text: '' });
  const h5b = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && h.dom.cards.length === 2 ? h : null; }, 10000, 200);
  check('5: ...clearing it brings both back', !!h5b);

  // 6
  await command(app, { cmd: 'homeClick', key: B.key, act: 'pin' });
  const h6 = await waitFor(async () => { const h = await homeOf(app); return h && h.dom && h.dom.cards[0] && h.dom.cards[0].key === B.key ? h : null; }, 10000, 200);
  check('6: Pin puts the card first, marked pinned', !!h6 && /\bpinned\b/.test(h6.dom.cards[0].cls), JSON.stringify(h6 && h6.dom.cards));
  const rec = readJson(path.join(uiState, 'home-projects.json'));
  check('6: ...and the pin is in the record', !!rec && Array.isArray(rec.pins) && rec.pins.some((p) => normPath(p) === B.key), JSON.stringify(rec));

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
    for (const a of all) if (a && !a.exited) { try { process.kill(a.child.pid); } catch { /* gone */ } }
    killEverything();
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
