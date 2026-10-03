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
 *  12  layout presets (D3), through the Window menu's own buttons and fields: save shows the name with a
 *      thumbnail and writes the presets file once; apply brings the boxes back (an identical one writes
 *      nothing); the same name asks to replace; rename (and a refusal); Esc closes a field, then the menu;
 *      delete asks, then removes; a second tab sees the list; an unreadable layout-presets.json is left
 *      untouched, shown as "couldn't read", saving is off, and it recovers when the file becomes readable
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and
 * every CLAUDE_CUSTOM_* variable are deleted before the window is launched; registry, portraits,
 * uploads and user data are temp folders. The window's store is `<worktree>/.harness/state`: the
 * layout files in it are snapshotted and put back (idempotently), so the probe leaves no layout behind and
 * never touches another checkout's. It REFUSES (exit 2) while a live host is open on this checkout. A small window is a held-down #dock (`squeeze`), not an OS window.
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
const PRESETS_FILE = path.join(STATE_DIR, 'layout-presets.json');          // dockable panels D3
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
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

// A live host on THIS checkout that is not one of ours: its window would see the layout files moved under it and
// the probe's trees pushed into it, and the restore would overwrite what it saved (PR #100 Miguel I1, as probe-wand).
function liveForeignHost() {
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (!id || !Number.isInteger(id.pid)) continue;
    let alive = false;
    try { process.kill(id.pid, 0); alive = true; } catch (err) { alive = !!err && err.code === 'EPERM'; }
    if (alive && !path.resolve(String(id.cwd || '')).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) return id;
  }
  return null;
}

let refused = false;

