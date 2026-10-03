'use strict';
/**
 * Dockable panels D1 (the split tree), in a REAL window with a REAL host.  (re-runnable)
 *
 *   node verify/probe-dock-tree.js         (exit 0 = every check held)
 *   DOCK_PROBE_SHOTS=<dir>                 also keep screenshots there
 *
 * The unit tests pin the decisions (test/dock-tree*.test.js, test/dock-drag.test.js,
 * test/dock-tree-display.test.js). What no unit test can see is the page: that the three new scripts
 * export what the renderer calls (a plain <script> that fails to export breaks only the real window),
 * whether the boxes are where the plan says, whether a drag really moves a panel without rebuilding it,
 * and above all whether the terminal's size and the pty's agree after every layout change. The host
 * applies exactly the size it is sent, so "the pty matches" is measured as: what fits the container
 * now === what xterm has === the last resize the page sent.
 *
 *   1  the three exports exist in the real window
 *   2  first launch with an L1 layout-global.json: the same picture, layout-tree.json now exists,
 *      layout-global.json is byte-identical
 *   3  first launch with an unreadable layout-tree.json: the default is drawn, the file untouched
 *   4  Ricardo's example built with dock actions: after each, terminal === fit === pty, each panel
 *      is inside its group's box, and the boxes tile #dock with no overlap
 *   5  the vault's field is the SAME DOM node after three moves; #termwrap never changes parent
 *   7  a divider drag changes exactly two boxes and writes the store once
 *   6  a synthetic pointer drag of Vault onto Git's right band puts Vault beside Git; mid-drag the
 *      overlay holds the zones with exactly one hot; Esc mid-drag changes nothing; a press without
 *      a drag selects
 *   8  hide every panel: the Window menu still opens and lists them; ticking one brings it back
 *   9  a small window: rails appear, the terminal keeps 320 x 160; widening brings the boxes back
 *  10  Ctrl+B folds everything to rails and back; focus mode in and out
 *  11  Just this tab: tab A has its own layout, tab B the global one; reattaching keeps A's
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and
 * every CLAUDE_CUSTOM_* variable are deleted before the window is launched; registry, portraits,
 * uploads and user data are temp folders. The window's store is `<worktree>/.harness/state`: the
 * layout files in it are moved aside and put back, so the probe leaves no layout behind and never
 * touches another checkout's. A small window is a held-down #dock (`squeeze`), not an OS window.
 * The only processes stopped are the ones this probe started. WINDOWS ONLY.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const STATE_DIR = path.join(HARNESS_DIR, 'state');
const V1_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
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

// --- the window's layout files: aside for the run, back afterwards ----------------
const BACKUPS = [];
function setAside(file) {
  if (fs.existsSync(file)) { fs.renameSync(file, `${file}.probe-backup`); BACKUPS.push(file); }
}
function restoreLayouts() {
  for (const f of [V1_FILE, TREE_FILE]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  for (const f of BACKUPS) { try { fs.renameSync(`${f}.probe-backup`, f); } catch (e) { console.log(`(could not restore ${f}: ${e.message})`); } }
}
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
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env });
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
const viewState = (app) => view(app, 'state');

// The three sizes that must agree once the page has refitted. Polled: the refit
// runs on a timer after each layout change.
async function sizesAgree(app) {
  const s = await waitFor(async () => {
    const v = await viewState(app);
    if (!v || !v.ok || !v.fit || !v.sent) return null;
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
const seenPids = new Set();
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
  for (const id of [...hostsUnder(dev), ...hostsUnder(featA)]) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreLayouts);

// The selected tab's view is up, its session started and the page sent a size.
async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
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
      if (!app.exited) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(app.child.pid); } catch { /* gone */ } }
    }
  }
  return { app, ready };
}
async function quitApp(app) {
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 15000);
  await sleep(3000);                                      // the old window lets go of its user-data lock
}

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  setAside(V1_FILE);
  setAside(TREE_FILE);

  // 2: an L1 layout, saved by an older build: Vault showing on the right at 240, Agents along the bottom.
  const v1 = {
    version: 1,
    zones: { left: [], right: ['vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'], top: [], bottom: ['agents'] },
    active: { left: null, right: 'vault', top: null, bottom: 'agents' }, hidden: [],
    size: { left: 180, right: 240, top: 160, bottom: 160 }, restore: null,
  };
  fs.writeFileSync(V1_FILE, JSON.stringify(v1));
  const v1Before = readBytes(V1_FILE);

  let app = await launchApp(container);
  let ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  // 1 -----------------------------------------------------------------------------
  check('1: dockTree.fit, dockTreeView.applyBoxes and dockDrag.zonesAt are functions in the real window',
    ready.exports.fit === 'function' && ready.exports.applyBoxes === 'function' && ready.exports.zonesAt === 'function',
    JSON.stringify(ready.exports));

  // 2 -----------------------------------------------------------------------------
  const first = await settled(app);
  const s2 = first.s;
  const right = s2.groups.find(g => g.id === 'right');
  const bottom = s2.groups.find(g => g.id === 'bottom');
  check('2: the L1 picture again: the right group is 240 wide and shows Vault, the bottom group is 160 high and shows Agents',
    !!right && !!bottom && Math.abs(right.rect.width - 240) <= 1 && right.panels[0] === 'vault'
      && Math.abs(bottom.rect.height - 160) <= 1 && bottom.panels[0] === 'agents' && Math.abs(bottom.rect.width - s2.dock.width) <= 1,
    JSON.stringify(s2.groups.map(g => [g.id, Math.round(g.rect.width), Math.round(g.rect.height), g.panels])));
  check('2: ...with the right group above the bottom one and the terminal taking the rest',
    !!right && !!bottom && right.rect.bottom <= bottom.rect.top + 1 && tiles(s2).length === 0, tiles(s2).join('; '));
  const wrote = await waitFor(() => fs.existsSync(TREE_FILE), 5000);
  check('2: layout-tree.json now exists', !!wrote, TREE_FILE);
  check('2: layout-global.json is byte-identical to before', Buffer.compare(readBytes(V1_FILE) || Buffer.alloc(0), v1Before) === 0);
  check('2: terminal, fit and pty agree at launch', first.ok, sizeText(first.s));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-migrated.png') });

  // 3 -----------------------------------------------------------------------------
  await quitApp(app);
  const junk = '{ this is not a layout';
  fs.writeFileSync(TREE_FILE, junk);
  ({ app, ready } = await launchReady(container));
  if (!ready) check('3: the window came up on an unreadable layout-tree.json', false, app.out.slice(-600));
  const s3 = ready && (await settled(app)).s;
  const g3 = s3 && s3.groups;
  check('3: an unreadable layout-tree.json draws the default: one right group of 180, every module, Agents showing',
    !!g3 && g3.length === 1 && g3[0].id === 'right' && Math.abs(g3[0].rect.width - 180) <= 1 && g3[0].tabs.length === IDS.length && g3[0].panels[0] === 'agents',
    JSON.stringify(g3 && g3.map(g => [g.id, g.rect.width, g.tabs.length, g.panels])));
  await sleep(1500);
  check('3: ...and the file is left exactly as it was', readBytes(TREE_FILE).toString() === junk);
  check('3: ...and the page says it could not read it', !!s3 && /Couldn't read the saved layout/.test(s3.title), s3 && s3.title);
  await quitApp(app);
  fs.rmSync(TREE_FILE, { force: true });

  // The rest runs on a clean tree: the default, then Ricardo's example.
  ({ app, ready } = await launchReady(container));
  if (!ready) { check('the window came up again', false, app.out.slice(-600)); return; }

  // 4 -----------------------------------------------------------------------------
  // "Agents and Vault side by side under the terminal; Git over Map over Bug vault in a right column;
  //  the rest hidden." Reset first, through the Window menu, so that path is exercised too.
  await view(app, 'openMenu', { which: 'layout' });
  await view(app, 'menuButton', { text: 'Reset layout' });
  const steps = [
    ['hide style', 'hide', { id: 'style' }],
    ['hide projects', 'hide', { id: 'projects' }],
    ['hide models', 'hide', { id: 'models' }],
    ['dock agents along the bottom edge', 'dock', { id: 'agents', target: { edge: 'bottom' } }],
    ['dock vault right of agents', 'dock', async (st) => ({ id: 'vault', target: { cell: groupWith(st, 'agents').id, side: 'right' } })],
    ['dock map under git', 'dock', { id: 'fog', target: { cell: 'right', side: 'bottom' } }],
    ['dock bug vault under map', 'dock', async (st) => ({ id: 'bugvault', target: { cell: groupWith(st, 'fog').id, side: 'bottom' } })],
  ];
  const termParents = new Set();
  const vaultTags = new Set();
  let stepsOk = 0;
  const bad4 = [];
  let cur = await viewState(app);
  vaultTags.add(cur.vaultNode);
  for (const [label, action, argsOrFn] of steps) {
    const args = typeof argsOrFn === 'function' ? await argsOrFn(cur) : argsOrFn;
    await view(app, action, args);
    const agree = await settled(app);
    cur = agree.s;
    termParents.add(cur.termParent);
    vaultTags.add(cur.vaultNode);
    const problems = [...(agree.ok ? [] : [sizeText(cur)]), ...tiles(cur), ...panelsInside(cur)];
    if (problems.length === 0) stepsOk++; else bad4.push(`${label}: ${problems.join(', ')}`);
  }
  check(`4: after each of ${steps.length} steps, terminal === fit === pty, each panel is inside its group, the boxes tile #dock`,
    stepsOk === steps.length, bad4.join(' | '));
  const gr = id => groupWith(cur, id);
  const sameRow = (a, b) => Math.abs(a.rect.top - b.rect.top) <= 1 && Math.abs(a.rect.height - b.rect.height) <= 1;
  const stacked = ['git', 'fog', 'bugvault'].every(id => gr(id)) && gr('git').rect.bottom <= gr('fog').rect.top + 1 && gr('fog').rect.bottom <= gr('bugvault').rect.top + 1
    && Math.abs(gr('git').rect.left - gr('bugvault').rect.left) <= 1;
  check('4: the example: Git over Map over Bug vault in a right column', stacked, JSON.stringify(['git', 'fog', 'bugvault'].map(id => gr(id) && [Math.round(gr(id).rect.left), Math.round(gr(id).rect.top)])));
  check('4: ...Agents and Vault side by side under the terminal',
    !!gr('agents') && !!gr('vault') && gr('agents') !== gr('vault') && sameRow(gr('agents'), gr('vault')) && gr('agents').rect.right <= gr('vault').rect.left + 6
      && gr('agents').rect.top >= cur.termwrap.bottom - 1,
    JSON.stringify([gr('agents') && gr('agents').rect, gr('vault') && gr('vault').rect]));
  check('4: ...and the rest hidden', JSON.stringify([...cur.layout.hidden].sort()) === JSON.stringify(['models', 'projects', 'style']), JSON.stringify(cur.layout.hidden));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '4-example.png') });
  const example = cur.layout;

  // 5 -----------------------------------------------------------------------------
  // three moves of the vault, a field with live state in it each time
  for (const target of [{ cell: 'term', side: 'left' }, { edge: 'top' }, { cell: gr('git').id, side: 'center' }]) {
    await view(app, 'dock', { id: 'vault', target });
    cur = (await settled(app)).s;
    termParents.add(cur.termParent);
    vaultTags.add(cur.vaultNode);
  }
  check('5: the vault\'s field is the same DOM node before and after three moves', vaultTags.size === 1 && !vaultTags.has(null), JSON.stringify([...vaultTags]));
  check('5: #termwrap\'s parent never changes (it is #dock throughout)', termParents.size === 1 && termParents.has('dock'), JSON.stringify([...termParents]));
  await view(app, 'layout', { layout: example });
  cur = (await settled(app)).s;

  // 7 -----------------------------------------------------------------------------
  // The bar between Agents and Vault (a plain split: both are groups).
  const before7 = cur;
  const bar = before7.gutters.find((g) => {
    const a = before7.groups.find(x => Math.abs(x.rect.right - g.rect.left) <= 1 && x.rect.top <= g.rect.top + 1 && x.rect.bottom >= g.rect.bottom - 1);
    const b = before7.groups.find(x => Math.abs(x.rect.left - g.rect.right) <= 1 && x.rect.top <= g.rect.top + 1 && x.rect.bottom >= g.rect.bottom - 1);
    return g.dir === 'row' && a && b && a.tabs.includes('agents');
  });
  check('7: a divider stands between Agents and Vault', !!bar, JSON.stringify(before7.gutters.map(g => [g.path, g.i, g.dir])));
  if (bar) {
    const pushes0 = before7.pushes;
    await view(app, 'gutter', { path: bar.path, i: bar.i, delta: 40 });
    const after7 = (await settled(app)).s;
    const moved = [...after7.groups.map(g => [g.id, g.rect]), ['term', after7.termwrap]].filter(([id, r]) => {
      const was = id === 'term' ? before7.termwrap : before7.groups.find(g => g.id === id).rect;
      return Math.abs(was.width - r.width) > 1 || Math.abs(was.height - r.height) > 1 || Math.abs(was.left - r.left) > 1;
    }).map(([id]) => id);
    check('7: a divider drag changes exactly two boxes (the two it sits between)', moved.length === 2 && moved.includes(groupWith(after7, 'agents').id) && moved.includes(groupWith(after7, 'vault').id), JSON.stringify(moved));
    await sleep(1200);
    const later = await viewState(app);
    check('7: ...and the store is written once for the whole drag', later.pushes === pushes0 + 1, `pushes ${pushes0} -> ${later.pushes}`);
    check('7: ...with every other box where it was', tiles(later).length === 0 && later.termwrap.width === before7.termwrap.width && later.termwrap.height === before7.termwrap.height);
    await view(app, 'layout', { layout: example });
    cur = (await settled(app)).s;
  }

  // 6 -----------------------------------------------------------------------------
  const click = await view(app, 'tabClick', { id: 'bugvault' });
  const afterClick = await viewState(app);
  check('6: a press without a drag stays a click: it selects the tab and starts no drag',
    click.ok && !click.after.dragging && groupWith(afterClick, 'bugvault').panels[0] === 'bugvault', JSON.stringify(click));
  const gitG = groupWith(cur, 'git');
  const rel = (r, fx, fy) => ({ x: r.left - cur.dock.left + r.width * fx, y: r.top - cur.dock.top + r.height * fy });
  const toGitRight = rel(gitG.rect, 0.9, 0.5);
  // Esc mid-drag changes nothing
  const layoutBefore = JSON.stringify((await viewState(app)).layout);
  const esc = await view(app, 'drag', { id: 'vault', to: toGitRight, escape: true });
  const afterEsc = await viewState(app);
  check('6: mid-drag the overlay holds the zones with exactly one hot, and a ghost follows',
    esc.ok && esc.during.dragging && esc.during.ghost && esc.during.zones >= 5 && esc.during.hot === 1, JSON.stringify(esc.during));
  check('6: Esc mid-drag changes nothing and clears the overlay',
    JSON.stringify(afterEsc.layout) === layoutBefore && !esc.after.dragging && esc.after.zones === 0 && !esc.after.ghost, JSON.stringify(esc.after));
  const drag = await view(app, 'drag', { id: 'vault', to: toGitRight });
  const afterDrag = (await settled(app)).s;
  const vg = groupWith(afterDrag, 'vault');
  const gg = groupWith(afterDrag, 'git');
  check('6: dropping Vault on Git\'s right band puts Vault beside Git',
    drag.ok && vg !== gg && vg.rect.left >= gg.rect.right - 1 && Math.abs(vg.rect.top - gg.rect.top) <= 1 && Math.abs(vg.rect.height - gg.rect.height) <= 1,
    JSON.stringify([gg.rect, vg.rect]));
  check('6: ...the drag is over (overlay cleared) and terminal === fit === pty',
    !drag.after.dragging && drag.after.zones === 0 && (await sizesAgree(app)).ok && tiles(afterDrag).length === 0, JSON.stringify(drag.after));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '6-vault-beside-git.png') });
  await view(app, 'layout', { layout: example });
  cur = (await settled(app)).s;

  // 8 -----------------------------------------------------------------------------
  // one panel out and back: its group, in its place
  const gitTabsBefore = groupWith(cur, 'bugvault').tabs;
  await view(app, 'hide', { id: 'bugvault' });
  await view(app, 'show', { id: 'bugvault' });
  const back1 = (await settled(app)).s;
  const bv = groupWith(back1, 'bugvault');
  const fg = groupWith(back1, 'fog');
  check('8: Hide then show puts a panel back where it was: under Map in the right column, as its own group',
    !!bv && JSON.stringify(bv.tabs) === JSON.stringify(gitTabsBefore) && bv.rect.top >= fg.rect.bottom - 1 && Math.abs(bv.rect.left - fg.rect.left) <= 1 && Math.abs(bv.rect.width - fg.rect.width) <= 1,
    JSON.stringify([bv && bv.tabs, bv && bv.rect, fg && fg.rect]));
  for (const id of IDS) await view(app, 'hide', { id });
  const none = (await settled(app)).s;
  check('8: with every panel hidden the terminal has the whole area', none.groups.length === 0 && Math.abs(none.termwrap.width - none.dock.width) <= 1 && Math.abs(none.termwrap.height - none.dock.height) <= 1,
    JSON.stringify([none.groups.length, none.termwrap.width, none.dock.width]));
  const menu = await view(app, 'openMenu', { which: 'layout' });
  check('8: ...and the Window menu still opens, listing every module, none ticked',
    menu.ok && menu.rows.filter(r => r.id).length === IDS.length && menu.rows.filter(r => r.id).every(r => !r.checked), JSON.stringify(menu.rows && menu.rows.map(r => [r.id, r.checked])));
  await view(app, 'menuTick', { id: 'git' });
  const ticked = (await settled(app)).s;
  check('8: ticking one brings it back, showing', !!groupWith(ticked, 'git') && groupWith(ticked, 'git').panels[0] === 'git' && tiles(ticked).length === 0);
  await view(app, 'closeMenu');
  await view(app, 'layout', { layout: example });
  cur = (await settled(app)).s;

  // 9 -----------------------------------------------------------------------------
  const wide = cur;
  const small = [];
  await view(app, 'squeeze', { width: 480, height: 520 });
  let sq = (await settled(app)).s;
  const col = groupWith(sq, 'git');
  small.push(['480: the right column is narrower than it asked but still at least 120', !!col && col.rect.width < groupWith(wide, 'git').rect.width && col.rect.width >= 119, col && col.rect.width]);
  small.push(['480: the terminal keeps at least 320 x 160', sq.termwrap.width >= 319 && sq.termwrap.height >= 159, `${sq.termwrap.width}x${sq.termwrap.height}`]);
  await view(app, 'squeeze', { width: 440, height: 520 });
  sq = (await settled(app)).s;
  small.push(['440: the right column is a rail listing git, fog, bugvault', sq.rails.some(r => ['git', 'fog', 'bugvault'].every(m => r.modules.includes(m)) && r.rect.width <= 29), JSON.stringify(sq.rails.map(r => [r.dir, r.rect.width, r.modules]))]);
  small.push(['440: the terminal keeps at least 320 x 160, the boxes tile', sq.termwrap.width >= 319 && sq.termwrap.height >= 159 && tiles(sq).length === 0, `${sq.termwrap.width}x${sq.termwrap.height} ${tiles(sq).join('; ')}`]);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '9-small.png') });
  await view(app, 'squeeze', { width: 330, height: 520 });
  sq = (await settled(app)).s;
  small.push(['330: no rail at all and the terminal has the whole width', sq.rails.length === 0 && sq.termwrap.width >= 329, `${sq.rails.length} rails, term ${sq.termwrap.width}`]);
  await view(app, 'squeeze', {});
  const wideAgain = (await settled(app)).s;
  small.push(['widened again: the boxes are as before', rectKey(wideAgain) === rectKey(wide), keyDiff(wide, wideAgain)]);
  for (const [label, ok, detail] of small) check(`9: ${label}`, ok, ok ? '' : String(detail));
  cur = wideAgain;

  // 10 ----------------------------------------------------------------------------
  const preFold = cur;
  await view(app, 'foldAll');
  const folded = (await settled(app)).s;
  check('10: the fold (Ctrl+B\'s toggle) makes every panel a rail', folded.groups.length === 0 && folded.rails.length >= 2 && folded.shown.length === 0, `${folded.groups.length} groups, ${folded.rails.length} rails`);
  await view(app, 'foldAll');
  const unfolded = (await settled(app)).s;
  check('10: ...and again brings every box back as it was', rectKey(unfolded) === rectKey(preFold), keyDiff(preFold, unfolded));
  await view(app, 'state', { focusTerm: true });         // Ctrl+B is read inside xterm's key handler: the terminal must hold the keyboard
  await command(app, { cmd: 'key', key: 'B', modifiers: ['control'] });
  const byKey = await waitFor(async () => { const v = await viewState(app); return v.rails.length >= 2 ? v : null; }, 4000);
  check('10: the real Ctrl+B key folds too', !!byKey);
  await view(app, 'state', { focusTerm: true });
  await command(app, { cmd: 'key', key: 'B', modifiers: ['control'] });
  const keyBack = await waitFor(async () => { const v = await viewState(app); return v.rails.length === 0 && v.groups.length > 0 ? v : null; }, 4000);
  check('10: ...and again unfolds', !!keyBack && rectKey(keyBack) === rectKey(preFold));
  const pre = await viewState(app);
  await command(app, { cmd: 'key', key: 'F', modifiers: ['control', 'shift'] });
  const inFocus = await waitFor(async () => { const v = await viewState(app); return v.focus && !v.header ? v : null; }, 4000);
  check('10: focus mode: only the terminal -- no header, the terminal fills the area',
    !!inFocus && Math.abs(inFocus.termwrap.width - inFocus.dock.width) <= 1 && Math.abs(inFocus.termwrap.height - inFocus.dock.height) <= 1, inFocus ? JSON.stringify([inFocus.termwrap.width, inFocus.dock.width]) : 'never entered');
  check('10: ...and the view took the strip\'s 34 px', !!inFocus && Math.abs(inFocus.innerHeight - pre.innerHeight - 34) <= 1, inFocus ? `${pre.innerHeight} -> ${inFocus.innerHeight}` : '');
  const focusAgree = await sizesAgree(app);
  check('10: ...with terminal, fit and pty agreeing', focusAgree.ok, sizeText(focusAgree.s));
  await command(app, { cmd: 'key', key: 'F', modifiers: ['control', 'shift'] });
  const outFocus = await waitFor(async () => { const v = await viewState(app); return !v.focus && v.header && rectKey(v) === rectKey(preFold) ? v : null; }, 4000);
  check('10: Ctrl+Shift+F again brings every box back as it was', !!outFocus);
  check('10: ...with terminal, fit and pty agreeing again', (await sizesAgree(app)).ok);

  // 11 ----------------------------------------------------------------------------
  const onTab = async (label) => {
    await command(app, { cmd: 'select', label });
    return viewReady(app);
  };
  let a = await onTab('feat/a');
  check('11: the second tab is up', !!a);
  await view(app, 'dock', { id: 'fog', target: { edge: 'left' }, justThisTab: true });
  a = await waitFor(async () => { const v = await viewState(app); return v.own && groupWith(v, 'fog') && groupWith(v, 'fog').rect.left <= v.dock.left + 1 ? v : null; }, 4000);
  check('11: Just this tab gives feat/a its own layout (Map along the left edge)', !!a);
  let d = await onTab('develop');
  check('11: ...while develop keeps the global one', !!d && !d.own && !!groupWith(d, 'fog') && groupWith(d, 'fog').rect.left > d.dock.left + 20,
    d ? `own ${d.own}` : 'no view');
  await quitApp(app);
  ({ app } = await launchReady(container));
  a = await onTab('feat/a');
  const kept = await waitFor(async () => { const v = await viewState(app); return v.own && groupWith(v, 'fog') && groupWith(v, 'fog').rect.left <= v.dock.left + 1 ? v : null; }, 6000);
  check('11: feat/a\'s own layout survives the window closing and reattaching (the host kept it)', !!kept);
  d = await onTab('develop');
  check('11: ...and develop is still on the global layout', !!d && !d.own);

  await quitApp(app);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayouts();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.DOCK_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
