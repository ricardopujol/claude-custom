'use strict';
/**
 * Dock tabs that slide open on CLICK only (hover never opens one: BACKLOG #138, #106), with a pin (BACKLOG #85), in a REAL window
 * with a REAL host.  (re-runnable)
 *
 *   node verify/probe-dock-autohide.js     (exit 0 = every check held)
 *
 * The unit tests pin the decisions (test/dock-rail*.test.js). What no unit test can see is the page: whether a REAL pointer over
 * the rail opens nothing, whether clicking a rail tab really slides its panel over the terminal, whether the terminal's width
 * really stays put while it does, and whether pinning really makes the terminal narrower and unpinning gives it back.
 *
 *   1  a layout stored before the rail existed (no `rail`) draws as it did: no rail, the same groups, a Pinned button on each
 *   2  the Pinned button unpins a panel: its tab is on a rail strip at the right edge, the terminal is narrower by that strip
 *      only, the boxes tile, terminal === fit === pty
 *   3  a real pointer resting on a tab, or sweeping every tab, opens nothing; a click opens the panel, over the
 *      terminal, inside the window, with a Pin button; the terminal's width and the pty did not change and nothing was saved
 *   4  the open panel: the pointer leaving or hovering the other icons changes nothing; clicking another icon switches to it;
 *      clicking the open icon again closes it; 4b only a press in the terminal (or focus going into it) closes it: the strip and the header don't
 *   5  Pin on the open panel: the tab leaves the rail, the panel is a real one beside the terminal, the terminal is narrower
 *   6  Unpin it again: the rail is back and the terminal grew back to its width with the rail
 *   7  Esc closes it, a press in the terminal closes it; 7b a keyboard activation of the icon opens it
 *   8  the Window menu: hiding a rail tab removes it from the rail; ticking it again brings it back as a rail tab
 *   9  double-clicking the empty part of a tab bar unpins every tab of the group
 *   12 rail tabs are a one-colour line icon over a horizontal name (52 px rail, names 11 px at most, shrunk to one line); a folded group's rails too
 *
 * Hover is REAL pointer movement (the host's `mouseMove` command: webContents.sendInputEvent), not a dispatched event, and a
 * float sits where the panel opens, so a stacking fault (PR #168 B1: a missing `;` dropped `z-index: 1000`) fails check 3. Also:
 *   4  the slide-out stage     5/6  where the keyboard is after Pin and Pinned
 *   8c the tab menus: Pin / Hide <name> on a rail tab; Unpin with "Just this tab" leaves the saved layout untouched
 *   10 every tab reachable with all unpinned in a short window     11  reduced motion (the OS setting, emulated): no animation
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_*
 * variable are deleted before the window is launched; registry, portraits, uploads and user data are temp folders. The window's
 * store is `<worktree>/.harness/state`: the layout files in it are snapshotted and put back. It REFUSES (exit 2) while a live
 * host is open on this checkout. The only processes stopped are the ones this probe started. WINDOWS ONLY.
 */
