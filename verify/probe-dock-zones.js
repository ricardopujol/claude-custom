'use strict';
/**
 * Layout pass L1 (dock zones), in a REAL window with a REAL host.  (re-runnable)
 *
 *   node verify/probe-dock-zones.js        (exit 0 = every check held)
 *   DOCK_PROBE_SHOTS=<dir>                 also keep screenshots there
 *
 * The unit tests pin the decisions (test/dock-layout*.test.js,
 * test/dock-zones-display.test.js). What no unit test can see is the page:
 * whether the zones are where the plan says, whether the panels really moved,
 * whether the content fills its zone (#9) -- and above all whether the
 * terminal's size and the pty's agree after every layout change. A mismatch
 * garbles the session's output and nothing else notices. The host applies
 * exactly the size it is sent, so "the pty matches" is measured as: what fits
 * the container now === what xterm has === the last resize the page sent.
 *
 *   1  first launch: the default layout is today's window, and it is saved
 *   2  every module into every zone: its panel is there, the sizes agree
 *   3  #9: each showing panel's content reaches the bottom of its zone
 *   4  a zone collapses to its rail and back; Ctrl+B's toggle closes all and
 *      brings back exactly what was showing; Hide and back
 *   5  the right-click menu and the layout menu offer the right moves
 *   6  Just this tab: one tab gets its own layout, the other keeps the global
 *      one; the own layout survives the window closing and reattaching (the
 *      host kept it); Make this global hands it to the other tab
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills;
 * ELECTRON_RUN_AS_NODE is deleted; registry, portraits, uploads and user data
 * are temp folders. The install's own global layout file is moved aside and
 * put back, so the probe leaves no layout behind. WINDOWS ONLY.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const LAYOUT_FILE = path.join(HARNESS_DIR, 'state', 'layout-global.json');
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
const ZONES = ['left', 'top', 'bottom', 'right'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-dock-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
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

// --- the install's own layout file: aside for the run, back afterwards ---------
const LAYOUT_BACKUP = `${LAYOUT_FILE}.probe-backup`;
let movedAside = false;
function setAsideLayout() {
  if (fs.existsSync(LAYOUT_FILE)) { fs.renameSync(LAYOUT_FILE, LAYOUT_BACKUP); movedAside = true; }
}
function restoreLayout() {
  try { fs.rmSync(LAYOUT_FILE, { force: true }); } catch { /* gone */ }
  if (movedAside) { try { fs.renameSync(LAYOUT_BACKUP, LAYOUT_FILE); } catch (e) { console.log(`(could not restore ${LAYOUT_FILE}: ${e.message})`); } }
}

// --- the app -------------------------------------------------------------------------
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
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
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

