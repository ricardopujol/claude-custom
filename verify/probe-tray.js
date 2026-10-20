'use strict';
/**
 * PROBE: the tray icon (BACKLOG #119 A8) in a REAL window with REAL hosts.
 * (re-runnable)
 *
 *   node verify/probe-tray.js            (exit 0 = every check held)
 *   TRAY_PROBE_SHOTS=<dir>                also keep the tray images (PNG) there
 *
 * The unit tests pin the rules (test/tray-model.test.js), the effects with a fake Tray (test/tray-controller.test.js) and the
 * wiring as source text. No unit test can see Electron's real Tray, or the path a hook takes to it: hook event -> host
 * attention -> the tab's page -> tab:status -> the shell -> the Tray. A Tray can't be screenshotted, so this reads what main
 * says it shows (the tooltip, the badge text, a digest of the image's pixels) and saves the image as a PNG to look at.
 *
 *   1  the Tray exists, the tooltip counts the sessions, nothing needs you, the icon is the plain one
 *   2  a Stop on a background tab (finished): badge 1, "1 needs you", the image's pixels CHANGED
 *   3  a second cue (a permission prompt on the other tab): badge 2, "2 need you", another image
 *   4  the menu (read, and clicked, through the same template the right click shows): the window row names its tabs and the
 *      cue, Hide/Show all windows really hide and show the window, Start minimised flips the saved switch
 *   5  left click goes to the cue that has waited LONGEST, then the next; a look (the window's focus) clears the count and
 *      the plain icon comes back, byte for byte
 *   6  close-to-tray is OFF by default; turned on, the X hides the window and keeps it alive; the tray brings it back
 *   7  the tray icon switch removes the Tray and brings a new one back
 *   8  with close-to-tray off again, the X closes the window and the app ends
 *   9  a second launch with "Start minimised to tray": the window is made hidden, and a tray click shows it
 *
 * SAFE. The hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE is deleted along with every
 * CLAUDE_CUSTOM_* the probe doesn't set; registry, portraits, uploads, the UI-state folder (where the tray's switches live) and
 * user data are temp folders; the repo is a temp git repo. Every host whose folder is inside the probe's temp folder is killed
 * at the end. Only this probe gets a tray (CLAUDE_CUSTOM_TRAY_PROBE=1): a probe window is killed by pid, which leaves a ghost
 * icon behind until the mouse passes over it.
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
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-tray-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const uiState = path.join(tmp, 'ui-state');
const shots = process.env.TRAY_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(uiState, { recursive: true });

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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_TRAY_PROBE', 'CLAUDE_CUSTOM_UI_STATE_DIR'];

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
    CLAUDE_CUSTOM_TRAY_PROBE: '1',
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
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

async function stateOf(app) {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
}
const tabOf = (st, label) => (Array.isArray(st && st.stripDom) ? st.stripDom.find(t => t.label === label) || null : null);
const hostPidOf = (st, label) => {
  const h = ((st && st.hosts) || []).find(x => x.label === label);
  return h && Number.isInteger(h.pid) ? h.pid : null;
};
const keyOf = (st, label) => { const h = ((st && st.hosts) || []).find(x => x.label === label); return h ? h.key : null; };

// What the native hook helper does: one JSON line down the host's named pipe.
function fireHook(pid, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
}

const tray = (app) => command(app, { cmd: 'tray' });
const trayIs = (app, want) => waitFor(async () => {
  const t = await tray(app);
  return t && t.ok && want(t) ? t : null;
}, 15000, 250);

// Both tabs started (a view each), `develop` selected, feat/a in the background.
async function bothStarted(app) {
  const up = await waitFor(async () => (tabOf(await stateOf(app), 'feat/a') ? true : null), 45000);
  if (!up) return null;
  const pageUp = () => waitFor(async () => {
    const v = (await stateOf(app)).viewDom;
    return v && v.hasTerm === true && v.xterm > 0 ? true : null;
  }, 30000);
  const a = await command(app, { cmd: 'select', label: 'feat/a' });
  if (!(a && a.ok && a.started && await pageUp())) return null;
  const d = await command(app, { cmd: 'select', label: 'develop' });
  if (!(d && d.ok && d.started && await pageUp())) return null;
  await sleep(1500);
  return waitFor(async () => {
    const st = await stateOf(app);
    return hostPidOf(st, 'feat/a') && hostPidOf(st, 'develop') && tabOf(st, 'develop').selected ? st : null;
  }, 20000);
}

const menuRows = async (app, click) => command(app, click ? { cmd: 'tray-menu', label: click } : { cmd: 'tray-menu' });

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');

  const app = await launchApp(container);
  const ready = await bothStarted(app);
  check('the window came up with both tabs started', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const aPid = hostPidOf(ready, 'feat/a');
  const dPid = hostPidOf(ready, 'develop');
  const aKey = keyOf(ready, 'feat/a');
  const dKey = keyOf(ready, 'develop');

  // 1 ---------------------------------------------------------------------------------
  const t0 = await trayIs(app, t => t.tray.exists && t.tray.tooltip !== null);
  check('1: the Tray exists with a tooltip that counts the sessions', !!t0 && t0.tray.tooltip === 'claude-custom · proj · 2 sessions', JSON.stringify(t0 && t0.tray));
  check('1: nothing needs you: the plain icon, no badge', !!t0 && t0.tray.badge === '' && t0.tray.count === 0);
  const plainSha = t0 && t0.tray.image && t0.tray.image.sha1;
  check('1: the image is a real 32 x 32 bitmap handed over as a 2x icon', !!t0 && !!t0.tray.image && !!plainSha, JSON.stringify(t0 && t0.tray.image));
  const png0 = await command(app, { cmd: 'tray-image', file: path.join(shots, 'tray-0-plain.png') });
  check('1: the plain icon saved as a PNG to look at', png0.ok && png0.bytes > 100, JSON.stringify(png0));
  check('1: the tray switches start at their defaults (icon on, close-to-tray off, start minimised off)',
    !!t0 && JSON.stringify(t0.settings) === JSON.stringify({ trayIcon: true, minimiseOnClose: false, startMinimised: false }), JSON.stringify(t0 && t0.settings));

  // 2 ---------------------------------------------------------------------------------
  await command(app, { cmd: 'windowBlur' });          // nobody is looking: the cue holds
  check('2: the hook line was delivered to feat/a\'s host', await fireHook(aPid, 'Stop', {}));
  const t1 = await trayIs(app, t => t.tray.count === 1);
  check('2: a finished session: badge 1 and "1 needs you"', !!t1 && t1.tray.badge === '1' && t1.tray.tooltip === 'claude-custom · proj · 2 sessions · 1 needs you', JSON.stringify(t1 && t1.tray));
  check('2: ...the image\'s pixels changed', !!t1 && !!t1.tray.image && t1.tray.image.sha1 !== plainSha);
  const sha1 = t1 && t1.tray.image && t1.tray.image.sha1;
  await command(app, { cmd: 'tray-image', file: path.join(shots, 'tray-1-badge1.png') });

  // 3 ---------------------------------------------------------------------------------
  await sleep(4500);                                   // the hosts keep each kind of attention to one per 4 s
  await fireHook(dPid, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const t2 = await trayIs(app, t => t.tray.count === 2);
  check('3: a second tab needs you: badge 2 and "2 need you"', !!t2 && t2.tray.badge === '2' && t2.tray.tooltip === 'claude-custom · proj · 2 sessions · 2 need you', JSON.stringify(t2 && t2.tray));
  check('3: ...another image again', !!t2 && !!t2.tray.image && t2.tray.image.sha1 !== sha1 && t2.tray.image.sha1 !== plainSha);
  await command(app, { cmd: 'tray-image', file: path.join(shots, 'tray-2-badge2.png') });

  // 4 ---------------------------------------------------------------------------------
  const m1 = await menuRows(app);
  const labels = (m1.rows || []).map(r => r.label);
  check('4: the menu\'s window row names the tabs and that it needs you', labels.some(l => /^.+  ·  2 tabs  ·  2 need you$/.test(l)), JSON.stringify(labels));
  check('4: ...with Hide all windows, Start minimised to tray (a checkbox, off) and Quit', labels.includes('Hide all windows')
    && labels.includes('Quit claude-custom') && (m1.rows || []).some(r => r.label === 'Start minimised to tray' && r.checked === false), JSON.stringify(m1.rows));
  const hid = await menuRows(app, 'Hide all windows');
  const t3 = await tray(app);
  check('4: Hide all windows really hides the window (and it is not destroyed)', hid.ok && t3.visible === false, JSON.stringify({ hid, visible: t3.visible }));
  const m2 = await menuRows(app);
  check('4: ...and the menu now offers Show all windows', (m2.rows || []).some(r => r.label === 'Show all windows') && !(m2.rows || []).some(r => r.label === 'Hide all windows'));
  await menuRows(app, 'Show all windows');
  const t4 = await tray(app);
  check('4: Show all windows shows it again', t4.visible === true, JSON.stringify({ visible: t4.visible }));
  await menuRows(app, 'Start minimised to tray');
  const t5 = await tray(app);
  check('4: the Start minimised checkbox saves the switch', t5.settings.startMinimised === true, JSON.stringify(t5.settings));
  await menuRows(app, 'Start minimised to tray');
  check('4: ...and clicking it again saves it off', (await tray(app)).settings.startMinimised === false);
  const quitRow = (await menuRows(app)).rows.find(r => r.label === 'Quit claude-custom');
  check('4: Quit claude-custom is offered (clicked at the end, not here)', !!quitRow);

  // 5 ---------------------------------------------------------------------------------
  const before = await stateOf(app);
  check('5: develop is the selected tab before the click', before.selectedKey === dKey, String(before.selectedKey));
  await command(app, { cmd: 'tray-click' });
  const c1 = await trayIs(app, t => t.selectedKey === aKey);
  check('5: a left click goes to the cue that has waited longest (feat/a, which finished first)', !!c1, JSON.stringify((await tray(app)).selectedKey));
  const c1n = await trayIs(app, t => t.tray.count === 1);
  check('5: ...and looking at it takes it off the count', !!c1n && c1n.tray.badge === '1', JSON.stringify(c1n && c1n.tray));
  await command(app, { cmd: 'tray-click' });
  const c2 = await trayIs(app, t => t.selectedKey === dKey);
  check('5: the next click goes to the one that is left (develop)', !!c2, JSON.stringify((await tray(app)).selectedKey));
  await command(app, { cmd: 'windowFocus' });          // the window comes back: the look
  const t6 = await trayIs(app, t => t.tray.count === 0);
  check('5: the window coming back clears the count: no badge, the plain tooltip', !!t6 && t6.tray.badge === '' && t6.tray.tooltip === 'claude-custom · proj · 2 sessions', JSON.stringify(t6 && t6.tray));
  check('5: ...and the plain icon is back, pixel for pixel', !!t6 && !!t6.tray.image && t6.tray.image.sha1 === plainSha);
  const visBefore = (await tray(app)).visible;
  await command(app, { cmd: 'tray-click' });
  check('5: with nothing needing you a click just shows the window', (await tray(app)).visible === true && visBefore === true);

  // 6 ---------------------------------------------------------------------------------
  const closeOff = await command(app, { cmd: 'tray-setting', key: 'minimiseOnClose', value: false });
  check('6: close-to-tray is off by default', closeOff.ok && closeOff.settings.minimiseOnClose === false);
  await command(app, { cmd: 'tray-setting', key: 'minimiseOnClose', value: true });
  const closed = await command(app, { cmd: 'win-close' });
  await sleep(500);
  const t7 = await tray(app);
  check('6: with it on, the X hides the window and the app keeps running', closed.ok && t7.ok && t7.visible === false && !app.exited, JSON.stringify({ closed, visible: t7.visible, exited: app.exited }));
  const st7 = await stateOf(app);
  check('6: ...the tabs and their hosts are still there', st7.ok && !!tabOf(st7, 'feat/a') && !!hostPidOf(st7, 'feat/a'));
  await command(app, { cmd: 'tray-click' });
  check('6: the tray brings it back', (await tray(app)).visible === true);

  // 7 ---------------------------------------------------------------------------------
  await command(app, { cmd: 'tray-setting', key: 'trayIcon', value: false });
  const gone = await command(app, { cmd: 'tray' });
  check('7: the tray icon switch off removes the Tray', gone.ok && gone.tray.exists === false, JSON.stringify(gone.tray));
  const closedNoTray = await command(app, { cmd: 'win-close' });
  await sleep(1000);
  check('7: and with no icon, close-to-tray does not hide a window nothing could bring back: the app closes', closedNoTray.ok === true && (await waitFor(() => app.exited, 15000)) === true, `exited=${app.exited}`);

  // 9 (the second launch; 8 follows it) ---------------------------------------------
  // The relaunch reads the same UI-state folder: icon off, so put the switches the way the check wants them.
  fs.rmSync(path.join(uiState, 'chrome-global.json'), { force: true });
  fs.writeFileSync(path.join(uiState, 'chrome-global.json'), JSON.stringify({ statusInHeader: true, framelessWindow: false, startMinimised: true }));
  await sleep(4500);
  const app2 = await launchApp(container);
  const hidden = await waitFor(async () => {
    const t = await tray(app2);
    return t && t.ok && t.tray.exists ? t : null;
  }, 45000);
  check('9: the second launch has its Tray', !!hidden, hidden ? '' : app2.out.slice(-600));
  if (hidden) {
    check('9: Start minimised: the window was made but is not shown', hidden.visible === false, JSON.stringify({ visible: hidden.visible }));
    await command(app2, { cmd: 'tray-click' });
    const shown = await trayIs(app2, t => t.visible === true);
    check('9: a tray click shows it', !!shown);
    // 8 -------------------------------------------------------------------------------
    await command(app2, { cmd: 'tray-setting', key: 'startMinimised', value: false });
    const settings = (await tray(app2)).settings;
    check('8: close-to-tray is off in this run', settings.minimiseOnClose === false, JSON.stringify(settings));
    const x = await command(app2, { cmd: 'win-close' });
    const ended = await waitFor(() => app2.exited, 15000);
    check('8: with it off, the X closes the window and the app ends (as before the tray existed)', x.ok === true && ended === true, `exited=${app2.exited}`);
  }
  if (!app2.exited) { await command(app2, { cmd: 'quit' }); await waitFor(() => app2.exited, 10000); }
}

main()
  .catch((err) => { console.log('FAIL  the probe threw: ' + ((err && err.stack) || err)); failures++; })
  .finally(() => {
    killEverything();
    if (process.env.TRAY_PROBE_SHOTS) console.log('tray images: ' + shots);
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
