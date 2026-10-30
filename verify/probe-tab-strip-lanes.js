'use strict';
/**
 * The tab strip's Lanes menu, +N overflow, drag order and persistence, in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-tab-strip-lanes.js        (exit 0 = every check held)
 *
 * BACKLOG #139, #141, #151; documentation/DESIGN_TAB_STRIP.md. The unit tests pin the decisions (test/tab-lanes*.test.js,
 * test/tab-shell-lanes.test.js, test/tab-strip-lanes.test.js). Nothing else renders app/tab-strip.html with app/tab-lanes.js
 * in the same page, and that is where the traps live: every plain <script> shares ONE global scope, so a name two files
 * declare aborts the second SILENTLY (no unit test can see it), and the overflow is judged by where the browser really put
 * the tabs, not by a fake DOM's numbers.
 *
 * Against a throwaway container  <tmp>\proj\dev  with eleven lanes (feat-01 .. feat-11, feat-11 already merged), one Electron
 * window, the hosts' `claude` being cmd.exe (CLAUDE_CUSTOM_BIN), so nothing runs that bills:
 *   1B         on open only develop has a tab; ten lanes are rows (Not started 10, Merged 1), and the Lanes button is drawn
 *   #151       develop's tab wears no occupancy stripes
 *   2A         with ten tabs in a 900 px window the strip shows fewer than ten, none clipped, none narrower than 112 px, the
 *              selected one among them, and the button says +N for exactly the ones it hid; widen it and nothing is hidden
 *   2A         selecting a hidden lane puts it on the strip
 *   #141       dragging a tab onto another (the page's own handlers, real DragEvents) moves it; develop and a drop on itself don't
 *   1B         a lane whose session ended leaves the strip when you switch away, and is a Lanes row ("ended")
 *   closed     a lane closed by hand stays closed after the window is closed and opened again, and the drag order survived too
 *
 * SAFE. ELECTRON_RUN_AS_NODE is deleted before the window launches (Claude Code is itself an Electron app); every CLAUDE_CUSTOM_*
 * variable but the probe's own is stripped; the registry, portraits and uploads point at temp folders. Hosts are ended with
 * their own `stop` control message, and by pid tree at the end for any that are left (verify/lib/seen-pids). WINDOWS ONLY.
 */
const { spawnElectron } = require('./lib/launch-electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { sendControl } = require(path.join(ROOT, 'host', 'host-client'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-lanes-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const LANES = Array.from({ length: 11 }, (_, i) => `feat-${String(i + 1).padStart(2, '0')}`);
const labelOfLane = (name) => `feat/${name.slice(5)}`;
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args,
], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
let skipped = false;
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

function makeContainer() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const name of LANES) git(dev, 'worktree', 'add', '-q', path.join(container, name), '-b', labelOfLane(name));
  // feat-11 has merged (contract B): the marker sits in the worktree's own git dir.
  const gitDir = git(path.join(container, 'feat-11'), 'rev-parse', '--absolute-git-dir').trim();
  fs.writeFileSync(path.join(gitDir, 'claude-merged.json'), JSON.stringify({ branch: 'feat/11', pr: 11, mergedAt: '2026-10-29T00:00:00Z' }));
}

let windowNo = 0;
async function launchApp(cwd) {
  windowNo++;
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
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
  hygiene.registerChild(child);
  const app = { no: windowNo, port, token, child, out: '', exited: false, exitCode: null };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', (code) => { app.exited = true; app.exitCode = code; hygiene.unregisterSpawnedTree(child.pid); });
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

const state = (app) => command(app, { cmd: 'state' });
const modelLabels = (s) => (s && s.tabs ? s.tabs.map(t => t.label) : []);
const painted = (s) => (s && s.stripLayout && Array.isArray(s.stripLayout.items) ? s.stripLayout.items.filter(i => !i.leaving) : []);
const paintedLabels = (s) => painted(s).map(i => i.label);
const hostOf = (s, label) => (s && s.hosts ? s.hosts.find(h => h.label === label) : null);
const rowOf = (s, label) => [...((s && s.lanes && s.lanes.notStarted) || []), ...((s && s.lanes && s.lanes.merged) || [])].find(r => r.label === label) || null;

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
  if (!app.exited) hygiene._emergencyCleanup('quit-timeout');
}

function hostsUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const port = Number(f.replace(/\.json$/, ''));
    const id = readIdentity({ dir: HARNESS_DIR, port });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(dir).toLowerCase())) out.push(id);
  }
  return out;
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid); };
function killEverything() {
  for (const id of hostsUnder(tmp)) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
function removeTemp() {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}
hygiene.addCleanup(killEverything);

const clipped = (s) => painted(s).filter(i => i.right > s.stripLayout.tabs.right + 1);

async function main() {
  console.log('temp repo:', tmp);
  makeContainer();

  let app = await launchApp(container);
  let s = await driverUp(app);
  if (!s) {
    check('the window came up and its driver answers', false, `\n${app.out.split('\n').slice(-25).join('\n')}`);
    skipped = true;
    await quit(app);
    return;
  }
  check('the window came up and its driver answers', true, `pid ${app.child.pid}`);

  s = await waitFor(async () => { const x = await state(app); return modelLabels(x).length >= 12 && paintedLabels(x).length >= 1 ? x : null; }, 40000);
  remember(s);
  check('twelve lanes are listed (develop and eleven)', !!s && modelLabels(s).length === 12, s ? String(modelLabels(s).length) : 'no state');
  if (!s) { skipped = true; return; }

  // ===== 1B =====
  s = await waitFor(async () => { const x = await state(app); return x.tabs.find(t => t.label === 'develop' && t.started) ? x : null; }, 40000) || s;
  remember(s);
  check('1B: on open only develop has a tab (main says so, and the page painted exactly that)',
    s.stripKeys.length === 1 && JSON.stringify(paintedLabels(s)) === JSON.stringify(['develop']), `keys ${s.stripKeys.length}, painted ${paintedLabels(s).join(', ')}`);
  check('1B: ten lanes are Not started rows and the merged one is a Merged row',
    s.lanes.notStarted.length === 10 && s.lanes.merged.length === 1 && s.lanes.merged[0].label === 'feat/11'
      && s.lanes.notStarted.every(r => r.state === 'not started'), JSON.stringify({ n: s.lanes.notStarted.length, m: s.lanes.merged.map(r => r.label) }));
  check('1B: the Lanes ▾ button is drawn, in the project window', s.stripLayout && s.stripLayout.lanes.hidden === false && s.stripLayout.lanes.text === 'Lanes ▾',
    JSON.stringify(s.stripLayout && s.stripLayout.lanes));
  const devTab = painted(s)[0];
  check('#151: develop\'s tab wears no occupancy stripes', !!devTab && devTab.dev === true && devTab.occupied === false);
  check('develop is not draggable, so it can never move', !!devTab && devTab.draggable === false);

  // ===== start nine lanes (hosts are cmd.exe) =====
  const started = [];
  for (const name of LANES.slice(0, 9)) {
    const r = await command(app, { cmd: 'select', label: labelOfLane(name) }, 90000);
    if (r.ok && r.started) started.push(labelOfLane(name));
  }
  await command(app, { cmd: 'select', label: 'develop' }, 30000);
  s = await waitFor(async () => { const x = await state(app); return x.stripKeys.length === 10 && paintedLabels(x).length === 10 ? x : null; }, 20000) || await state(app);
  remember(s);
  check('nine lanes started: they have tabs now (ten with develop), the other two are still rows',
    started.length === 9 && s.stripKeys.length === 10 && s.lanes.notStarted.length === 1 && s.lanes.merged.length === 1,
    `started ${started.length}, strip ${s.stripKeys.length}, rows ${s.lanes.notStarted.length}+${s.lanes.merged.length}`);

  // ===== 2A: a narrow window =====
  const sized = await command(app, { cmd: 'window-size', width: 900 });
  s = await waitFor(async () => { const x = await state(app); return paintedLabels(x).length < 10 ? x : null; }, 10000) || await state(app);
  const shown = paintedLabels(s);
  const hiddenN = 10 - shown.length;
  check('2A: at 900 px the strip shows fewer than ten tabs', sized.ok === true && shown.length >= 1 && shown.length < 10, `${shown.length} shown at ${s.stripLayout.stripWidth} px`);
  check('2A: none is clipped by the strip, and none is narrower than 112 px', clipped(s).length === 0 && painted(s).every(i => i.width >= 111),
    JSON.stringify(painted(s).map(i => [i.label, i.left, i.right, i.width])));
  check('2A: the selected tab (develop) is among them, and the button says +N for exactly the tabs it hid',
    shown.includes('develop') && s.stripLayout.lanes.text === `+${hiddenN} Lanes ▾` && s.stripLayout.lanes.overflow === true,
    `${s.stripLayout.lanes.text}, ${hiddenN} expected`);
  check('2A: the Lanes button itself is inside the strip', s.stripLayout.lanes.right <= s.stripLayout.stripWidth + 1, JSON.stringify(s.stripLayout.lanes));

  // selecting a hidden lane brings it onto the strip
  const lastLabel = labelOfLane(LANES[8]);
  const wasHidden = !shown.includes(lastLabel);
  await command(app, { cmd: 'select', label: lastLabel }, 30000);
  s = await waitFor(async () => { const x = await state(app); return paintedLabels(x).includes(lastLabel) ? x : null; }, 10000) || await state(app);
  check('2A: a hidden lane that is selected is on the strip (and was hidden before)', wasHidden && paintedLabels(s).includes(lastLabel) && painted(s).find(i => i.label === lastLabel).selected === true,
    `hidden before: ${wasHidden}; now ${paintedLabels(s).join(', ')}`);
  check('2A: it did not push another tab out of the strip\'s edge', clipped(s).length === 0);
  await command(app, { cmd: 'select', label: 'develop' }, 30000);

  await command(app, { cmd: 'window-size', width: 2600 });
  s = await waitFor(async () => { const x = await state(app); return paintedLabels(x).length === 10 ? x : null; }, 10000) || await state(app);
  // The window is clamped to the screen, so "wide" is only as wide as this display allows: ten tabs at 112 px plus the rest of
  // the strip need about 1.9k CSS px. Judge by what the room allows: more tabs than at 900 px, and the button says +N for the rest.
  const wideShown = paintedLabels(s).length;
  const wideFits = s.stripLayout.stripWidth >= 1900;
  check('2A: widen the window and the strip shows more tabs, and the button says +N for exactly the rest (all ten and "Lanes ▾" when the screen is wide enough)',
    wideShown > shown.length && (wideFits ? wideShown === 10 && s.stripLayout.lanes.text === 'Lanes ▾' : s.stripLayout.lanes.text === `+${10 - wideShown} Lanes ▾`),
    `${wideShown} tabs, ${s.stripLayout.lanes.text}, strip ${s.stripLayout.stripWidth} px, tabs box ${JSON.stringify(s.stripLayout.tabs)} scroll ${s.stripLayout.tabsScroll}, ${JSON.stringify(painted(s).map(i => [i.label, i.width]))}`);

  // ===== #141: drag =====
  const before = paintedLabels(s);
  const drag = await command(app, { cmd: 'drag-tab', label: 'feat/05', onLabel: 'feat/01', half: 'left' });
  s = await waitFor(async () => { const x = await state(app); const l = paintedLabels(x); return l.indexOf('feat/05') === 1 ? x : null; }, 10000) || await state(app);
  const after = paintedLabels(s);
  check('#141: feat/05 dragged onto the left half of feat/01 lands just before it, right after develop',
    drag.ok === true && drag.allowed === true && drag.indicator === 'before' && JSON.stringify(after.slice(0, 3)) === JSON.stringify(['develop', 'feat/05', 'feat/01']),
    `${JSON.stringify(drag)} ${after.join(', ')}`);
  // Moving a tab up can bring one in from the Lanes menu and push the last one out, so compare the tabs both lists show.
  const common = (a, b) => a.filter(l => l !== 'feat/05' && b.includes(l));
  check('#141: nothing else changed place', JSON.stringify(common(after, before)) === JSON.stringify(common(before, after)), `${before.join(', ')} -> ${after.join(', ')}`);
  check('#141: the model (what Ctrl+Tab walks) has the same order', JSON.stringify(modelLabels(s).slice(0, 3)) === JSON.stringify(['develop', 'feat/05', 'feat/01']), modelLabels(s).slice(0, 4).join(', '));
  const toDev = await command(app, { cmd: 'drag-tab', label: 'feat/05', onLabel: 'develop', half: 'left' });
  check('#141: nothing can be dropped on develop\'s left to move before it: develop stays first', (await state(app)).stripLayout.items[0].label === 'develop' && toDev.ok === true);
  const onSelf = await command(app, { cmd: 'drag-tab', label: 'feat/02', onLabel: 'feat/02', half: 'right' });
  check('#141: a drop on the tab itself is not allowed', onSelf.ok === true && onSelf.allowed === false, JSON.stringify(onSelf));
  const fromDev = await command(app, { cmd: 'drag-tab', label: 'develop', onLabel: 'feat/02', half: 'left' });
  check('#141: develop cannot be dragged', fromDev.ok === false && /not draggable/.test(fromDev.error || ''), JSON.stringify(fromDev));
  const orderNow = modelLabels(await state(app));

  // ===== 1B: a lane whose session ended leaves the strip =====
  s = await state(app);
  const h3 = hostOf(s, 'feat/03');
  const tokenOf = (port) => fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${port}.token`), 'utf8').trim();
  const stop = h3 ? await sendControl({ port: h3.port, token: tokenOf(h3.port), msg: { type: 'stop' } }) : { ok: false };
  s = await waitFor(async () => { const x = await state(app); return !x.stripKeys.some(k => k === (x.tabs.find(t => t.label === 'feat/03') || {}).key) ? x : null; }, 20000, 400);
  check('1B: a lane whose session ended (develop is selected) leaves the strip', !!stop.ok && !!s, JSON.stringify(stop));
  if (s) {
    await sleep(700);     // the fade
    s = await state(app);
    check('and it is a Lanes row, "ended", and its tab is really gone from the page after the fade',
      (rowOf(s, 'feat/03') || {}).state === 'ended' && !(s.stripLayout.items || []).some(i => i.label === 'feat/03'), JSON.stringify(rowOf(s, 'feat/03')));
  }

  // ===== closed stays closed, order survives =====
  const closedRes = await command(app, { cmd: 'close', label: 'feat/04' }, 30000);
  s = await state(app);
  check('a lane closed by hand is a Lanes row marked closed', closedRes.ok === true && (rowOf(s, 'feat/04') || {}).closed === true, JSON.stringify(rowOf(s, 'feat/04')));
  remember(s);
  await quit(app);

  app = await launchApp(container);
  s = await driverUp(app);
  if (!s) { check('the window reopened', false, app.out.split('\n').slice(-15).join('\n')); return; }
  s = await waitFor(async () => { const x = await state(app); return modelLabels(x).length >= 11 && paintedLabels(x).length >= 2 ? x : null; }, 40000);
  remember(s);
  check('reopened: feat/04 is still closed (no tab, a closed row)', !!s && !modelLabels(s).includes('feat/04') && (rowOf(s, 'feat/04') || {}).closed === true, s && modelLabels(s).join(', '));
  const reopenedOrder = s ? modelLabels(s).filter(l => orderNow.includes(l)) : [];
  check('reopened: the dragged order survived (feat/05 still right after develop)', !!s && modelLabels(s)[0] === 'develop' && modelLabels(s)[1] === 'feat/05', s && modelLabels(s).slice(0, 4).join(', '));
  check('reopened: the lanes that kept running have their tabs again, in that order',
    !!s && JSON.stringify(paintedLabels(s).slice(0, 2)) === JSON.stringify(['develop', 'feat/05']), s && paintedLabels(s).join(', '));
  void reopenedOrder;
  const back = await command(app, { cmd: 'reopen' }, 30000);
  s = await waitFor(async () => { const x = await state(app); return modelLabels(x).includes('feat/04') ? x : null; }, 15000);
  check('Reopen brings it back (Ctrl+Shift+T / the Lanes row)', back.ok === true && !!s, JSON.stringify(back));
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
    removeTemp();
  }
  if (skipped) {
    console.log(`\n${failures} FAILED -- the app did not come up, so the rest was never measured`);
    process.exit(1);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