const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// How long a pointer rests before the probe reads the page: well past the 100 ms the old hover timers waited.
const HOVER_REST_MS = 600;
const HARNESS_DIR = path.join(ROOT, '.harness');
const STATE_DIR = path.join(HARNESS_DIR, 'state');
const V1_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const PRESETS_FILE = path.join(STATE_DIR, 'layout-presets.json');          // dockable panels D3
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { isLiveHost } = require('./lib/live-host');
const { TABS } = require(path.join(ROOT, 'app', 'side-tabs'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const IDS = TABS.map(t => t.id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-dock-tree-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const shots = process.env.DOCK_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args,
], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

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

// --- the window's layout files: snapshotted for the run, put back afterwards ----------
// host.js hardcodes its state dir, so these two files are the checkout's own. A snapshot's restore() is
// idempotent and never throws (verify/lib/file-snapshot.js), so the SIGINT cleanup and the final one can both
// run without the second deleting what the first put back (PR #100 Miguel I1).
const v1Snap = snapshotFile(V1_FILE);
const treeSnap = snapshotFile(TREE_FILE);
const presetsSnap = snapshotFile(PRESETS_FILE);
// Refused runs touched nothing, so they put nothing back (a live host may be watching the very file).
function restoreLayouts() { if (refused) return; v1Snap.restore(); treeSnap.restore(); presetsSnap.restore(); }
const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

// --- the app ----------------------------------------------------------------------------
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

// The three sizes that must agree once the page has refitted. Polled: the refit
// runs on a timer after each layout change.
async function sizesAgree(app) {
  const s = await waitFor(async () => {
    const v = await viewState(app);
    if (!v || !v.ok || !v.fit || !v.sent) return null;
    if (v.settling) return null;                  // a drop glides for 120 ms (D4): boxes read mid-glide are in between
    const same = v.term.cols === v.fit.cols && v.term.rows === v.fit.rows
      && v.sent.cols === v.term.cols && v.sent.rows === v.term.rows;
    return same ? v : null;
  }, 4000);
  if (s) return { ok: true, s };
  const v = await viewState(app);
  return { ok: false, s: v };
}
// Sizes agree and the boxes tile: a window's size change is drawn on the next frame, so a state read in between is the old picture.
async function settled(app) {
  let last = null;
  const s = await waitFor(async () => {
    const a = await sizesAgree(app);
    last = a;
    return a.ok && a.s.dock && tiles(a.s).length === 0 ? a : null;
  }, 6000, 100);
  return s || last;
}
const sizeText = (v) => (v && v.term ? `term ${v.term.cols}x${v.term.rows}, fits ${v.fit && `${v.fit.cols}x${v.fit.rows}`}, sent ${v.sent && `${v.sent.cols}x${v.sent.rows}`}` : JSON.stringify(v));

// --- geometry, from a state --------------------------------------------------------------
// Every box as a rectangle relative to #dock: the terminal, each group, divider and rail.
function rectsOf(v) {
  const o = { x: v.dock.left, y: v.dock.top };
  const rel = r => ({ x: r.left - o.x, y: r.top - o.y, w: r.width, h: r.height });
  return [
    { what: 'term', ...rel(v.termwrap) },
    ...v.groups.map(g => ({ what: `group ${g.id}`, ...rel(g.rect) })),
    ...v.rails.map(r => ({ what: `rail ${r.modules[0]}`, ...rel(r.rect) })),
    ...v.gutters.map(g => ({ what: `gutter ${g.path}/${g.i}`, ...rel(g.rect) })),
  ];
}
// The boxes tile #dock: none overlaps another (more than a pixel of rounding), none leaves it, and together they cover it.
function tiles(v) {
  const rs = rectsOf(v);
  const problems = [];
  for (let i = 0; i < rs.length; i++) {
    const a = rs[i];
    if (a.x < -1 || a.y < -1 || a.x + a.w > v.dock.width + 1 || a.y + a.h > v.dock.height + 1) problems.push(`${a.what} outside`);
    for (let j = i + 1; j < rs.length; j++) {
      const b = rs[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) problems.push(`${a.what} overlaps ${b.what}`);
    }
  }
  const area = rs.reduce((s, r) => s + r.w * r.h, 0);
  const whole = v.dock.width * v.dock.height;
  if (Math.abs(area - whole) > whole * 0.01) problems.push(`covers ${Math.round(area)} of ${Math.round(whole)}`);
  return problems;
}
// Each showing panel lies inside its group's box.
function panelsInside(v) {
  const bad = [];
  for (const g of v.groups) {
    g.panelRects.forEach((p, i) => {
      if (p.left < g.rect.left - 1 || p.top < g.rect.top - 1 || p.right > g.rect.right + 1 || p.bottom > g.rect.bottom + 1) bad.push(g.panels[i]);
    });
    if (!g.panels.length) bad.push(`${g.id}: nothing showing`);
  }
  return bad;
}
const groupWith = (v, id) => v.groups.find(g => g.tabs.includes(id));
// The boxes as dock-relative whole pixels: stable across a header that shifts the page by a fraction.
// Sorted: the page keeps a group's element from the render that made it, so DOM order is not tree order.
const keyed = (v) => rectsOf(v).map(r => [r.what, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const rectKey = (v) => JSON.stringify(keyed(v));
const keyDiff = (a, b) => { const x = keyed(a); const y = keyed(b); return JSON.stringify(x.filter((r, i) => JSON.stringify(r) !== JSON.stringify(y[i])).slice(0, 3)) + ' vs ' + JSON.stringify(y.filter((r, i) => JSON.stringify(r) !== JSON.stringify(x[i])).slice(0, 3)); };

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
  for (const id of [...hostsUnder(dev), ...hostsUnder(featA)]) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreLayouts);

// The selected tab's view is up, its session started and the page sent a size.
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
// A window and its session up, retried twice: a window that never comes up is stopped (our own PID only) and launched again.
async function launchReady(cwd) {
  let app;
  let ready = null;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    app = await launchApp(cwd);
    ready = await viewReady(app);
    if (!ready) {
      console.log(`(attempt ${attempt}: the window never came up; ${app.out.slice(-300).replace(/s+/g, ' ')})`);
      await quitApp(app);
      if (!app.exited) { try { require(path.join(ROOT, 'host', 'kill-tree')).killChildTree(app.child); } catch { /* gone */ } }
    }
  }
  return { app, ready };
}
async function quitApp(app) {
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 15000);
  await sleep(3000);                                      // the old window lets go of its user-data lock
}

// A live host on THIS checkout that is not one of ours: its window would see the layout files moved under it and
// the probe's trees pushed into it, and the restore would overwrite what it saved (PR #100 Miguel I1, as probe-wand).
async function liveForeignHost() {
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (!id || !Number.isInteger(id.pid)) continue;
    const alive = await isLiveHost(id);                      // pid AND start time: a recycled pid is not a host
    if (alive && !path.resolve(String(id.cwd || '')).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) return id;
  }
  return null;
}

let refused = false;

const T = require(path.join(ROOT, 'app', 'dock-tree'));
const pinned = (v, id) => v.groups.some(g => g.tabs.includes(id));
const railMods = (v) => v.rails.flatMap(r => r.modules);
const termWidth = (v) => Math.round(v.termwrap.width);