async function main() {
  const foreign = liveForeignHost();
  if (foreign) {
    refused = true;
    console.log(`REFUSED: a live host (pid ${foreign.pid}, ${foreign.cwd}) is open on this checkout. The probe moves .harness/state/layout-*.json on purpose; close that window, or run the probe from another checkout.`);
    return;
  }
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const f of [V1_FILE, TREE_FILE, PRESETS_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }

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

    // PR #100 Dexter F3: a divider pressed and released without moving stores nothing (the unit tests pin the
    // decision; this is the page not writing).
    const layoutIdle = JSON.stringify((await viewState(app)).layout);
    const pushesIdle = (await viewState(app)).pushes;
    await view(app, 'gutter', { path: bar.path, i: bar.i, delta: 0 });
    await sleep(1200);
    const idle = await viewState(app);
    check('7: a divider pressed and released without moving writes nothing (PR #100 F3)', idle.pushes === pushesIdle && JSON.stringify(idle.layout) === layoutIdle, `pushes ${pushesIdle} -> ${idle.pushes}`);

    // PR #100 Dexter F6: another window changes the layout while this one's divider is held. The release lands on
    // THAT layout (it keeps what the other window did), or is dropped if the split is gone.
    await view(app, 'hide', { id: 'git' });
    const gitHidden = (await viewState(app)).layout;
    await view(app, 'layout', { layout: example });
    cur = (await settled(app)).s;
    const widthBefore = groupWith(cur, 'agents').rect.width;
    await view(app, 'gutterRace', { path: bar.path, i: bar.i, delta: 40, pushed: gitHidden });
    const raced = (await settled(app)).s;
    check('7: a divider released after another window hid Git keeps Git hidden and still moves the divider (PR #100 F6)',
      raced.layout.hidden.includes('git') && Math.abs(groupWith(raced, 'agents').rect.width - widthBefore - 40) <= 2,
      JSON.stringify([raced.layout.hidden, widthBefore, groupWith(raced, 'agents').rect.width]));
    await view(app, 'layout', { layout: example });
    await view(app, 'hide', { id: 'vault' });
    const vaultHidden = (await viewState(app)).layout;
    await view(app, 'layout', { layout: example });
    cur = (await settled(app)).s;
    await view(app, 'gutterRace', { path: bar.path, i: bar.i, delta: 40, pushed: vaultHidden });
    const dropped = await viewState(app);
    check('7: ...and when the dragged split is gone, the drag is dropped: the other window\'s layout stands (PR #100 F6)',
      JSON.stringify(dropped.layout) === JSON.stringify(vaultHidden), JSON.stringify(dropped.layout.hidden));
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
  check('6: three more moves within the same zone rebuild the overlay no more (PR #100 S1)', esc.ok && esc.during.idleRedraws === 0, JSON.stringify(esc.during));
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

  // 6b ----------------------------------------------------------------------------
  // PR #100 Miguel I2: a drag whose release never comes (Alt-Tab, an OS dialog) ends itself and changes nothing.
  {
    const layoutNow = JSON.stringify((await viewState(app)).layout);
    const pushesNow = (await viewState(app)).pushes;
    const barNow = (await viewState(app)).gutters.find(g2 => g2.dir === 'row');
    const cases = [
      ['a tab drag, then a move with no button down', { kind: 'tab', id: 'vault', how: 'nobutton' }],
      ['a tab drag, then the window loses focus', { kind: 'tab', id: 'vault', how: 'blur' }],
      ['a divider drag, then a move with no button down', { kind: 'gutter', path: barNow && barNow.path, i: barNow && barNow.i, delta: 40, how: 'nobutton' }],
      ['a divider drag, then the window loses focus', { kind: 'gutter', path: barNow && barNow.path, i: barNow && barNow.i, delta: 40, how: 'blur' }],
    ];
    for (const [label, args] of cases) {
      const r = await view(app, 'abortedDrag', args);
      const lit = args.kind === 'tab' ? r.during && r.during.dragging && r.during.zones > 0 : r.during && r.during.divider && r.during.drawn;
      const over = r.after && !r.after.dragging && r.after.zones === 0 && !r.after.ghost && !r.after.divider && !r.after.drawn;
      await sleep(800);
      const st = await viewState(app);
      check(`6: ${label}: the drag ends, and nothing is changed or saved (PR #100 I2)`,
        r.ok && !!lit && !!over && JSON.stringify(st.layout) === layoutNow && st.pushes === pushesNow && tiles((await settled(app)).s).length === 0,
        JSON.stringify(r));
    }
  }

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

  // 12 (dockable panels D3: layout presets) ----------------------------------------------------
  // The Window menu's Presets section, driven through its own buttons and fields. A write is counted by the
  // pushes the page receives from main (one per `layout-presets:set`), as check 7 counts the layout's.
  {
    const ask = () => view(app, 'presets');
    const mclick = (selector) => view(app, 'menuClick', { selector });
    const type = (selector, text, key) => view(app, 'menuType', { selector, text, key });
    const openMenu = () => view(app, 'openMenu', { which: 'layout' });
    const rowSel = (name, act) => `.lm-preset[data-preset="${name}"] [data-preset-act="${act}"]`;
    const waitFor12 = (pred, ms = 5000) => waitFor(async () => { const p = await ask(); return p && p.ok && pred(p) ? p : null; }, ms, 100);
    const fileList = () => { try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } catch { return null; } };
    const fileNames = () => { const l = fileList(); return Array.isArray(l) ? l.map(p => p.name).join(',') : null; };
    const layoutPushes12 = async () => (await viewState(app)).pushes;
    // One operation, one write: the page is pushed exactly one list, and the watcher doesn't push it a second time.
    const wroteOnce = async (before, label) => {
      await sleep(1200);
      const p = await ask();
      check(`12: ${label}: the presets file is written once (one push, none echoed by the watcher)`, p.pushes === before + 1, `pushes ${before} -> ${p.pushes}`);
    };

    await view(app, 'layout', { layout: example });
    const base12 = (await settled(app)).s;
    const exampleKey = rectKey(base12);
    const p0 = await ask();
    check('12: dockPresets.thumbBoxes is a function in the real window; with no presets file the list is loaded, usable and empty',
      p0.exported === 'function' && p0.loaded && p0.usable && p0.names.length === 0, JSON.stringify(p0));
    check('12: ...and merely starting wrote no presets file', !fs.existsSync(PRESETS_FILE));

    // save
    await openMenu();
    const m0 = await ask();
    check('12: the Window menu has a Presets section with a Save this layout button', m0.menuOpen && m0.saveOpen, JSON.stringify(m0));
    await mclick('[data-preset-act="save-open"]');
    const field = await ask();
    check('12: Save this layout opens a name field inside the menu', field.mode === 'save' && field.fields.some(f => f.action === 'save'), JSON.stringify(field));
    await type('input[data-preset-field="save"]', 'Reviewing', 'Enter');
    const saved = await waitFor12(p => p.names.includes('Reviewing') && p.rows.length === 1);
    check('12: saving lists the name with a thumbnail and rename / delete buttons that have accessible names',
      !!saved && saved.rows[0].name === 'Reviewing' && saved.rows[0].boxes >= 3
        && saved.rows[0].labels.includes('Rename preset \'Reviewing\'') && saved.rows[0].labels.includes('Delete preset \'Reviewing\'') && saved.rows[0].focusable,
      JSON.stringify(saved && saved.rows));
    check('12: after a save, focus is on that preset\'s row (never dropped to the page)',
      saved.active.preset === 'Reviewing' && saved.active.act === 'apply', JSON.stringify(saved.active));
    const f1 = fileList();
    check('12: ...the file holds that one preset: its name and exactly the placement that was on screen',
      Array.isArray(f1) && f1.length === 1 && f1[0].name === 'Reviewing' && JSON.stringify(f1[0].layout) === JSON.stringify(example), JSON.stringify(f1).slice(0, 300));
    await wroteOnce(p0.pushes, 'save');
    await command(app, { cmd: 'screenshot', file: path.join(shots, '12-presets-menu.png') });
    await view(app, 'closeMenu');

    // apply
    await view(app, 'hide', { id: 'fog' });
    const changed = (await settled(app)).s;
    check('12: (setup) the layout was changed after the preset was saved', rectKey(changed) !== exampleKey);
    await sleep(1200);
    const lp0 = await layoutPushes12();
    await openMenu();
    await mclick(rowSel('Reviewing', 'apply'));
    const applied = (await settled(app)).s;
    check('12: applying the preset brings the saved boxes back', rectKey(applied) === exampleKey && JSON.stringify(applied.layout) === JSON.stringify(example), keyDiff(base12, applied));
    check('12: ...and closes the menu', !(await ask()).menuOpen);
    await sleep(1200);
    const lp1 = await layoutPushes12();
    check('12: ...saving the layout once, through the one placement path', lp1 === lp0 + 1, `layout pushes ${lp0} -> ${lp1}`);
    await openMenu();
    await mclick(rowSel('Reviewing', 'apply'));
    await sleep(1200);
    check('12: applying a preset identical to the current layout changes nothing and writes nothing', (await layoutPushes12()) === lp1 && (await ask()).pushes === saved.pushes);

    // save under the same name: asks, then replaces in place
    await view(app, 'hide', { id: 'fog' });
    await sleep(1200);
    const pr0 = await ask();
    await openMenu();
    await mclick('[data-preset-act="save-open"]');
    await type('input[data-preset-field="save"]', 'reviewing', 'Enter');
    const asked = await ask();
    check('12: saving under a name that exists (any case) asks to replace it, naming it, and writes nothing yet',
      asked.mode === 'replace' && asked.asking.some(t => t.includes('Replace \'Reviewing\'?')) && asked.pushes === pr0.pushes && JSON.stringify(fileList()) === JSON.stringify(f1),
      JSON.stringify([asked.mode, asked.asking, asked.pushes, pr0.pushes]));
    await mclick('[data-preset-act="replace-confirm"]');
    await waitFor12(p => p.pushes === pr0.pushes + 1 && p.mode === 'idle');
    const f2 = fileList();
    check('12: confirming replaces it in place: still one preset, its own name, the new layout (Map hidden)',
      Array.isArray(f2) && f2.length === 1 && f2[0].name === 'Reviewing' && f2[0].layout.hidden.includes('fog'), JSON.stringify(f2).slice(0, 300));
    await wroteOnce(pr0.pushes, 'replace');
    await view(app, 'closeMenu');

    // rename, including a refusal
    await view(app, 'layout', { layout: example });
    await openMenu();
    await mclick('[data-preset-act="save-open"]');
    await type('input[data-preset-field="save"]', 'Other', 'Enter');
    await waitFor12(p => p.names.includes('Other'));
    await sleep(1200);
    const pr1 = await ask();
    await mclick(rowSel('Reviewing', 'rename'));
    const rf = await ask();
    check('12: rename opens a field holding the current name', rf.mode === 'rename' && rf.fields.some(f => f.action === 'rename' && f.value === 'Reviewing'), JSON.stringify(rf.fields));
    check('12: ...focused with its text selected, because it just opened', rf.active.field === 'rename' && rf.active.selection[0] === 0 && rf.active.selection[1] === rf.active.selection[2] && rf.active.selection[2] > 0, JSON.stringify(rf.active));
    await type('input[data-preset-field="rename"]', 'other', 'Enter');
    const refused = await ask();
    check('12: renaming to a name another preset has is refused in the menu, and writes nothing',
      refused.mode === 'rename' && refused.notes.some(n => /already exists/.test(n)) && refused.pushes === pr1.pushes && fileNames() === 'Reviewing,Other',
      JSON.stringify([refused.mode, refused.notes, fileNames()]));
    check('12: ...the refusal is said once, and focus is back in the field with the caret at its end, the typed name not selected',
      refused.notes.filter(n => /already exists/.test(n)).length === 1 && refused.active.field === 'rename'
        && refused.active.selection[0] === refused.active.selection[2] && refused.active.selection[1] === refused.active.selection[2],
      JSON.stringify([refused.notes, refused.active]));
    const layoutOfFirst = JSON.stringify(fileList()[0].layout);
    await type('input[data-preset-field="rename"]', 'Writing', 'Enter');
    const renamedTo = await waitFor12(p => p.names.includes('Writing'));
    check('12: after a rename, focus is on the renamed row', renamedTo.active.preset === 'Writing' && renamedTo.active.act === 'apply', JSON.stringify(renamedTo.active));
    check('12: renaming changes the name in place, keeps the order and the layout, and writes the file once',
      fileNames() === 'Writing,Other' && JSON.stringify(fileList()[0].layout) === layoutOfFirst, fileNames());
    await wroteOnce(pr1.pushes, 'rename');

    // Esc: a field first, then the menu
    await mclick(rowSel('Writing', 'rename'));
    await type('input[data-preset-field="rename"]', undefined, 'Escape');
    const e1 = await ask();
    check('12: Esc closes an open field and leaves the menu open, the preset unchanged', e1.mode === 'idle' && e1.menuOpen && e1.fields.length === 0 && fileNames() === 'Writing,Other', JSON.stringify([e1.mode, e1.menuOpen]));
    check('12: ...and focus goes back to the control that opened the field (that preset\'s rename button)', e1.active.preset === 'Writing' && e1.active.act === 'rename', JSON.stringify(e1.active));

    // delete asks first
    await mclick(rowSel('Writing', 'delete'));
    const del1 = await ask();
    check('12: delete asks "Delete \'Writing\'?" first, and nothing is removed yet',
      del1.mode === 'delete' && del1.asking.some(t => t.includes('Delete \'Writing\'?')) && fileNames() === 'Writing,Other', JSON.stringify([del1.mode, del1.asking]));
    check('12: ...the question is announced and the confirm button, focused, names the preset it deletes',
      del1.active.act === 'delete-confirm' && del1.active.label === 'Delete \'Writing\' now', JSON.stringify(del1.active));
    await type('.lm-title', undefined, 'Escape');
    const e2 = await ask();
    check('12: Esc backs out of the question: both presets stay, the menu stays open, focus is back on that preset\'s delete button',
      e2.mode === 'idle' && e2.menuOpen && e2.names.length === 2 && e2.active.preset === 'Writing' && e2.active.act === 'delete', JSON.stringify([e2.mode, e2.names, e2.active]));
    await type('.lm-title', undefined, 'Escape');
    const e3 = await ask();
    check('12: ...and Esc again closes the menu, with focus on the Window button rather than the page', !e3.menuOpen && e3.active.id === 'layout-btn', JSON.stringify(e3.active));
    const pr2 = await ask();
    await openMenu();
    await mclick(rowSel('Writing', 'delete'));
    await mclick('[data-preset-act="delete-confirm"]');
    const afterDelete = await waitFor12(p => !p.names.includes('Writing'));
    check('12: confirming deletes it and only it', fileNames() === 'Other', fileNames());
    check('12: ...and focus moves to the next row (here the only one left), not to the page', afterDelete.active.preset === 'Other' && afterDelete.active.act === 'apply', JSON.stringify(afterDelete.active));
    await wroteOnce(pr2.pushes, 'delete');
    await view(app, 'closeMenu');

    // another window removes the preset an open rename / delete is about: said, never swallowed
    const keepList = fileList();
    await openMenu();
    await mclick(rowSel('Other', 'rename'));
    fs.writeFileSync(PRESETS_FILE, JSON.stringify([]));
    const goneRename = await waitFor12(p => p.mode === 'idle' && p.notes.some(n => /'Other' no longer exists/.test(n)), 6000);
    check('12: another window deleting the preset an open rename is about resets the menu to the plain list and says "no longer exists"',
      !!goneRename && goneRename.fields.length === 0 && goneRename.names.length === 0, JSON.stringify(await ask()));
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(keepList));
    await waitFor12(p => p.names.includes('Other'), 6000);
    await mclick(rowSel('Other', 'delete'));
    fs.writeFileSync(PRESETS_FILE, JSON.stringify([]));
    const goneDelete = await waitFor12(p => p.mode === 'idle' && p.notes.some(n => /'Other' no longer exists/.test(n)), 6000);
    check('12: ...and the same for an open delete question', !!goneDelete && goneDelete.asking.length === 0, JSON.stringify(await ask()));
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(keepList));
    await waitFor12(p => p.names.includes('Other'), 6000);
    await view(app, 'closeMenu');

    // a second tab sees the list, and a preset saved there shows here
    const tabA = await onTab('feat/a');
    const seenA = tabA && (await waitFor12(p => p.names.join() === 'Other'));
    check('12: a second tab sees the saved list', !!seenA, seenA ? '' : JSON.stringify(await ask()));
    await openMenu();
    await mclick('[data-preset-act="save-open"]');
    await type('input[data-preset-field="save"]', 'FromA', 'Enter');
    await waitFor12(p => p.names.includes('FromA'));
    await view(app, 'closeMenu');
    const back = await onTab('develop');
    const seenD = back && (await waitFor12(p => p.names.includes('FromA')));
    check('12: ...and a preset saved in that tab shows in the first (main pushes the list to every tab)', !!seenD, seenD ? '' : JSON.stringify(await ask()));

    // PR #103 Dexter 2: a window that still believed the list was readable cannot save over a file that has become
    // unreadable since: main refuses it, the bytes are untouched, and the section says it can't read the list
    await openMenu();
    const junkLater = '{ not a list either';
    fs.writeFileSync(PRESETS_FILE, junkLater);
    await sleep(1500);
    await mclick('[data-preset-act="save-open"]');
    await type('input[data-preset-field="save"]', 'Stale', 'Enter');
    const refusedUnreadable = await waitFor12(p => !p.usable, 6000);
    check('12: saving from a window whose list was readable, once the file isn\'t, is refused in main: the bytes are untouched and the section says it can\'t read the list',
      !!refusedUnreadable && readBytes(PRESETS_FILE).toString() === junkLater && refusedUnreadable.notes.some(n => /couldn't be read/.test(n)), JSON.stringify(refusedUnreadable));
    await view(app, 'closeMenu');

    // an unreadable file is "couldn't read": never overwritten, saving off, and it recovers when readable
    await quitApp(app);
    const junkPresets = '[ { this is not a list';
    fs.writeFileSync(PRESETS_FILE, junkPresets);
    ({ app, ready } = await launchReady(container));
    if (!ready) { check('12: the window came up on an unreadable layout-presets.json', false, app.out.slice(-600)); return; }
    await settled(app);
    await openMenu();
    const un = await waitFor12(p => p.loaded);
    check('12: an unreadable presets file reads as "couldn\'t read", not as no presets: no rows, no Save button, a note says so',
      !!un && !un.usable && un.rows.length === 0 && !un.saveOpen && un.notes.some(n => /couldn't be read/.test(n)), JSON.stringify(un));
    await sleep(1500);
    check('12: ...and the file is left exactly as it was', readBytes(PRESETS_FILE).toString() === junkPresets);
    fs.writeFileSync(PRESETS_FILE, JSON.stringify([{ name: 'Recovered', layout: example }]));
    const rec = await waitFor12(p => p.usable && p.names.includes('Recovered'), 8000);
    check('12: when the file becomes readable (another window wrote it) the list appears and saving is allowed again', !!rec && rec.saveOpen, JSON.stringify(rec));
    await view(app, 'closeMenu');
  }

  await quitApp(app);
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
