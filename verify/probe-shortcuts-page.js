'use strict';
/**
 * PROBE: the shortcuts page (BACKLOG #43) and the header's "?" (#42) in a REAL window with a REAL host. (re-runnable)
 *
 *   node verify/probe-shortcuts-page.js        (exit 0 = every check held)
 *   SHORTCUTS_PROBE_SHOTS=<dir>                also keep screenshots there
 *
 * The unit tests pin the table and the markup; no unit test can send F1 through main's before-input-event, see where
 * the focus lands, or see the sheet over the window. This opens a window and checks, with REAL keys sent to the selected
 * view (the driver's `key` command):
 *
 *   1  the header has the "?" button and no keyboard hints; the sheet starts closed
 *   2  F1, pressed with the terminal focused, opens the sheet (main's shortcutFor -> the page), focus goes to the search box
 *   3  the sheet is complete (a row per table row, the four groups in order, the CLI's keys marked Claude Code), inside the
 *      window and below the header
 *   4  typing narrows it, a miss says so, clearing restores it
 *   5  Esc closes it and the focus is back in the terminal; F1 again re-opens it, F1 a third time closes it
 *   6  the header's "?" opens and closes it; Esc after opening from "?" puts the focus back on the button
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE is deleted; registry,
 * portraits, uploads and user data are temp folders; the repo is a temp git repo. Every host whose folder is inside the
 * probe's temp folder is killed at the end by pid (never by name).
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

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-shortcuts-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.SHORTCUTS_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

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
    if (k.startsWith('CLAUDE_CUSTOM_') && !['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE',
      'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'].includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
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

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started || !Number.isInteger(sel.pid)) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? { st, host: sel } : null;
  }, 45000);
}


async function main() {
  fs.mkdirSync(dev, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dev, stdio: 'pipe', windowsHide: true });
  if (!fs.existsSync(path.join(HARNESS_DIR, 'hook-helper.exe'))) {
    check('the install has .harness/hook-helper.exe (else the host has no status pipe)', false, 'run setup-worktree first');
    return;
  }
  const { ROWS, GROUPS } = require(path.join(ROOT, 'app', 'shortcut-table'));

  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  const state = () => view(app, 'shortcutsState');   // the driver hands back the page's JSON, parsed
  const doOp = (op, extra = {}) => view(app, 'shortcutsDo', { op, ...extra });
  const key = (k, modifiers = []) => command(app, { cmd: 'key', key: k, modifiers });
  const settle = () => sleep(350);

  // 1 -----------------------------------------------------------------------------
  let s = await state();
  check('1: the header has a "?" button and the sheet starts closed', s && s.btn && s.btn.text === '?' && s.open === false && s.hidden === true && s.expanded === 'false',
    JSON.stringify(s && { btn: s.btn, open: s.open }));
  check('1: its tooltip names F1', !!(s && /F1/.test(s.btn.title)), s && s.btn.title);

  // 2 -----------------------------------------------------------------------------
  await doOp('focusTerm');
  await settle();
  const before = await state();
  check('2 (setup): the keyboard is in the terminal before F1', before.inTerm === true, JSON.stringify({ inTerm: before.inTerm, active: before.activeId }));
  await key('F1');
  await settle();
  s = await state();
  check('2: F1 (a real key through main) opens the sheet', s.open === true && s.hidden === false && s.expanded === 'true', JSON.stringify({ open: s.open, hidden: s.hidden }));
  check('2: ...and the search box has the focus', s.activeId === 'shortcuts-search', s.activeId);

  // 3 -----------------------------------------------------------------------------
  check('3: a row for every table row', s.rows === ROWS.length, `${s.rows} of ${ROWS.length}`);
  check('3: the four groups, in order', JSON.stringify(s.groups) === JSON.stringify(GROUPS), JSON.stringify(s.groups));
  check('3: the keys the CLI owns are marked Claude Code', s.cli === ROWS.filter(r => r.owner === 'claude').length, String(s.cli));
  check('3: the card is inside the window and below the header', s.card.left >= 0 && s.card.right <= s.viewport.w && s.card.bottom <= s.viewport.h && s.card.top >= s.headerBottom,
    JSON.stringify({ card: s.card, headerBottom: s.headerBottom, viewport: s.viewport }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-sheet-open.png') });

  // 3b: the focus trap (PR #156): Tab cycles search -> close -> search, and the page under the header is inert
  await key('Tab'); await settle();
  s = await state();
  check('3b: Tab moves the focus to the sheet close button', s.activeId === 'shortcuts-close', s.activeId);
  await key('Tab'); await settle();
  s = await state();
  check('3b: ...and wraps back to the search box (never out into the page)', s.activeId === 'shortcuts-search', s.activeId);
  check('3b: the page under the header is inert while the sheet is open', s.bodyInert === true);

  // 4 -----------------------------------------------------------------------------
  await doOp('type', { text: 'ctrl+b' });
  s = await state();
  check('4: typing "ctrl+b" narrows the sheet to the panels row', s.rows >= 1 && s.rows < ROWS.length && s.groups.includes('Panels'), JSON.stringify({ rows: s.rows, groups: s.groups }));
  await doOp('type', { text: 'zzzzqq' });
  s = await state();
  check('4: a miss says so', s.rows === 0 && s.none === true);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-sheet-no-match.png') });
  await doOp('type', { text: '' });
  s = await state();
  check('4: clearing the search restores every row', s.rows === ROWS.length, String(s.rows));

  // 5 -----------------------------------------------------------------------------
  await key('Escape');
  await settle();
  s = await state();
  check('5: Esc closes the sheet', s.open === false && s.hidden === true && s.expanded === 'false', JSON.stringify({ open: s.open }));
  check('5: ...and the keyboard is back in the terminal', s.inTerm === true, JSON.stringify({ inTerm: s.inTerm, active: s.activeId }));
  await key('F1');
  await settle();
  s = await state();
  check('5: F1 opens it again (the search starts empty)', s.open === true && s.query === '' && s.rows === ROWS.length);
  await key('F1');
  await settle();
  s = await state();
  check('5: F1 a third time closes it (the same key toggles)', s.open === false);

  // 6 -----------------------------------------------------------------------------
  await doOp('focusButton');
  await doOp('clickButton');
  await settle();
  s = await state();
  check('6: clicking "?" opens the sheet', s.open === true && s.expanded === 'true');
  await doOp('clickButton');
  await settle();
  s = await state();
  check('6: clicking "?" again closes it (the sheet starts below the header, so the button stays reachable)', s.open === false);
  await doOp('focusButton');
  await doOp('clickButton');
  await settle();
  await key('Escape');
  await settle();
  s = await state();
  check('6: Esc after opening from "?" closes it and puts the focus back on the button', s.open === false && s.activeId === 'shortcuts-btn', JSON.stringify({ open: s.open, active: s.activeId }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '3-closed.png') });

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.SHORTCUTS_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