const sizeText = (v) => (v && v.term ? `term ${v.term.cols}x${v.term.rows}, fits ${v.fit && `${v.fit.cols}x${v.fit.rows}`}, sent ${v.sent && `${v.sent.cols}x${v.sent.rows}`}` : JSON.stringify(v));

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
const featA = path.join(container, 'feat-a');
function killEverything() {
  for (const id of [...hostsUnder(dev), ...hostsUnder(featA)]) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreLayout);

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
  setAsideLayout();

  let app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  // 1 -----------------------------------------------------------------------------
  const r = ready.zones.right;
  check('1: the default is today\'s window: all seven modules on the right, Agents showing',
    JSON.stringify(r.tabs) === JSON.stringify(IDS) && JSON.stringify(r.panels) === '["agents"]',
    `tabs ${r.tabs}, panels ${r.panels}`);
  check('1: 180 px wide (plus its border), every other zone empty',
    Math.abs(r.rect.width - 181) <= 1 && ['left', 'top', 'bottom'].every(z => ready.zones[z].empty),
    `right ${r.rect.width}, empty ${['left', 'top', 'bottom'].filter(z => ready.zones[z].empty)}`);
  const saved = await waitFor(() => fs.existsSync(LAYOUT_FILE), 5000);
  check('1: the first global layout is saved', !!saved, LAYOUT_FILE);
  const first = await sizesAgree(app);
  check('1: terminal, fit and pty agree at launch', first.ok, sizeText(first.s));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-default.png') });

  // 2 -----------------------------------------------------------------------------
  let movesOk = 0;
  let sizesOk = 0;
  const bad = [];
  for (const id of IDS) {
    for (const target of ZONES) {
      await view(app, 'move', { id, target });
      const there = await waitFor(async () => {
        const v = await viewState(app);
        return v && v.zones[target].panels.includes(id) ? v : null;
      }, 4000);
      if (there) movesOk++; else bad.push(`${id}->${target}: not there`);
      const agree = await sizesAgree(app);
      if (agree.ok) sizesOk++; else bad.push(`${id}->${target}: ${sizeText(agree.s)}`);
      if (['agents', 'vault', 'models'].includes(id) && (target === 'top' || target === 'left')) {
        await command(app, { cmd: 'screenshot', file: path.join(shots, `2-${id}-${target}.png`) });
      }
    }
  }
  const total = IDS.length * ZONES.length;
  check(`2: every module moved into every zone shows there (${total} moves)`, movesOk === total, bad.filter(b => b.endsWith('not there')).join('; '));
  check(`2: after every move, terminal, fit and pty agree (${total} moves)`, sizesOk === total, bad.filter(b => !b.endsWith('not there')).slice(0, 4).join('; '));

  // 3 -----------------------------------------------------------------------------
  const short = [];
  for (const id of IDS) {
    await view(app, 'select', { id });
    await sleep(250);
    const m = await view(app, 'measure');
    const p = m && m.panels && m.panels[id];
    if (!p) { short.push(`${id}: not showing`); continue; }
    const gap = Math.round(p.holderBottom - p.contentBottom);
    if (gap > 2) {
      short.push(`${id}: ${gap}px short (lowest: #${p.last}, panel bottom ${Math.round(p.panelBottom)}, scrolled ${p.scrollTop})`);
      await command(app, { cmd: 'screenshot', file: path.join(shots, `3-short-${id}.png`) });
    }
  }
  check('3 (#9): every panel\'s content reaches the bottom of its zone', short.length === 0, short.join('; '));

  // 4 -----------------------------------------------------------------------------
  const before = await viewState(app);
  const showing = before.layout.active.right;
  await view(app, 'select', { id: showing });
  const collapsed = await waitFor(async () => { const v = await viewState(app); return v.zones.right.collapsed ? v : null; }, 3000);
  check('4: clicking the showing tab collapses its zone to the rail',
    !!collapsed && collapsed.zones.right.rect.width <= 30 && collapsed.zones.right.tabs.length === IDS.length,
    collapsed ? `rail ${collapsed.zones.right.rect.width}px, ${collapsed.zones.right.tabs.length} tabs` : 'never collapsed');
  const railAgree = await sizesAgree(app);
  check('4: ...and the terminal took the room', railAgree.ok, sizeText(railAgree.s));
  await view(app, 'select', { id: showing });
  await view(app, 'move', { id: 'vault', target: 'left' });
  const open2 = await viewState(app);
  await view(app, 'toggleAll');
  const allShut = await waitFor(async () => { const v = await viewState(app); return v.shown.length === 0 ? v : null; }, 3000);
  check('4: the panels toggle (Ctrl+B) collapses every zone', !!allShut);
  await view(app, 'toggleAll');
  const back = await waitFor(async () => {
    const v = await viewState(app);
    return JSON.stringify(v.layout.active) === JSON.stringify(open2.layout.active) ? v : null;
  }, 3000);
  check('4: ...and again brings back exactly what was showing', !!back, back ? '' : JSON.stringify(open2.layout.active));
  await view(app, 'move', { id: 'style', target: 'hide' });
  const hiddenV = await viewState(app);
  check('4: a hidden module has no tab in any zone',
    Object.values(hiddenV.zones).every(z => !z.tabs.includes('style')));
  await view(app, 'move', { id: 'style', target: 'right' });
  const backV = await viewState(app);
  check('4: ...and moving it to a zone brings it back, showing', backV.zones.right.panels.includes('style'));

  // 5 -----------------------------------------------------------------------------
  const mm = await view(app, 'openMenu', { which: 'move', id: 'vault' });
  const where = (await viewState(app)).zones;
  const vaultAt = Object.keys(where).find(z => where[z].tabs.includes('vault'));
  const labels = (mm.items || []).map(i => i.text);
  const disabled = (mm.items || []).filter(i => i.disabled).map(i => i.text.toLowerCase());
  check('5: right-click offers Left, Right, Top, Bottom, Hide, with its own zone disabled',
    JSON.stringify(labels) === JSON.stringify(['Left', 'Right', 'Top', 'Bottom', 'Hide']) && JSON.stringify(disabled) === JSON.stringify([vaultAt]),
    `${labels} / disabled ${disabled} / vault is ${vaultAt}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '5-move-menu.png') });
  await view(app, 'closeMenu');
  const lm = await view(app, 'openMenu', { which: 'layout' });
  const rowButtons = (lm.items || []).filter(i => ['L', 'R', 'T', 'B', '–'].includes(i.text));
  check('5: the layout menu has a row for every module, one place marked for each',
    rowButtons.length === IDS.length * 5 && rowButtons.filter(i => i.on).length === IDS.length
      && (lm.items || []).some(i => i.text === 'Reset to default'),
    `${rowButtons.length} buttons, ${rowButtons.filter(i => i.on).length} marked`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '5-layout-menu.png') });
  await view(app, 'closeMenu');

  // 6 -----------------------------------------------------------------------------
  const onTab = async (label) => {
    await command(app, { cmd: 'select', label });
    return viewReady(app);
  };
  let a = await onTab('feat/a');
  check('6: the second tab is up', !!a);
  await view(app, 'move', { id: 'fog', target: 'bottom', justThisTab: true });
  a = await waitFor(async () => { const v = await viewState(app); return v.own && v.zones.bottom.tabs.includes('fog') ? v : null; }, 4000);
  check('6: Just this tab gives feat/a its own layout', !!a);
  let d = await onTab('develop');
  check('6: ...while develop keeps the global one', !!d && !d.own && !d.zones.bottom.tabs.includes('fog'),
    d ? `own ${d.own}, bottom ${d.zones.bottom.tabs}` : 'no view');
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 15000);
  app = await launchApp(container);
  await viewReady(app);
  a = await onTab('feat/a');
  const kept = await waitFor(async () => { const v = await viewState(app); return v.own && v.zones.bottom.tabs.includes('fog') ? v : null; }, 6000);
  check('6: feat/a\'s own layout survives the window closing and reattaching (the host kept it)', !!kept);
  await view(app, 'dropOwn', { makeGlobal: true });
  d = await onTab('develop');
  const follows = await waitFor(async () => { const v = await viewState(app); return !v.own && v.zones.bottom.tabs.includes('fog') ? v : null; }, 6000);
  check('6: Make this global: develop takes the layout feat/a had', !!follows);
  a = await onTab('feat/a');
  check('6: ...and feat/a follows the global one again', !!a && !a.own);

  await command(app, { cmd: 'quit' });
}

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

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayout();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.DOCK_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
