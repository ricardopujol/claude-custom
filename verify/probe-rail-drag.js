'use strict';
/**
 * BACKLOG #109, in a REAL window with a REAL host.  (re-runnable)
 *
 *   node verify/probe-rail-drag.js [--shots <dir>]      (exit 0 = every check held; 2 = refused, a live host on this checkout)
 *
 * The unit tests pin the decisions (test/dock-press.test.js: click or drag; test/dock-rail-order.test.js: the rail's order, its
 * save and read, where a drop on the rail lands). What they can't see is the page: that a press on a rail button's ICON really
 * runs the same drag a tab's name does, that the click a drag leaves behind never opens the rail's panel, and that a reordered
 * rail is what the window draws after a restart.
 *
 *   1  a click on a rail icon opens its panel (#106: click opens)
 *   2  a docked tab's name dropped on the rail changes nothing (what the name supported before #109, kept)
 *   3  a drag from a rail icon to the terminal's left band docks the panel there: ghost, zones with one hot, mid-drag; no panel opened
 *   3b a drag from a rail icon onto the window's right rim (inside the rail's outer 14 px) docks it along the right edge
 *   4  a drag from a rail icon that ends where it started (on its own place in the rail) changes nothing and opens no panel
 *   5  a rail icon held still for 320 ms is a drag (250 ms threshold): its release opens no panel and changes nothing
 *   6  a drop between two rail tabs puts the tab there: one insertion line mid-drag, the rail redrawn in the new order, the docked
 *      groups unchanged, layout-tree.json holding the order and the railOrdered mark
 *   7  after a restart of the window the rail comes back in that order
 *
 * Screenshots (the app's own capturePage, never the screen), into --shots: rail-drag-ghost.png (a drag in flight from a rail icon
 * over the terminal: the ghost and the zones), rail-drag-inflight.png (over the rail: the insertion line), rail-drag-reordered.png
 * (the rail after the reorder), rail-drag-restart.png (after the restart). The window is told it is focused first (main's own
 * `windowFocus`, no OS focus taken), so the shots aren't under the unfocused dim.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_*
 * variable are deleted before the window is launched; registry, portraits, uploads and user data are temp folders. The window's
 * store is `<checkout>/.harness/state`: its layout files are snapshotted and put back, so the probe leaves no layout behind. It
 * REFUSES (exit 2) while a live host is open on this checkout. The only processes stopped are the ones this probe started.
 * WINDOWS ONLY. Run it under the heavy lock: node scripts/with-heavy-lock.js node verify/probe-rail-drag.js
 */
const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const STATE_DIR = path.join(HARNESS_DIR, 'state');
const V1_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const PRESETS_FILE = path.join(STATE_DIR, 'layout-presets.json');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { isLiveHost } = require('./lib/live-host');
const { TABS } = require(path.join(ROOT, 'app', 'side-tabs'));
const T = require(path.join(ROOT, 'app', 'dock-tree'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const IDS = TABS.map(t => t.id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-rail-drag-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg !== -1 && process.argv[shotsArg + 1] ? path.resolve(process.argv[shotsArg + 1]) : path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

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

const v1Snap = snapshotFile(V1_FILE);
const treeSnap = snapshotFile(TREE_FILE);
const presetsSnap = snapshotFile(PRESETS_FILE);
let refused = false;
function restoreLayouts() { if (refused) return; v1Snap.restore(); treeSnap.restore(); presetsSnap.restore(); }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  });
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
const viewState = (app) => view(app, 'state');

// --- hosts the probe started ---------------------------------------------------------------
const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase() === path.resolve(dir).toLowerCase()) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsUnder(dev)) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreLayouts);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await viewState(app);
    return v && v.ok && v.sent ? v : null;
  }, 45000);
}
async function quitApp(app) {
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 15000);
  await sleep(3000);                                      // the old window lets go of its user-data lock
}
async function launchReady(cwd) {
  let app;
  let ready = null;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    app = await launchApp(cwd);
    ready = await viewReady(app);
    if (!ready) {
      console.log(`(attempt ${attempt}: the window never came up; ${app.out.slice(-300).replace(/\s+/g, ' ')})`);
      await quitApp(app);
      if (!app.exited) { try { require(path.join(ROOT, 'host', 'kill-tree')).killChildTree(app.child); } catch { /* gone */ } }
    }
  }
  return { app, ready };
}
async function liveForeignHost() {
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (!id || !Number.isInteger(id.pid)) continue;
    const alive = await isLiveHost(id);
    if (alive && !path.resolve(String(id.cwd || '')).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) return id;
  }
  return null;
}

