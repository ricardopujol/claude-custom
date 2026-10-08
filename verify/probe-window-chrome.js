'use strict';
/**
 * PROBE: layout pass L2 (documentation/PLAN_LAYOUT_L2.md Task 9) in a REAL window with a REAL host.
 * (re-runnable)
 *
 *   node verify/probe-window-chrome.js        (exit 0 = every check held)
 *   CHROME_PROBE_SHOTS=<dir>                   also keep screenshots there
 *   CHROME_PROBE_FRAMED=1                      the control: setting off, the frame must measure
 *
 * MEASURED 2026-10-02 (Electron 33, Windows 11): frameless, window and content are both 1200x800;
 * all 10 checks pass. Control (framed): window 1200x800, content 1186x763, no buttons, drag "none".
 *
 * The unit tests pin the pieces; no unit test can see the window. This turns both settings on in
 * the install's chrome-global.json, opens a window, and checks:
 *
 *   1  #28: the window has no OS frame (content bounds == window bounds), the strip is the drag
 *      region, and it draws its own minimise and close
 *   2  #27: a status document pushed through the REAL relay (host/status-relay.js, the command the
 *      CLI runs) prints NOTHING (so the CLI drops its row) and reaches the host, and the tab's
 *      header shows its cost / lines / time in warpaint's formats
 *   3  #27 live: turning the setting off in the file (as another window would) hides the header
 *      fields within a poll, and the relay prints the user's row again -- no restart
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE
 * is deleted; registry, portraits, uploads and user data are temp folders; the repo is a temp git
 * repo. The install's chrome-global.json is moved aside for the run and put back. Every host whose
 * folder is inside the probe's temp folder is killed at the end (a host outlives its window).
 */

const { spawn, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const CHROME_FILE = path.join(HARNESS_DIR, 'state', 'chrome-global.json');
const RELAY = path.join(ROOT, 'host', 'status-relay.js');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

// CHROME_PROBE_FRAMED=1: the control run -- the setting off, so check 1 is shown to measure a frame.
const FRAMED = process.env.CHROME_PROBE_FRAMED === '1';
const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-chrome-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.CHROME_PROBE_SHOTS || path.join(tmp, 'shots');
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

// --- the install's own setting, set aside and put back ---------------------------
const CHROME_BACKUP = `${CHROME_FILE}.chrome-probe-backup`;
let movedAside = false;
function setChrome(value) {
  fs.mkdirSync(path.dirname(CHROME_FILE), { recursive: true });
  const t = `${CHROME_FILE}.tmp-probe`;
  fs.writeFileSync(t, JSON.stringify(value));
  fs.renameSync(t, CHROME_FILE);
}
function setAsideChrome() {
  if (fs.existsSync(CHROME_FILE)) { fs.renameSync(CHROME_FILE, CHROME_BACKUP); movedAside = true; }
}
function restoreChrome() {
  try { fs.rmSync(CHROME_FILE, { force: true }); } catch { /* gone */ }
  if (movedAside) {
    try { fs.renameSync(CHROME_BACKUP, CHROME_FILE); movedAside = false; } catch (e) { console.log(`(could not restore ${CHROME_FILE}: ${e.message})`); }
  }
}

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

const seenPids = new Set();
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
  for (const id of hostsOfThisRun()) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreChrome);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started || !Number.isInteger(sel.pid)) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? { st, host: sel } : null;
  }, 45000);
}

// The command the CLI runs as its statusLine, with the user's own command chained after it.
function runRelay(hostPid, doc) {
  return new Promise((resolve) => {
    const user = `"${process.execPath}" -e "process.stdout.write('USER-ROW')"`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [RELAY, '--pipe', `claude-custom-${hostPid}`,
      '--then', Buffer.from(user, 'utf8').toString('base64'), '--quiet-when', CHROME_FILE], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
    child.stdin.end(JSON.stringify(doc));
  });
}