// REAL pointer movement (webContents.sendInputEvent mouseMove, BACKLOG #85 / PR #168 Miguel Y7): the page's own hit-testing
// decides what is under the pointer, so a layer covering a rail tab, or a missing pointer-events, shows up here.
const centre = (r) => ({ x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) });
const moveTo = (app, r) => command(app, { cmd: 'mouseMove', ...centre(r) });
const railTab = (v, id) => { const r = v.rails.find(x => x.id === 'dock'); return r ? r.tabRects[r.modules.indexOf(id)] : null; };
const hoverTerm = async (app) => moveTo(app, (await viewState(app)).termwrap);
// A click on a rail icon (the page's own click handler) and a press in the terminal (the only press that closes a panel).
const clickTab = (app, id) => view(app, 'railClick', { id });
const pressOutside = (app) => view(app, 'outsidePress', { selector: '#termwrap' });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const heldIs = (v, module, parent) => !!v.held && v.held.module === module && String(v.held.parent || '').includes(parent);

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

  // 1: a tree layout from before the rail: no `rail` key at all.
  const { rail: _none, ...old } = T.defaultLayout(IDS);
  fs.writeFileSync(TREE_FILE, JSON.stringify(old));
  const { app, ready } = await launchReady(container);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  // BACKLOG #103: a layout from before the rail pinned nothing on purpose, so it opens with every panel a rail tab.
  const s1m = (await settled(app)).s;
  check('1: a layout with no rail opens with every panel a rail tab: no group, one rail holding every module',
    s1m.groups.length === 0 && s1m.rails.length === 1 && s1m.rails[0].modules.length === IDS.length - 1, JSON.stringify([s1m.groups.length, s1m.rails.map(r => r.modules.length)]));
  // 1b: clicking one of those tabs opens only that tab, not the rail's whole list.
  // (Built from unpin alone, so the same probe also draws the before picture on a build without startLayout.)
  await view(app, 'layout', { layout: IDS.filter(id => id !== 'canvas').reduce((l, id) => T.unpin(l, id), T.defaultLayout(IDS)) });
  await settled(app);
  await clickTab(app, 'vault');
  const peek1 = await waitFor(async () => { const v = await viewState(app); return v.popover ? v : null; }, 3000, 20);
  check('1b: clicking a rail tab opens its panel with that one tab at the top, not the whole rail', !!peek1 && peek1.popover.module === 'vault' && peek1.popover.tabs.join() === 'vault' && peek1.popover.on.join() === 'vault',
    JSON.stringify(peek1 && [peek1.popover.module, peek1.popover.tabs, peek1.popover.on]));
  await sleep(300);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1b-click-one-tab.png') });
  await pressOutside(app);
  await waitFor(async () => (await viewState(app)).popover === null, 3000, 20);
  // The rest of the probe measures pinning from the all-docked layout a person who pinned everything has (an explicit empty rail).
  await view(app, 'layout', { layout: T.defaultLayout(IDS) });
  const s1 = (await settled(app)).s;
  check('1: ...and a layout that records an empty rail (everything pinned) keeps one right group holding every module',
    s1.rails.length === 0 && s1.groups.length === 1 && s1.groups[0].tabs.length === IDS.length - 1, JSON.stringify(s1.groups.map(g => [g.id, g.tabs.length])));
  const t0 = termWidth(s1);

  // 2 ---------------------------------------------------------------------------------
  await view(app, 'select', { id: 'git' });
  await view(app, 'pinClick', { module: 'git' });
  const a2 = await settled(app);
  const s2 = a2.s;
  const strip = s2.rails[0] && s2.rails[0].rect;
  check('2: Pinned unpins: git is on the rail, not in the group', railMods(s2).join() === 'git' && !pinned(s2, 'git'), JSON.stringify(railMods(s2)));
  check('2: ...the rail is a strip 52 px wide on the right edge, the full height', !!strip && Math.abs(strip.width - 52) <= 1 && Math.abs(strip.right - s2.dock.right) <= 1 && Math.abs(strip.height - s2.dock.height) <= 1,
    strip && JSON.stringify([strip.width, strip.right, s2.dock.right]));
  const t1 = termWidth(s2);
  check('2: ...the terminal is narrower by about that strip, the boxes tile, terminal === fit === pty', Math.abs((t0 - t1) - 52) <= 2 && tiles(s2).length === 0 && a2.ok,
    `${t0} -> ${t1}; ${tiles(s2).join('; ')}; ${sizeText(s2)}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-unpinned.png') });
  // A second tab on the rail (same strip, same terminal width), so the click-only checks have another icon to hover and switch to.
  await view(app, 'select', { id: 'vault' });
  await view(app, 'pinClick', { module: 'vault' });
  const a2b = await settled(app);
  check('2: a second panel (vault) is unpinned too: the rail holds git and vault, the terminal is no narrower', railMods(a2b.s).length === 2 && termWidth(a2b.s) === t1, JSON.stringify([railMods(a2b.s), termWidth(a2b.s), t1]));

  // A float over the place the panel will open: the stacking is measured with one present (PR #168 B1).
  await view(app, 'dock', { id: 'fog', target: { float: { x: 840, y: 10, w: 330, h: 2000 } } });
  const sf = (await settled(app)).s;
  check('2: a float is up, over where the rail panel will open', sf.floats.length === 1, JSON.stringify(sf.floats.map(f => [f.id, f.rect.left, f.rect.right])));

  // 3 ---------------------------------------------------------------------------------
  // Side tabs open on click only (BACKLOG #138, #106): a REAL pointer resting on a tab, or on every tab in turn, opens nothing.
  const pushes0 = sf.pushes;
  const sentBefore = JSON.stringify(sf.sent);
  // A positive control for every hover: the page itself says the pointer is over the icon (:hover), so "nothing opened" can't be a
  // pointer that never arrived.
  const pointerOn = async (id) => { await moveTo(app, railTab(await viewState(app), id)); return !!(await waitFor(async () => (((await view(app, 'isHovered', { id })) || {}).hovered ? true : null), 2000, 20)); };
  const gitOn = await pointerOn('git');
  await sleep(HOVER_REST_MS);
  const rested = await viewState(app);
  check('3: a REAL pointer resting on the git icon (the page reports it :hover) for ' + HOVER_REST_MS + ' ms opens nothing', gitOn && rested.popover === null && rested.railState.module === null, JSON.stringify([gitOn, rested.railState]));
  const sweptOn = []; const railIds = railMods(await viewState(app));
  for (const id of railIds) sweptOn.push(await pointerOn(id));
  await sleep(HOVER_REST_MS);
  const swept = await viewState(app);
  check('3: ...and sweeping the pointer over every rail icon (each reported :hover) opens nothing either', sweptOn.length === railIds.length && railIds.length > 1 && sweptOn.every(Boolean) && swept.popover === null && swept.railState.module === null, JSON.stringify([sweptOn, swept.railState]));
  await view(app, 'railClick', { id: 'git' });
  const open = await waitFor(async () => { const v = await viewState(app); return v.popover ? v : null; }, 3000, 20);
  check('3: a click on the tab opens the panel', !!open && open.popover.module === 'git' && open.railState.module === 'git', JSON.stringify(open && open.railState));
  if (open) {
    await sleep(250);
    const so = await viewState(app);
    const pr = so.popover.rect;
    check('3: ...once it has slid in, it holds git, sits inside the window, left of the rail, and says where it slid in from',
      so.popover.module === 'git' && pr.left >= 0 && pr.right <= so.dock.right + 1 && pr.right <= strip.left + 1 && so.popover.from === 'right',
      JSON.stringify([so.popover.module, pr.left, pr.right, strip.left, so.popover.from]));
    check('3: ...it is ABOVE the float it overlaps: z-index 1000, an opaque background, and the element at its middle is the panel (PR #168 B1)',
      overlaps(pr, so.floats[0].rect) && so.popover.z === '1000' && so.popover.bg !== 'rgba(0, 0, 0, 0)' && so.popover.bg !== 'transparent' && so.popover.hit,
      JSON.stringify([overlaps(pr, so.floats[0].rect), so.popover.z, so.popover.bg, so.popover.hit]));
    check('3: ...with a Pin button that is not pressed', !!so.popover.pin && so.popover.pin.text === 'Pin' && so.popover.pin.pressed === 'false', JSON.stringify(so.popover.pin));
    check('3: ...and the slide is a named animation of the page\'s (the one for the right edge)', so.popover.animation === 'dpeek-from-right' || so.popover.animation === 'none', so.popover.animation);
    check('3: ...the terminal did not move or resize, the pty was told nothing new, and nothing was saved',
      termWidth(so) === t1 && JSON.stringify(so.sent) === sentBefore && so.pushes === pushes0,
      `${termWidth(so)} vs ${t1}; pushes ${so.pushes} vs ${pushes0}`);
    await command(app, { cmd: 'screenshot', file: path.join(shots, '3-click-open.png') });
  }

  // 4 ---------------------------------------------------------------------------------
  // The panel is open: the pointer leaving it, resting on the terminal, and passing over the rail's tabs change nothing.
  await hoverTerm(app);
  await sleep(HOVER_REST_MS);
  const away = await viewState(app);
  check('4: the pointer leaving for ' + HOVER_REST_MS + ' ms does not close the open panel', !!away.popover && away.popover.module === 'git' && away.railState.module === 'git', JSON.stringify(away.railState));
  const overOn = [];
  for (const id of railMods(await viewState(app))) overOn.push(await pointerOn(id));
  await sleep(HOVER_REST_MS);
  const over = await viewState(app);
  check('4: ...and hovering the other icons (each reported :hover) does not swap it: git is still the open panel', overOn.every(Boolean) && !!over.popover && over.popover.module === 'git' && over.railState.module === 'git', JSON.stringify([overOn, over.railState]));
  const other = 'vault';   // the second tab on the rail (see check 2)
  await view(app, 'railClick', { id: other });
  const switched = await waitFor(async () => { const v = await viewState(app); return v.popover && v.popover.module === other ? v : null; }, 3000, 20);
  check('4: clicking another icon switches to it', !!switched && switched.railState.module === other, JSON.stringify(switched && switched.railState));
  await view(app, 'railClick', { id: other });
  const sliding = await waitFor(async () => { const v = await viewState(app); return v.popover && v.popover.closing ? v : null; }, 3000, 8);
  check('4: clicking the open icon again closes it, sliding out first (the popover is marked closing and still holds its panel)', !!sliding && sliding.popover.panels.join() === other, JSON.stringify(sliding && sliding.popover.panels));
  const gone = await waitFor(async () => { const v = await viewState(app); return v.popover === null ? v : null; }, 3000, 50);
  check('4: ...and is gone once the slide ran', !!gone && gone.railState.module === null);

  // 4b: ONLY a press in the terminal closes an open panel (#138, Ricardo round 2); the rail's empty strip, the header and another
  // dock panel's body leave it open.
  await view(app, 'railClick', { id: 'git' });
  await waitFor(async () => (await viewState(app)).popover, 3000, 20);
  for (const [what, selector] of [['the rail\'s empty strip', '#dock > .drail[data-rail="dock"]'], ['the header', 'header']]) {
    await view(app, 'outsidePress', { selector });
    await sleep(400);
    const kept = await viewState(app);
    check('4b: a press on ' + what + ' leaves the open panel open', !!kept.popover && kept.railState.module === 'git', JSON.stringify(kept.railState));
  }
  await view(app, 'outsidePress', { selector: '#termwrap' });
  const termClosed = await waitFor(async () => { const v = await viewState(app); return v.popover === null ? v : null; }, 3000, 50);
  check('4b: a press in the terminal closes it', !!termClosed && termClosed.railState.module === null, JSON.stringify(termClosed && termClosed.railState));
  await view(app, 'railClick', { id: 'git' });
  await waitFor(async () => (await viewState(app)).popover, 3000, 20);
  await view(app, 'focus', { selector: '.drail button[data-module="git"]' });   // the terminal may already hold focus (a synthetic click moves none): put it on the rail first so going into the terminal is a real move
  await sleep(100);
  check('4b: focus on the rail button leaves the open panel open', !!(await viewState(app)).popover);
  await view(app, 'focusInto', { selector: '#term textarea' });
  const focusClosed = await waitFor(async () => { const v = await viewState(app); return v.popover === null ? v : null; }, 3000, 50);
  check('4b: the keyboard going into the terminal closes it (keys never type into it behind an open panel)', !!focusClosed && focusClosed.railState.module === null, JSON.stringify(focusClosed && focusClosed.railState));


  // 5 ---------------------------------------------------------------------------------
  // Its own setup: git alone on the rail, everything else docked, and the float back (checks 3 and 4 left a second tab on the rail).
  await view(app, 'layout', { layout: T.unpin(T.defaultLayout(IDS), 'git') });
  await view(app, 'dock', { id: 'fog', target: { float: { x: 840, y: 10, w: 330, h: 2000 } } });
  await settled(app);
  await clickTab(app, 'git');
  await waitFor(async () => (await viewState(app)).popover, 3000, 20);
  await view(app, 'focus', { selector: '.dpeek .dpin' });
  await view(app, 'pinClick', { on: 'panel' });
  const a5 = await settled(app);
  const s5 = a5.s;
  check('5: Pin on the open panel docks it: git is in a group again, the rail is gone, the popover closed',
    pinned(s5, 'git') && s5.rails.length === 0 && s5.popover === null && s5.layout.rail.length === 0, JSON.stringify([railMods(s5), s5.layout.rail]));
  check('5: ...the terminal is back to its width without a rail, the boxes tile, terminal === fit === pty', Math.abs(termWidth(s5) - t0) <= 1 && tiles(s5).length === 0 && a5.ok, `${termWidth(s5)} vs ${t0}; ${tiles(s5).join('; ')}`);
  check('5: ...and the keyboard followed the panel: focus is on its tab in the group, not on the page (PR #168 Y1)', heldIs(s5, 'git', 'zone-tabs'), JSON.stringify(s5.held));

  // 6 ---------------------------------------------------------------------------------
  await view(app, 'select', { id: 'git' });
  await view(app, 'focus', { selector: '.dgroup .dpin' });
  await view(app, 'pinClick', { module: 'git' });
  const a6 = await settled(app);
  check('6: Pinned again unpins: the rail is back and the terminal is as wide as with it before', railMods(a6.s).join() === 'git' && Math.abs(termWidth(a6.s) - t1) <= 1 && a6.ok, `${termWidth(a6.s)} vs ${t1}`);
  check('6: ...focus is on the panel\'s tab on the rail, so a second Enter opens it and unpins nothing else (PR #168 Y1, Y5)', heldIs(a6.s, 'git', 'drail') && /unpinned/.test(a6.s.announce), JSON.stringify([a6.s.held, a6.s.announce]));

  // 7 ---------------------------------------------------------------------------------
  // (the click-only checks 3 and 4 above already cover: hover opens nothing, another icon switches, the icon again closes)
  await view(app, 'railClick', { id: 'git' });
  await sleep(100);
  await view(app, 'key', { key: 'Escape' });
  const esc = await waitFor(async () => { const v = await viewState(app); return v.popover === null ? v : null; }, 3000, 50);
  check('7: Esc closes it and the keyboard goes back to the tab on the rail', !!esc && heldIs(esc, 'git', 'drail'), JSON.stringify(esc && esc.held));
  await view(app, 'railClick', { id: 'git' });
  await view(app, 'outsidePress', { selector: '#termwrap' });
  const out = await waitFor(async () => { const v = await viewState(app); return v.popover === null ? v : null; }, 3000, 50);
  check('7: ...and a press outside closes it', !!out);
  // 7b: Enter / Space on a focused rail icon is a click (a button's own key activation reaches the page as a click with detail 0)
  await view(app, 'railClick', { id: 'git', byKey: true });
  const byKey = await waitFor(async () => { const v = await viewState(app); return v.popover ? v : null; }, 3000, 20);
  check('7b: a keyboard activation of the icon opens the panel', !!byKey && byKey.popover.module === 'git' && byKey.railState.module === 'git', JSON.stringify(byKey && byKey.railState));
  await view(app, 'outsidePress', { selector: '#termwrap' });
  await waitFor(async () => (await viewState(app)).popover === null, 3000, 50);

  // 8 ---------------------------------------------------------------------------------
  await view(app, 'hide', { id: 'git' });
  const s8 = (await settled(app)).s;
  check('8: Hide takes git off the rail', s8.layout.hidden.includes('git') && s8.rails.length === 0, JSON.stringify([s8.layout.hidden, railMods(s8)]));
  await view(app, 'openMenu', { which: 'layout' });
  await view(app, 'menuTick', { id: 'git' });
  const s8b = (await settled(app)).s;
  check('8: ...and ticking it in the Window menu brings it back as a rail tab (unpinned, the default)', railMods(s8b).join() === 'git' && !s8b.layout.hidden.includes('git'), JSON.stringify([railMods(s8b), s8b.layout.hidden]));
  await view(app, 'closeMenu');

  // 8c: the tab menus (PR #168 B2, and the shortcut the design asks for)
  const railMenu = await view(app, 'tabMenu', { id: 'git' });
  check('8c: right-click on a rail tab offers Pin and Hide <name>, and no Move or Float', railMenu.items.includes('Pin') && railMenu.items.some(i => /^Hide \S/.test(i)) && !railMenu.items.includes('Move') && !railMenu.items.includes('Float'), JSON.stringify(railMenu.items));
  await view(app, 'closeMenu');
  const treeBefore = readBytes(TREE_FILE);
  await view(app, 'openMenu', { which: 'move', id: 'vault' });
  await view(app, 'menuCheck');
  await view(app, 'menuButton', { text: 'Unpin' });
  const s8d = (await settled(app)).s;
  await sleep(500);
  check('8c: Unpin from the tab menu with "Just this tab" ticked changes this tab only: it has its own layout and the saved global one is byte-identical (PR #168 B2)',
    s8d.own === true && s8d.layout.rail.includes('vault') && Buffer.compare(readBytes(TREE_FILE) || Buffer.alloc(0), treeBefore || Buffer.alloc(0)) === 0, JSON.stringify([s8d.own, s8d.layout.rail]));
  await view(app, 'dropOwn', {});
  await settled(app);

  // 9 ---------------------------------------------------------------------------------
  await view(app, 'dblclick', { selector: '.dgroup:not(.dfloat) > .zone-tabs' });
  const a9 = await settled(app);
  const onRail = railMods(a9.s).length;
  check('9: a double-click on the empty tab bar unpins every tab of the group: no group is left, the rest of the modules are on the rail (the float stays)',
    a9.s.groups.length === 0 && onRail === IDS.length - 2 && a9.ok && tiles(a9.s).length === 0, JSON.stringify([a9.s.groups.length, onRail, tiles(a9.s)]));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '9-all-unpinned.png') });
  checkFaces('12: the dock rail', a9.s.rails.find(r => r.id === 'dock'));
  // The icon follows the tab's colour: dim at rest, the text colour under the pointer, the accent while its panel is open.
  const first12 = railMods(a9.s)[0];
  await clickTab(app, first12);
  const hov = await waitFor(async () => { const v = await viewState(app); return v.popover ? v : null; }, 3000, 20);
  const faceOf = (v, id) => v.rails.find(r => r.id === 'dock').faces.find(f => f.module === id);
  const open12 = hov && faceOf(hov, first12);
  const rest12 = hov && hov.rails.find(r => r.id === 'dock').faces.find(f => f.module !== first12);
  check('12: the open tab\'s icon is a different colour from a resting tab\'s, and each icon is its tab\'s colour', !!open12 && !!rest12 && open12.iconStroke === open12.buttonColor && rest12.iconStroke === rest12.buttonColor && open12.buttonColor !== rest12.buttonColor,
    JSON.stringify([open12 && [open12.iconStroke, open12.buttonColor], rest12 && [rest12.iconStroke, rest12.buttonColor]]));
  await pressOutside(app);
  await waitFor(async () => { const v = await viewState(app); return v.popover === null ? v : null; }, 3000, 20);
  // A wider Interface font (Dexter F1): the names are measured again, so every one still fits the rail's width.
  const nameWidths = (v) => v.rails.find(r => r.id === 'dock').faces.map(f => [f.module, f.nameScrollWidth, Math.round(f.fontPx * 100) / 100]);
  await view(app, 'uiFont', { name: 'Verdana' });
  await sleep(600);
  const v12 = await viewState(app);
  const widths12 = nameWidths(v12);
  check('12: after switching the Interface font to Verdana every name on the vertical rail still fits (scrollWidth <= 46)', widths12.every(([, w]) => w <= 46), JSON.stringify(widths12));
  check('12: ...and the font did change the page (a name measured differently from before)', JSON.stringify(widths12) !== JSON.stringify(nameWidths(a9.s)), JSON.stringify(widths12.slice(0, 3)));
  await view(app, 'uiFont', { name: '' });
  await sleep(300);

  // 10: every tab stays reachable on a short window (PR #168 Y4)
  await view(app, 'squeeze', { height: 320 });
  const s10 = (await settled(app)).s;
  const dr = s10.rails.find(r => r.id === 'dock');
  check('10: with every panel unpinned in a short window, the rail scrolls (overflow auto, more tabs than room)', !!dr && dr.scroll.overflowY === 'auto' && dr.scroll.scrollHeight > dr.scroll.clientHeight, JSON.stringify(dr && dr.scroll));
  await view(app, 'railScroll', { to: 'end' });
  const s10b = await viewState(app);
  const dr2 = s10b.rails.find(r => r.id === 'dock');
  const last = dr2.tabRects[dr2.tabRects.length - 1];
  check('10: ...and scrolled to its end the last tab is inside the rail, reachable', last.top >= dr2.rect.top - 1 && last.bottom <= dr2.rect.bottom + 1, JSON.stringify([last.top, last.bottom, dr2.rect.top, dr2.rect.bottom]));
  await view(app, 'railScroll', { to: 'start' });
  await view(app, 'squeeze', {});
  await settled(app);

  // 11: reduced motion: no slide in, none out, and it still closes (PR #168 Y6, G2)
  await command(app, { cmd: 'reduced-motion', on: true });          // the OS setting, emulated: the CSS media query and matchMedia both see it
  const first = railMods((await viewState(app)))[0];
  await clickTab(app, first);
  const r11 = await waitFor(async () => { const v = await viewState(app); return v.popover ? v : null; }, 3000, 20);
  check('11: under reduced motion the panel opens without an animation', !!r11 && r11.popover.animation === 'none', r11 && r11.popover.animation);
  await pressOutside(app);
  let sawClosing = false;
  const r11b = await waitFor(async () => { const v = await viewState(app); if (v.popover && v.popover.closing) sawClosing = true; return v.popover === null ? v : null; }, 3000, 8);
  check('11: ...and closes at once on a press in the terminal, with no slide-out stage', !!r11b && !sawClosing);

  await quitApp(app);

  // 12: a folded group's rails (#159) look the same: a vertical one beside the terminal, a horizontal one under it
  const lay = T.normalize({
    version: 2, floats: [], rail: [], hidden: T.HIDDEN_UNTIL_USED.slice(), seat: {},
    root: { type: 'split', dir: 'col', sizes: [0, 160], kids: [
      { type: 'split', dir: 'row', sizes: [0, 220], kids: [{ type: 'term' }, { type: 'group', id: 'side', tabs: ['agents', 'vault', 'bugvault', 'fog', 'git'] }] },
      { type: 'group', id: 'foot', tabs: ['models', 'projects', 'style', 'resources', 'ask'] },
    ] },
  }, IDS);
  fs.writeFileSync(TREE_FILE, JSON.stringify(lay));
  const second = await launchReady(container);
  check('12: the window came up again with the folded-group layout', !!second.ready);
  if (second.ready) {
    await view(second.app, 'foldAll');
    const a12 = await settled(second.app);
    const rails = a12.s.rails.filter(r => r.id !== 'dock');
    check('12: folding makes a vertical rail beside the terminal and a horizontal one under it', rails.some(r => r.dir === 'v') && rails.some(r => r.dir === 'h'), JSON.stringify(rails.map(r => [r.dir, r.modules.length])));
    for (const r of rails) checkFaces('12: folded ' + r.dir + ' rail', r);
    const vr = rails.find(r => r.dir === 'v');
    const hr = rails.find(r => r.dir === 'h');
    check('12: the vertical rail is 52 wide, the horizontal one is 34 tall', !!vr && !!hr && Math.abs(vr.rect.width - 52) <= 1 && Math.abs(hr.rect.height - 34) <= 1, JSON.stringify([vr && vr.rect.width, hr && hr.rect.height]));
    await command(second.app, { cmd: 'screenshot', file: path.join(shots, '12-folded-group-rails.png') });
    await quitApp(second.app);
  }

  // 12: a collapsed group in a narrow column is a short horizontal rail: its names shrink together until every tab fits (Dexter F2)
  const narrow = T.normalize({
    version: 2, floats: [], rail: [], hidden: T.HIDDEN_UNTIL_USED.slice(), seat: {},
    root: { type: 'split', dir: 'row', sizes: [0, 180], kids: [{ type: 'term' }, { type: 'split', dir: 'col', sizes: [100, 100], kids: [
      { type: 'group', id: 'top', tabs: ['models', 'projects', 'style'] },
      { type: 'group', id: 'low', tabs: ['agents', 'vault', 'fog', 'bugvault'] },
    ] }] },
  }, IDS);
  fs.writeFileSync(TREE_FILE, JSON.stringify(narrow));
  const third = await launchReady(container);
  check('12: the window came up with a narrow column', !!third.ready);
  if (third.ready) {
    if ((await viewState(third.app)).groups.length === 0) { await view(third.app, 'foldAll'); await settled(third.app); }      // the window may remember the last run's fold-all
    await view(third.app, 'collapse', { id: 'low' });
    const a12n = await settled(third.app);
    const rowRail = a12n.s.rails.find(r => r.dir === 'h');
    check('12: collapsing the lower group of the narrow column gives a horizontal rail', !!rowRail, JSON.stringify(a12n.s.rails.map(r => [r.dir, r.modules])));
    if (rowRail) {
      // Four tabs in 180 px: their names would be under 8 px, so the row is icons only (Ricardo: "icons only when tight")
      const lastRight = Math.max(...rowRail.tabRects.map(r => r.right));
      check('12: the 180 px row of four tabs is icons only: the names are hidden, every tab fits the rail, nothing is cut off', rowRail.names === 'off' && rowRail.faces.every(f => f.nameRect.width === 0) && lastRight <= rowRail.rect.right + 0.5, JSON.stringify([rowRail.names, lastRight, rowRail.rect.right]));
      check('12: ...the icons are 16 px and still named: each tab has its tooltip and aria-label', rowRail.faces.every(f => Math.abs(f.iconRect.width - 16) <= 0.5) && rowRail.tabTitles.every(([t, l]) => !!t && !!l), JSON.stringify(rowRail.tabTitles));
      check('12: ...and a row of icons that cannot fit would scroll sideways (overflow-x auto)', rowRail.scroll.overflowX === 'auto', rowRail.scroll.overflowX);
    }
    await command(third.app, { cmd: 'screenshot', file: path.join(shots, '12b-narrow-row-rail.png') });
    await quitApp(third.app);
  }

  // 12: a rail that folds while the rails are hidden (lean mode) is fitted when they show again (Dexter r2 F1)
  const lean = T.normalize({
    version: 2, floats: [], rail: ['git'], hidden: IDS.filter(i => !['canvas', 'resources', 'git'].includes(i)), seat: {},
    root: { type: 'split', dir: 'row', sizes: [0, 180], kids: [{ type: 'term' }, { type: 'group', id: 'gR', tabs: ['canvas', 'resources'] }] },
  }, IDS);
  fs.writeFileSync(TREE_FILE, JSON.stringify(lean));
  const fourth = await launchReady(container);
  check('12: the window came up with the lean-mode layout', !!fourth.ready);
  if (fourth.ready) {
    await view(fourth.app, 'squeeze', { width: 600, height: 520 });
    const open600 = (await settled(fourth.app)).s;
    check('12: at 600 px the group is open beside the terminal', open600.groups.some(g => g.tabs.includes('canvas')), JSON.stringify(open600.groups.map(g => g.tabs)));
    await view(fourth.app, 'leanClass', { on: true });
    await view(fourth.app, 'squeeze', { width: 480, height: 520 });
    const folded = (await settled(fourth.app)).s;
    check('12: lean on, resized to 480 px, the group folds into a rail', folded.rails.some(r => r.modules.includes('canvas')), JSON.stringify(folded.rails.map(r => [r.dir, r.modules])));
    await view(fourth.app, 'leanClass', { on: false });
    const shown = (await settled(fourth.app)).s;
    const gr = shown.rails.find(r => r.modules.includes('canvas'));
    check('12: lean off: the rail that folded while hidden is fitted: every name inside its room (scrollWidth <= 46)', !!gr && gr.faces.every(f => f.nameScrollWidth > 0 && f.nameScrollWidth <= 46), JSON.stringify(gr && gr.faces.map(f => [f.module, f.nameScrollWidth, f.fontPx])));
    await command(fourth.app, { cmd: 'screenshot', file: path.join(shots, '12c-lean-off-fitted.png') });
    // Focus mode (Dexter r3): the rails are hidden while a font changes, and are fitted when focus goes off. (A background tab can't be
    // emulated here: this is the page's own focus path, in the one window.)
    await view(fourth.app, 'focusMode', { on: true });
    await view(fourth.app, 'uiFont', { name: 'Verdana' });
    await view(fourth.app, 'focusMode', { on: false });
    await sleep(600);
    const afterFocus = await viewState(fourth.app);
    const gr2 = afterFocus.rails.find(r => r.modules.includes('canvas'));
    check('12: focus on, a wider font picked, focus off: the rail is fitted (every name scrollWidth 1..46)', !!gr2 && gr2.faces.every(f => f.nameScrollWidth > 0 && f.nameScrollWidth <= 46), JSON.stringify(gr2 && gr2.faces.map(f => [f.module, f.nameScrollWidth, f.fontPx])));
    await quitApp(fourth.app);
  }
}

// Rail tabs as faces (the design: line icon over a horizontal name, 11 px at most, one line, inside the tab).
function checkFaces(what, rail) {
  const faces = (rail && rail.faces) || [];
  check(what + ': has tabs', faces.length > 0, String(faces.length));
  const tab = (f) => TABS.find(t => t.id === f.module);
  const vertical = rail && rail.dir === 'v';
  check(what + ': each tab shows its icon and its name, named for a screen reader by the label alone', faces.every(f => !!f.iconRect && f.iconHidden === 'true' && f.name === tab(f).label && f.label === tab(f).label), JSON.stringify(faces.filter(f => !f.iconRect || f.name !== tab(f).label).map(f => f.module)));
  const px = vertical ? 24 : 16;
  check(what + ': icons are ' + px + ' px, one colour (the tab\'s text colour), a line (weight ' + (vertical ? '1' : '1.5, which reads as 1 px at 16') + ')', faces.every(f => Math.abs(f.iconRect.width - px) <= 0.5 && Math.abs(f.iconRect.height - px) <= 0.5 && f.iconStroke === f.buttonColor && Math.abs(f.iconStrokeWidth - (vertical ? 1 : 1.5)) < 0.01), JSON.stringify(faces.slice(0, 2).map(f => [f.iconRect.width, f.iconStroke, f.buttonColor, f.iconStrokeWidth])));
  check(what + ': no vertical text', faces.every(f => f.writingMode === 'horizontal-tb'), JSON.stringify([...new Set(faces.map(f => f.writingMode))]));
  check(what + ': names are 11 px at most', faces.every(f => f.fontPx > 0 && f.fontPx <= 11), JSON.stringify(faces.map(f => [f.module, f.fontPx])));
  check(what + ': every name is on one line', faces.every(f => f.nameRect.height <= 16), JSON.stringify(faces.map(f => [f.module, Math.round(f.nameRect.height)])));
  if (vertical) {
    check(what + ': every name sits inside the rail, none cut off', faces.every(f => f.nameRect.left >= rail.rect.left - 0.5 && f.nameRect.right <= rail.rect.right + 0.5), JSON.stringify(faces.map(f => [f.module, Math.round(f.nameRect.width), Math.round(f.fontPx * 10) / 10])));
    check(what + ': the icon is above its name', faces.every(f => f.iconRect.bottom <= f.nameRect.top + 1), '');
  } else {
    check(what + ': the icon is in front of its name', faces.every(f => f.iconRect.right <= f.nameRect.left + 1), '');
  }
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayouts();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.DOCK_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    if (refused) process.exit(2);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