// --- what the page shows -----------------------------------------------------------------------
const dockRail = v => v.rails.find(r => r.id === 'dock') || null;
const railOrder = v => { const r = dockRail(v); return r ? r.modules.filter(Boolean) : null; };
const groupTabs = v => v.groups.map(g => [g.id, g.tabs]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
async function stateFor(app, pred, ms = 4000) {
  let last = null;
  const s = await waitFor(async () => { const v = await viewState(app); last = v; return v && v.ok && pred(v) ? v : null; }, ms, 100);
  return s || last;
}
// The dock rail's middle, relative to #dock, for a drop on the rail.
const railPoint = (v) => {
  const r = dockRail(v);
  return { x: r.rect.left - v.dock.left + r.rect.width / 2, y: r.rect.top - v.dock.top + r.rect.height - 20 };
};

// A layout with a docked group and five panels on the rail (the rail drawn grouped: Work, Repo, Me).
const START = ['vault', 'git', 'agents', 'fog', 'style'].reduce((l, id) => T.unpin(l, id), T.defaultLayout(IDS));

async function main() {
  const foreign = await liveForeignHost();
  if (foreign) {
    refused = true;
    console.log(`REFUSED: a live host (pid ${foreign.pid}, ${foreign.cwd}) is open on this checkout. The probe moves .harness/state/layout-*.json on purpose; close that window, or run the probe from another checkout.`);
    return;
  }
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const f of [V1_FILE, TREE_FILE, PRESETS_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }

  let { app, ready } = await launchReady(container);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const reset = async () => { await view(app, 'layout', { layout: START }); return stateFor(app, v => !!dockRail(v) && v.peek === null); };

  // 1 -------------------------------------------------------------------------------------------
  let s = await reset();
  const grouped = railOrder(s);
  check('setup: five panels on the dock rail, drawn grouped (Work, Repo, Me)', JSON.stringify(grouped) === JSON.stringify(T.drawnRail(START)), JSON.stringify(grouped));
  let r = await view(app, 'railPress', { id: 'git', how: 'click' });
  check('1: a click on a rail icon opens its panel', r.ok && r.peek === 'git' && r.during.dragging === false, JSON.stringify(r));

  // 2 -------------------------------------------------------------------------------------------
  s = await reset();
  const docked = groupTabs(s);
  const docked0 = docked.length ? docked[0][1][0] : null;
  r = await view(app, 'drag', { id: docked0, to: railPoint(s) });
  s = await stateFor(app, () => true);
  check('2: a docked tab\'s name dropped on the rail changes nothing (no rail target for a docked panel, as before #109)',
    r.ok && JSON.stringify(groupTabs(s)) === JSON.stringify(docked) && JSON.stringify(railOrder(s)) === JSON.stringify(grouped), JSON.stringify([r.during, groupTabs(s), railOrder(s)]));

  // 3 -------------------------------------------------------------------------------------------
  s = await reset();
  const term = { x: s.termwrap.left - s.dock.left + 20, y: s.termwrap.top - s.dock.top + s.termwrap.height / 2 };
  r = await view(app, 'railPress', { id: 'vault', how: 'drag', to: term });
  s = await stateFor(app, v => v.groups.some(g => g.tabs.includes('vault')));
  check('3: mid-drag from a rail icon: the ghost (naming the panel), the dragging class, zones lit with exactly one hot',
    r.ok && r.during.ghost && r.during.dragging && r.during.zones > 0 && r.during.hot === 1 && r.during.ghostText === 'Vault', JSON.stringify(r.during));
  const left = s.groups.find(g => g.tabs.includes('vault'));
  check('3: ...and the drop on the terminal\'s left band docks Vault there, off the rail; no panel opened, the overlay cleared',
    !!left && left.rect.right <= s.termwrap.left + 1 && !railOrder(s).includes('vault') && r.peek === null && !r.after.dragging && !r.after.ghost && r.after.zones === 0,
    JSON.stringify([left && left.rect, s.termwrap.left, railOrder(s), r.peek, r.after]));

  // 3b: the window's right rim runs inside the rail's outer 14 px; it is still the way to dock a rail tab along the right edge.
  s = await reset();
  r = await view(app, 'railPress', { id: 'style', how: 'drag', to: { x: s.dock.width - 4, y: s.dock.height / 2 } });
  s = await stateFor(app, v => v.groups.some(g => g.tabs.includes('style')));
  const right = s.groups.find(g => g.tabs.includes('style'));
  check('3b: a rail tab dropped on the right rim (inside the rail\'s outer strip) docks along the window\'s right edge, no line mid-drag',
    r.ok && r.during.lines === 0 && r.during.hot === 1 && !!right && !railOrder(s).includes('style'), JSON.stringify([r.during, right && right.rect, railOrder(s)]));

  // 4 -------------------------------------------------------------------------------------------
  s = await reset();
  const gitBtn = dockRail(s).tabRects[dockRail(s).modules.indexOf('git')];
  r = await view(app, 'railPress', { id: 'git', how: 'drag', to: { x: gitBtn.left - s.dock.left + gitBtn.width / 2, y: gitBtn.top - s.dock.top + gitBtn.height - 4 } });
  s = await stateFor(app, () => true);
  check('4: a drag from a rail icon that ends on its own place: no line mid-drag, nothing changes, and no panel opens (the drag\'s click is swallowed)',
    r.ok && r.during.dragging && r.during.lines === 0 && r.peek === null && JSON.stringify(railOrder(s)) === JSON.stringify(grouped), JSON.stringify([r, railOrder(s)]));

  // 5 -------------------------------------------------------------------------------------------
  s = await reset();
  r = await view(app, 'railPress', { id: 'fog', how: 'hold' });
  s = await stateFor(app, () => true);
  check('5: a rail icon held still 320 ms is a drag (ghost up), and its release opens no panel and changes nothing',
    r.ok && r.during.dragging && r.during.ghost && r.peek === null && JSON.stringify(railOrder(s)) === JSON.stringify(grouped), JSON.stringify([r, railOrder(s)]));

  // 6 -------------------------------------------------------------------------------------------
  s = await reset();
  // The window as focused (main's own focus event, no OS focus taken), so the shots aren't under the unfocused dim.
  await command(app, { cmd: 'windowFocus' });
  // The ghost in flight over the terminal (by the rail it sits mostly past the window's edge), then Esc: nothing changes.
  const mid = { x: s.termwrap.left - s.dock.left + s.termwrap.width / 2, y: s.termwrap.top - s.dock.top + s.termwrap.height / 3 };
  r = await view(app, 'railPress', { id: 'agents', how: 'drag', to: mid, release: false });
  await sleep(150);
  const ghostShot = await command(app, { cmd: 'screenshot', file: path.join(shots, 'rail-drag-ghost.png') });
  check('6: screenshot of a drag in flight from a rail icon over the terminal (the ghost, the zones lit)', r.ok && r.during.ghost && ghostShot.ok && ghostShot.viewBytes > 0, JSON.stringify([r.during, ghostShot]));
  await view(app, 'key', { key: 'Escape', selector: 'body' });
  r = await view(app, 'railRelease');
  s = await stateFor(app, () => true);
  check('6: Esc mid-drag ends it: nothing changes and no panel opens', r.ok && !r.after.dragging && r.peek === null && JSON.stringify(railOrder(s)) === JSON.stringify(grouped), JSON.stringify([r, railOrder(s)]));
  const last = grouped[grouped.length - 1];
  const first = grouped[0];
  // The line in flight between two tabs, for the shot (at the rail's very top it sits on the rim's border), then Esc.
  r = await view(app, 'railPress', { id: last, how: 'drag', before: grouped[2], release: false });
  await sleep(150);
  const inflight = await command(app, { cmd: 'screenshot', file: path.join(shots, 'rail-drag-inflight.png') });
  check('6: screenshot of the drag in flight over the rail (the insertion line between two tabs)', r.ok && r.during.lines === 1 && inflight.ok && inflight.viewBytes > 0, JSON.stringify([r.during, inflight]));
  await view(app, 'key', { key: 'Escape', selector: 'body' });
  await view(app, 'railRelease');
  r = await view(app, 'railPress', { id: last, how: 'drag', before: first, release: false });
  // The point is 3 px into the first tab, inside the window's top rim: the rail's, not "along the top" (the probe's first find).
  check(`6: mid-drag of ${last} over the top of the rail (inside the window's top rim): the ghost and exactly one insertion line, which is the hot zone`,
    r.ok && r.during.ghost && r.during.lines === 1 && r.during.hot === 1, JSON.stringify(r.during));
  r = await view(app, 'railRelease');
  const want = [last, ...grouped.filter(id => id !== last)];
  s = await stateFor(app, v => JSON.stringify(railOrder(v)) === JSON.stringify(want));
  check(`6: the drop puts ${last} first on the rail, the rest in their order`, JSON.stringify(railOrder(s)) === JSON.stringify(want), JSON.stringify(railOrder(s)));
  check('6: ...the docked groups are unchanged, and no panel opened', JSON.stringify(groupTabs(s)) === JSON.stringify(docked) && r.peek === null, JSON.stringify([groupTabs(s), r.peek]));
  const saved = await waitFor(() => { const j = readJson(TREE_FILE); return j && j.railOrdered === true ? j : null; }, 5000);
  check('6: layout-tree.json holds the order and the railOrdered mark', !!saved && JSON.stringify(saved.rail) === JSON.stringify(want), JSON.stringify(saved && [saved.rail, saved.railOrdered]));
  // One more, so the restart has an order no grouping could give: the first Work tab to the very end.
  r = await view(app, 'railPress', { id: first, how: 'drag', before: null });
  const want2 = [...want.filter(id => id !== first), first];
  s = await stateFor(app, v => JSON.stringify(railOrder(v)) === JSON.stringify(want2));
  check(`6: a drop under the last tab puts ${first} at the end`, JSON.stringify(railOrder(s)) === JSON.stringify(want2), JSON.stringify(railOrder(s)));
  await sleep(300);
  const after = await command(app, { cmd: 'screenshot', file: path.join(shots, 'rail-drag-reordered.png') });
  check('6: screenshot of the rail after the reorder', after.ok && after.viewBytes > 0, JSON.stringify(after));
  await waitFor(() => { const j = readJson(TREE_FILE); return j && JSON.stringify(j.rail) === JSON.stringify(want2); }, 5000);

  // 7 -------------------------------------------------------------------------------------------
  await quitApp(app);
  ({ app, ready } = await launchReady(container));
  check('7: the window came up again', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  s = await stateFor(app, v => !!dockRail(v), 8000);
  await command(app, { cmd: 'windowFocus' });
  check('7: after a restart the rail comes back in the order it was left in', JSON.stringify(railOrder(s)) === JSON.stringify(want2), JSON.stringify(railOrder(s)));
  check('7: ...and the docked groups as they were', JSON.stringify(groupTabs(s)) === JSON.stringify(docked), JSON.stringify(groupTabs(s)));
  await sleep(300);
  await command(app, { cmd: 'screenshot', file: path.join(shots, 'rail-drag-restart.png') });

  await quitApp(app);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayouts();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (shotsArg !== -1) console.log(`screenshots: ${shots}`);
    if (refused) process.exit(2);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