const DOC = {
  model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
  cost: { total_cost_usd: 1.234, total_duration_ms: 3_900_000, total_api_duration_ms: 100000,
    total_lines_added: 10, total_lines_removed: 2 },
  exceeds_200k_tokens: false,
};

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dev, stdio: 'pipe', windowsHide: true });
  if (!fs.existsSync(path.join(HARNESS_DIR, 'hook-helper.exe'))) {
    check('the install has .harness/hook-helper.exe (else the host has no status pipe)', false, 'run setup-worktree first');
    return;
  }
  setAsideChrome();
  setChrome({ statusInHeader: true, framelessWindow: !FRAMED });

  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  const wf = ready.st.windowFrame || {};
  const b = wf.bounds || {};
  const c = wf.content || {};
  if (FRAMED) {
    // 0: the control. Check 1's "content fills the window" means something only if a framed
    // window measures differently.
    check('0 (control): a framed window\'s content is smaller than the window', c.height < b.height,
      `window ${b.width}x${b.height}, content ${c.width}x${c.height}`);
    check('0 (control): ...and the strip draws no window buttons and isn\'t a drag region',
      wf.dom && !wf.dom.frameless && !wf.dom.min && !wf.dom.close && wf.dom.drag !== 'drag', JSON.stringify(wf.dom));
    await command(app, { cmd: 'quit' });
    return;
  }

  // 1 -----------------------------------------------------------------------------
  check('1: no OS frame: the content fills the whole window', b.width === c.width && b.height === c.height,
    `window ${b.width}x${b.height}, content ${c.width}x${c.height}`);
  check('1: the strip is marked frameless and is the drag region', wf.dom && wf.dom.frameless && wf.dom.drag === 'drag',
    JSON.stringify(wf.dom));
  check('1: the strip draws its own minimise and close', wf.dom && wf.dom.min && wf.dom.close, JSON.stringify(wf.dom));
  check('1: still no menu bar', ready.st.noMenuBar === true);

  // 2 -----------------------------------------------------------------------------
  const before = (ready.st.viewDom || {}).statusFields;
  check('2: before any status document the header fields are hidden (unknown, never "$0")',
    before && before.hidden === true, JSON.stringify(before));
  const quiet = await runRelay(ready.host.pid, DOC);
  check('2: with the setting on, the relay prints nothing (so the CLI drops its row)', quiet.out === '' && quiet.code === 0,
    JSON.stringify(quiet));
  const shown = await waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    const sf = st && st.viewDom && st.viewDom.statusFields;
    return sf && !sf.hidden ? sf : null;
  }, 10000);
  check('2: ...and the document still reached the host: the header shows cost, lines and time',
    !!shown && shown.text === '$1.23  │  +10/-2  │  1h05', JSON.stringify(shown));
  // Shown in the DOM is not shown on screen: it must have width and sit inside the window.
  check('2: ...on screen: it has width and sits inside the window', !!shown && shown.display !== 'none'
    && shown.rect && shown.rect.width > 0 && shown.rect.right <= shown.viewport, JSON.stringify(shown));
  // Miguel L2 Y1. Absolute, not before/after: the same document also fills the model chip, which
  // widens the header on its own. MEASURED 2026-10-02 at 1200px, where the header is over-full
  // before L2 (usage + quota text): fields alone shrinkable -> 0px of 110px; hints first ->
  // hints clip to 0, fields 24px (ellipsis), focus button 1162 of 1200. A wider window shows them whole.
  check('2 (Miguel Y1): in a crowded header the controls stay on screen; the fields clip, never push',
    !!shown && shown.focusRight <= shown.viewport && shown.rect.width <= shown.scrollWidth,
    `fields ${shown && shown.rect && shown.rect.width}px of ${shown && shown.scrollWidth}px, focus button right ${shown && shown.focusRight} of ${shown && shown.viewport}`);
  await sleep(500);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-frameless-status.png') });

  // 3 -----------------------------------------------------------------------------
  setChrome({ statusInHeader: false, framelessWindow: true });
  const hidden = await waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    const sf = st && st.viewDom && st.viewDom.statusFields;
    return sf && sf.hidden ? sf : null;
  }, 8000);
  check('3: turned off in the file (as another window would), the header fields hide within a poll', !!hidden);
  const loud = await runRelay(ready.host.pid, DOC);
  check('3: ...and the relay prints the user\'s row again, with no restart', loud.out === 'USER-ROW', JSON.stringify(loud));

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreChrome();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.CHROME_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
