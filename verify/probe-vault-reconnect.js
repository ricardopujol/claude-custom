'use strict';
/**
 * Backlog #36: a socket reattach must not move focus out of a half-typed vault
 * secret, in a REAL window with a REAL host.  (re-runnable)
 *
 *   node verify/probe-vault-reconnect.js        (exit 0 = every check held)
 *
 * ws.onopen used to call term.focus() on every open, so a drop while a secret
 * was half-typed sent the rest of it into the session. No unit test can see the
 * page's focus, so the window is driven: the vault opens, a DUMMY string goes
 * in its secret field (never a real secret), the socket is closed, the page
 * reattaches on its own, and more text is typed with insertText -- which lands
 * wherever focus is, as a keystroke does.
 *
 *   1  the window came up and the vault is showing
 *   2  with the field focused, the socket drops and reattaches: focus is still
 *      in the field, the typed tail landed in it, and nothing reached the session
 *   3  with nothing focused, a reattach still gives the terminal the keyboard
 *   4  Tab onto the Show button, then a reattach: the button keeps focus (a
 *      Shift+Tab from the terminal would send keys into the session)
 *   5  a window relaunched with the vault already docked at load (so #vault-search
 *      holds focus before the socket opens): the FIRST open focuses the terminal
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills;
 * ELECTRON_RUN_AS_NODE and every other CLAUDE_CUSTOM_* variable is deleted;
 * registry, portraits, uploads and user data are temp folders; every host this
 * started is killed. WINDOWS ONLY.
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

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-vault-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
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
// Check 5 needs the layout the first launch saved (vault showing) to be read
// by the second, and the probe must leave none behind.
// Dockable panels D1: the layout the page saves is the split tree, under its own key (layout-tree.json);
// an L1 file is only migrated from. Both go aside, so the first launch starts on the default.
const LAYOUT_FILES = [LAYOUT_FILE, path.join(HARNESS_DIR, 'state', 'layout-tree.json')];
const backupOf = f => `${f}.probe-backup`;
const movedAside = new Set();
function setAsideLayout() {
  for (const f of LAYOUT_FILES) if (fs.existsSync(f)) { fs.renameSync(f, backupOf(f)); movedAside.add(f); }
}
function restoreLayout() {
  for (const f of LAYOUT_FILES) {
    try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
    if (movedAside.has(f)) { try { fs.renameSync(backupOf(f), f); } catch (e) { console.log(`(could not restore ${f}: ${e.message})`); } }
  }
}

// --- the app -------------------------------------------------------------------------
async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const SET_HERE = new Set(['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
    'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS']);
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
  // Every CLAUDE_CUSTOM_* a launching tab leaked, except what this probe set above.
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !SET_HERE.has(k)) delete env[k];
  }
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
  for (const id of hostsUnder(dev)) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreLayout);

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');

  setAsideLayout();
  let app = await launchApp(container);
  const ready = await viewReady(app);
  check('1: the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  await view(app, 'select', { id: 'vault' });
  const open = await waitFor(async () => ((await viewState(app)).shown.includes('vault') ? true : null), 4000);
  check('1: the vault is showing', !!open);
  if (!open) { await command(app, { cmd: 'quit' }); return; }

  // 2 -----------------------------------------------------------------------------
  const r = await view(app, 'reconnect', { blur: false });
  check('2: the socket dropped and the page reattached on its own', r.ok && r.reattached, JSON.stringify(r));
  check('2 (#36): ...focus is still in the secret field', r.heldId === 'vault-secret' && r.startedIn === 'vault-secret',
    `started in #${r.startedIn}, held #${r.heldId}`);
  check('2 (#36): ...the next characters landed in the field, none in the session',
    r.value === 'dummy-tail' && !r.sent.join('').includes('tail'),
    `field is ${JSON.stringify(r.value)}, the session got ${JSON.stringify(r.sent.join('')) || 'nothing'}`);

  // 3 -----------------------------------------------------------------------------
  const t = await view(app, 'reconnect', { blur: true });
  check('3: with nothing focused, a reattach gives the terminal the keyboard', t.ok && t.reattached && t.inTerm,
    JSON.stringify(t));

  // 4 -----------------------------------------------------------------------------
  const b = await view(app, 'reconnect', { blur: false, focus: '#vault-mask' });
  check('4 (#36): Tab onto Show, then a reattach: the button keeps focus, the terminal does not take it',
    b.ok && b.reattached && b.heldId === 'vault-mask' && !b.inTerm, `held #${b.heldId}, in terminal ${b.inTerm}`);
  check('4 (#36): ...and no typed characters reached the session', !b.sent.join('').includes('tail'),
    JSON.stringify(b.sent.join('')));

  // 5 -----------------------------------------------------------------------------
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 15000);
  app = await launchApp(container);
  const again = await viewReady(app);
  const f = again && await view(app, 'focusState');
  check('5: relaunched, the vault is showing at load', !!f && f.shown.includes('vault'), f ? `shown ${f.shown}` : 'no view');
  check('5 (#36 Dexter F1): ...and the FIRST open still focuses the terminal, not #vault-search',
    !!f && f.inTerm, f ? `focus is #${f.id}, in terminal ${f.inTerm}` : '');

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
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
