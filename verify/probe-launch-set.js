'use strict';
/**
 * PROBE: the launch set and pins (BACKLOG #166, #167; documentation/DESIGN_TABS_SESSIONS.md 3.1, 3.2), in a REAL window with REAL
 * hosts.  (re-runnable)
 *
 *   node verify/probe-launch-set.js        (exit 0 = every check held; exit 75 = NOT RUN, the heavy lock was busy: retry)
 *   LAUNCHSET_PROBE_SHOTS=<dir>            where the picture of the strip goes (default: <temp>\cc-try): launch-set-strip.png
 *
 * The unit tests pin the decisions (test/tab-shell-launch.test.js, test/tab-lanes-pins.test.js). They can't see a real window come up
 * with its pinned lanes already running, the strip settle, the pin glyph painted before the dot, or Electron build the tab menu with
 * Pin / Unpin. Against a throwaway container  <tmp>\proj\dev  with an origin and three lanes, `tab-strip.json` seeded with two pinned
 * lanes (feat/a and feat/b, dragged into the order b, a) and nothing else:
 *   1  a launch shows THREE live sessions: develop, then the two pinned lanes, and feat/c (unpinned) is not started
 *   2  the strip settles: develop, feat/b, feat/a, in that order and at the same places on two looks a second apart
 *   3  the pin glyph is painted before the status dot on the pinned tabs (11 px, an svg, the hover text) and not on develop
 *   4  the tab menu offers Pin on an unpinned lane and Unpin on a pinned one, and nothing on develop; Pin puts feat/c on the strip
 *      idle (no session started by it) with its glyph, Unpin takes it off again; both are saved to tab-strip.json
 *   5  a restart keeps the pins, attaches to the three hosts that are still running, and starts no fourth
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and `--continue` is never passed to a real CLI.
 * ELECTRON_RUN_AS_NODE is deleted and every CLAUDE_CUSTOM_* variable but the probe's own is stripped. Hosts end by their own stop,
 * and at the end by pid tree for any left whose folder is inside the temp folder (verify/lib/seen-pids, proven by start time). The
 * picture is the app's own capturePage of the strip page, never the screen. WINDOWS ONLY.
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
const { normPath } = require(path.join(ROOT, 'host', 'project-layout'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-launchset-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const origin = path.join(tmp, 'origin.git');
const userData = path.join(tmp, 'user-data');
const shots = process.env.LAUNCHSET_PROBE_SHOTS || path.join(os.tmpdir(), 'cc-try');
fs.mkdirSync(shots, { recursive: true });
const written = [];

let failures = 0;
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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

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
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
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

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const liveHosts = () => hostsOfThisRun().filter(id => alive(id.pid));
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

const state = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const startedLabels = (st) => ((st && st.tabs) || []).filter(t => t.started).map(t => t.label).sort();
const items = (st) => ((st && st.stripLayout && st.stripLayout.items) || []).filter(i => !i.leaving);
const stripLabels = (st) => items(st).map(i => i.label);
const itemOf = (st, label) => items(st).find(i => i.label === label) || null;
const placesOf = (st) => JSON.stringify(items(st).map(i => [i.label, i.left, i.width]));

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
}

const layoutFile = path.join(dev, '.claude-custom', 'tab-strip.json');
const savedLayout = () => { try { return JSON.parse(fs.readFileSync(layoutFile, 'utf8')); } catch { return null; } };

async function main() {
  console.log('temp repo:', tmp);
  fs.mkdirSync(dev, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'remote', 'add', 'origin', origin);
  git(dev, 'push', '-q', 'origin', 'develop');
  for (const [dir, branch] of [['feat-a', 'feat/a'], ['feat-b', 'feat/b'], ['feat-c', 'feat/c']]) {
    git(dev, 'worktree', 'add', '-q', path.join(container, dir), '-b', branch);
  }
  const keyA = normPath(path.join(container, 'feat-a'));
  const keyB = normPath(path.join(container, 'feat-b'));
  fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
  fs.writeFileSync(layoutFile, JSON.stringify({ version: 1, order: [keyB, keyA], closed: [], pinned: [keyA, keyB], reopened: [] }, null, 2));

  let app = await launchApp(container);
  let st = await driverUp(app);
  if (!st) { check('the window came up and its driver answers', false, app.out.split('\n').slice(-25).join('\n')); return; }

  // ===== 1: three live sessions =====
  const launchedAt = Date.now();
  st = await waitFor(async () => {
    const x = await state(app);
    return startedLabels(x).length >= 3 && liveHosts().length >= 3 ? x : null;
  }, 120000, 500);
  st = st || await state(app);
  console.log(`(three sessions up ${((Date.now() - launchedAt) / 1000).toFixed(1)} s after the window answered)`);
  check('1.1: develop and the two pinned lanes are started by the launch', JSON.stringify(startedLabels(st)) === JSON.stringify(['develop', 'feat/a', 'feat/b']), startedLabels(st).join(', '));
  check('1.2: three live hosts, and feat/c (unpinned) has none', liveHosts().length === 3 && !startedLabels(st).includes('feat/c'),
    JSON.stringify({ hosts: liveHosts().map(h => path.basename(h.cwd)), started: startedLabels(st) }));

  // ===== 2: the strip settles =====
  await sleep(2500);
  const first = await state(app);
  await sleep(1500);
  const second = await state(app);
  check('2.1: the strip shows develop, feat/b, feat/a (the saved order), and only those', JSON.stringify(stripLabels(second)) === JSON.stringify(['develop', 'feat/b', 'feat/a']), stripLabels(second).join(', '));
  check('2.2: and has settled: the same places a second and a half later', placesOf(first) === placesOf(second), `${placesOf(first)} vs ${placesOf(second)}`);
  check('2.3: develop is the selected tab', (second.tabs.find(t => t.selected) || {}).label === 'develop');

  // ===== 3: the pin glyph =====
  for (const l of ['feat/a', 'feat/b']) {
    const pin = (itemOf(second, l) || {}).pin;
    check(`3: ${l} wears the pin before its dot (11 px, drawn, with its hover text)`,
      !!pin && pin.width === 11 && pin.height === 11 && pin.beforeDot === true && pin.svg === true && pin.title === 'Pinned · resumes at launch · right-click to unpin', JSON.stringify(pin));
  }
  check('3: develop wears none', (itemOf(second, 'develop') || {}).pin === null);
  const shotFile = path.join(shots, 'launch-set-strip.png');
  const shotted = await command(app, { cmd: 'screenshot', file: shotFile });
  if (shotted.ok && shotted.stripFile) written.push(shotted.stripFile); else console.log(`(strip picture: ${shotted.error || 'none'})`);

  // ===== 4: the menu =====
  const devMenu = await command(app, { cmd: 'tabMenu', label: 'develop' });
  check('4.1: develop\'s tab menu has no Pin item', devMenu.ok === true && !devMenu.items.some(i => /^(Pin|Unpin)/.test(i.label)), JSON.stringify(devMenu.items));
  const bMenu = await command(app, { cmd: 'tabMenu', label: 'feat/b' });
  check('4.2: a pinned lane offers Unpin', bMenu.ok === true && bMenu.items.some(i => i.label === 'Unpin'), JSON.stringify(bMenu.items));
  // feat/c has no tab yet (it is a Lanes row), so its menu is reached once it is on the strip: select it, which starts it, then pin
  const sel = await command(app, { cmd: 'select', label: 'feat/c' }, 60000);
  check('4.4: feat/c, selected, starts', sel.ok === true && sel.started === true, JSON.stringify(sel));
  const cMenu2 = await command(app, { cmd: 'tabMenu', label: 'feat/c' });
  check('4.5: an unpinned lane offers Pin', cMenu2.ok === true && cMenu2.items.some(i => /^Pin/.test(i.label)), JSON.stringify(cMenu2.items));
  const pinLabel = ((cMenu2.items || []).find(i => /^Pin/.test(i.label)) || {}).label;
  const pinned = await command(app, { cmd: 'tabMenu', label: 'feat/c', item: pinLabel });
  st = await waitFor(async () => { const x = await state(app); return ((itemOf(x, 'feat/c') || {}).pin) ? x : null; }, 10000);
  check('4.6: Pin puts the glyph on feat/c', pinned.ok === true && !!st, JSON.stringify(pinned));
  const saved = savedLayout();
  check('4.7: and saves it to tab-strip.json', !!saved && Array.isArray(saved.pinned) && saved.pinned.includes(normPath(path.join(container, 'feat-c'))), JSON.stringify(saved && saved.pinned));
  const unpinned = await command(app, { cmd: 'tabMenu', label: 'feat/c', item: 'Unpin' });
  st = await waitFor(async () => { const x = await state(app); return !(itemOf(x, 'feat/c') || {}).pin ? x : null; }, 10000);
  check('4.8: Unpin takes the glyph off, and the saved list loses it', unpinned.ok === true && !!st && !(savedLayout().pinned || []).includes(normPath(path.join(container, 'feat-c'))), JSON.stringify(unpinned));

  // ===== 5: a restart =====
  await quit(app);
  const before = liveHosts().length;
  app = await launchApp(container);
  st = await driverUp(app);
  st = st && await waitFor(async () => { const x = await state(app); return startedLabels(x).length >= 4 ? x : null; }, 60000);
  st = st || await state(app);
  const after = liveHosts();
  check('5.1: after a restart the pinned lanes and develop are attached, and feat/c, which was running, is too (no host spawned twice)',
    after.length === before && new Set(after.map(h => normPath(h.cwd))).size === after.length, JSON.stringify({ before, after: after.map(h => path.basename(h.cwd)) }));
  check('5.2: the pins survived the restart', JSON.stringify((savedLayout() || {}).pinned) === JSON.stringify([keyA, keyB]), JSON.stringify((savedLayout() || {}).pinned));
  check('5.3: the pinned lanes are on the strip with their glyph', !!(itemOf(st, 'feat/a') || {}).pin && !!(itemOf(st, 'feat/b') || {}).pin);
  await quit(app);
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.log(`FAIL  the probe threw: ${err && err.stack || err}`);
    failures++;
  } finally {
    hygiene._emergencyCleanup('done');
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${tmp}: ${e.message})`); }
  }
  console.log('\npictures written:');
  for (const f of written) console.log(`  ${f}`);
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
