'use strict';
/**
 * PROBE: a merged tab closes by itself (BACKLOG #139) and a closed develop comes back in one click (BACKLOG #160), in a REAL
 * window with REAL hosts, and the pictures Ricardo looks at before the merge.  (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-develop-merged.js        (exit 0 = every check held)
 *   DEVMERGED_PROBE_SHOTS=<dir>   where the pictures go (default: <temp>\cc-try): merged-close-*.png, develop-reopen-*.png
 *
 * The unit tests pin the decisions (test/tab-shell-merged.test.js, test/tab-shell-develop.test.js). They can't see the page answer
 * the box-state question off a real screen, a real host end on the merged close, the strip page paint the notice and the empty
 * pane, or Electron build the two native menus. Against a throwaway container  <tmp>\proj\dev  with an origin and three lanes:
 *   #139   feat/a runs a stand-in CLI box (verify/lib/fake-claude-box.js) at rest, with the CLI's SessionStart hook sent down its
 *          host's pipe; its merged marker is written; it closes by itself: its host ends, its folder stays, the strip says
 *          "Closed feat/a (merged)", and the Lanes menu's Merged rows hold "feat/a (closed · Undo)"
 *   #160   develop closes (its x's close, the driver's yes), is the first row of the Lanes menu and of the + menu, the window
 *          with nothing open says how to get it back, the + menu's row brings it back selected and first; a restart with it
 *          closed keeps it closed with its row
 *   S7/S9  a drag of two lanes photographed at the drop, and a narrow window with a busy tab (for the report; nothing asserted)
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; CLAUDE_CUSTOM_WORKTREE_SCRIPTS points at an empty
 * folder, so no worktree is ever removed; the marker is written only into the probe's own temp repo. ELECTRON_RUN_AS_NODE is
 * deleted and every CLAUDE_CUSTOM_* variable but the probe's own is stripped. Hosts end by their own stop, and at the end by
 * pid tree for any left whose folder is inside the temp folder (verify/lib/seen-pids, proven by start time). Every picture is the
 * app's own capturePage (the strip page, the selected view): never the screen, so no other window can end up in one. A native
 * menu can't be captured that way, so its picture is the probe's DRAWING of the items Electron built, captioned as such
 * (app/main.js photographMenu). WINDOWS ONLY.
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

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-devmerged-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const origin = path.join(tmp, 'origin.git');
const userData = path.join(tmp, 'user-data');
const scripts = path.join(tmp, 'no-scripts');
const shots = process.env.DEVMERGED_PROBE_SHOTS || path.join(os.tmpdir(), 'cc-try');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(scripts, { recursive: true });
const shot = (name) => path.join(shots, `${name}.png`);
const written = [];

let failures = 0;
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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_WORKTREE_SCRIPTS'];

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
    CLAUDE_CUSTOM_WORKTREE_SCRIPTS: scripts,
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

// The CLI's hook events, sent down a host's pipe as the native helper would (verify/probe-git-tree.js does the same).
function fireHook(pid, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
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
const mark = (folder, branch) => {
  const gitDir = git(folder, 'rev-parse', '--absolute-git-dir').trim();
  fs.writeFileSync(path.join(gitDir, 'claude-merged.json'), JSON.stringify({ branch, pr: 139, mergedAt: new Date().toISOString() }));
};

const state = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const labels = (st) => ((st && st.tabs) || []).map(t => t.label);
const stripLabels = (st) => ((st && st.stripLayout && st.stripLayout.items) || []).filter(i => !i.leaving).map(i => i.label);
const hostOf = (st, label) => ((st && st.hosts) || []).find(h => h.label === label) || null;
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The app's own capture (capturePage): the selected tab's view as <name>.png, when there is one, and the strip page as
// <name>.strip.png. Only this app's pixels: nothing else on the screen can end up in a picture.
async function windowShot(app, name) {
  const r = await command(app, { cmd: 'screenshot', file: shot(name) });
  if (r.ok) {
    if (r.viewBytes > 0) written.push(shot(name));
    if (r.stripBytes > 0) written.push(r.stripFile);
  } else console.log(`(screenshot ${name}: ${r.error})`);
  return r;
}
async function menuShot(app, which, name) {
  const r = await command(app, { cmd: 'menu', which, shot: shot(name) }, 20000);
  if (r.ok && r.shotBytes) written.push(shot(name)); else console.log(`(menu shot ${name}: ${r.error || 'no picture'})`);
  return r;
}
const itemLabels = (r) => ((r && r.items) || []).map(i => (i.type === 'separator' ? '---' : i.label));
/** Click the menu row whose label starts with `prefix` (its shortcut suffix moves to whichever close is the most recent). */
async function clickRow(app, which, prefix) {
  const listed = await command(app, { cmd: 'menu', which });
  const label = itemLabels(listed).find(l => l.startsWith(prefix));
  if (!label) return { ok: false, error: `no row starting ${prefix}`, items: itemLabels(listed) };
  return command(app, { cmd: 'menu', which, item: label });
}

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
}

async function main() {
  console.log('temp repo:', tmp);
  console.log('pictures:', shots);
  fs.mkdirSync(dev, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'remote', 'add', 'origin', origin);
  git(dev, 'push', '-q', 'origin', 'develop');
  for (const [dir, branch] of [['feat-a', 'feat/a'], ['feat-b', 'feat/b'], ['feat-c', 'feat/c']]) {
    git(dev, 'worktree', 'add', '-q', path.join(container, dir), '-b', branch);
  }
  const featA = path.join(container, 'feat-a');

  let app = await launchApp(container);
  let st = await driverUp(app);
  if (!st) { check('the window came up and its driver answers', false, app.out.split('\n').slice(-25).join('\n')); return; }
  st = await waitFor(async () => { const x = await state(app); return (x.tabs || []).some(t => t.label === 'develop' && t.started) ? x : null; }, 40000);
  check('0: the window is up, develop started', !!st, st ? labels(st).join(', ') : app.out.slice(-600));
  if (!st) return;

  // ===== #139 =====
  // feat/a: a session with a stand-in CLI box at rest
  const selA = await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
  check('139.1: feat/a started (cmd.exe)', selA.ok === true && selA.started === true, JSON.stringify(selA));
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  const boxCtl = path.join(tmp, 'box-ctl.json');
  const boxLog = path.join(tmp, 'box-submitted.log');
  await view(app, 'gitTermInput', { data: `node "${path.join(ROOT, 'verify', 'lib', 'fake-claude-box.js')}" "${boxCtl}" "${boxLog}"\r` });
  const boxUp = await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && /fake claude box/.test(r.text || '') ? r : null; }, 15000, 300);
  check('139.2: the stand-in CLI box is drawn in feat/a', !!boxUp);
  st = await state(app);
  const aHost = hostOf(st, 'feat/a');
  check('139.3: the SessionStart hook reached feat/a\'s host', !!aHost && await fireHook(aHost.pid, 'SessionStart', { source: 'startup', session_id: 'probe-139' }), JSON.stringify(aHost));
  // feat/b and feat/c: plain sessions, so the strip has tabs either side of the one that goes
  for (const l of ['feat/b', 'feat/c']) await command(app, { cmd: 'select', label: l }, 60000);
  await command(app, { cmd: 'select', label: 'develop' }, 30000);
  st = await waitFor(async () => { const x = await state(app); return stripLabels(x).length === 4 ? x : null; }, 15000) || await state(app);
  check('139.4: four tabs on the strip before the merge', JSON.stringify(stripLabels(st)) === JSON.stringify(['develop', 'feat/a', 'feat/b', 'feat/c']), stripLabels(st).join(', '));
  await sleep(1500);
  await windowShot(app, 'merged-close-0-before');

  mark(featA, 'feat/a');
  const markedAt = Date.now();
  // The close ends the host through the hand close's path (PR #231): a stop whose reply is lost to the host's own exit waits up to the
  // host's shutdown bound (45 s) for the port to go quiet, so the window here is wider than that.
  const gone = await waitFor(async () => { const x = await state(app); return !labels(x).includes('feat/a') ? x : null; }, 120000, 500);
  console.log(`(139: feat/a left ${((Date.now() - markedAt) / 1000).toFixed(1)} s after its marker was written)`);
  for (const l of app.out.split('\n').filter(x => /\[shell\].*(feat-a|port \d+)/.test(x)).slice(-8)) console.log(`  | ${l.trim()}`);
  check('139.5: once its marker is written, feat/a (merged, clean, pushed, at rest) closes by itself', !!gone,
    gone ? '' : JSON.stringify({ labels: labels(await state(app)), log: app.out.split('\n').filter(l => /\[shell\]/.test(l)).slice(-15) }));
  if (gone) {
    st = await waitFor(async () => { const x = await state(app); return x.stripAlert && /merged/.test(x.stripAlert.text) ? x : null; }, 5000) || await state(app);
    check('139.6: the strip says "Closed feat/a (merged)", as an info line', st.mergedNotice === 'Closed feat/a (merged)' && !!st.stripAlert
      && st.stripAlert.text === 'Closed feat/a (merged)' && st.stripAlert.kind === 'info', JSON.stringify({ n: st.mergedNotice, a: st.stripAlert }));
    const row = ((st.lanes && st.lanes.merged) || []).find(r => r.label === 'feat/a');
    check('139.7: the Lanes menu has it as a Merged row, closed, whose click is the Undo', !!row && row.state === 'closed · Undo' && row.closed === true, JSON.stringify(st.lanes));
    check('139.8: its host ended (identity file gone, pid dead), its folder stays', !!aHost && !alive(aHost.pid) && fs.existsSync(featA),
      JSON.stringify({ pid: aHost && aHost.pid, alive: aHost && alive(aHost.pid), folder: fs.existsSync(featA) }));
    check('139.9: the other tabs stay', JSON.stringify(stripLabels(st)) === JSON.stringify(['develop', 'feat/b', 'feat/c']), stripLabels(st).join(', '));
    await windowShot(app, 'merged-close-1-notice');
    const lanes = await menuShot(app, 'lanes', 'merged-close-2-lanes-menu');
    check('139.10: the Lanes menu as Electron built it: Merged, then "feat/a  (closed · Undo)" with Ctrl+Shift+T',
      itemLabels(lanes).includes('Merged') && itemLabels(lanes).includes('feat/a  (closed · Undo)  (Ctrl+Shift+T)'), JSON.stringify(itemLabels(lanes)));
  }

  // ===== S7: a drag photographed right at the drop =====
  const drag = await command(app, { cmd: 'drag-tab', label: 'feat/c', onLabel: 'feat/b', half: 'left' });
  await windowShot(app, 'develop-reopen-s7-at-drop');
  await sleep(600);
  await windowShot(app, 'develop-reopen-s7-after-drop');
  console.log(`(S7: drag ${JSON.stringify(drag)}; order now ${stripLabels(await state(app)).join(', ')})`);

  // ===== #160 =====
  const closeDev = await command(app, { cmd: 'close', label: 'develop' }, 60000);
  st = await waitFor(async () => { const x = await state(app); return !labels(x).includes('develop') ? x : null; }, 15000) || await state(app);
  check('160.1: develop closes (the driver answers its question yes)', closeDev.ok === true && !labels(st).includes('develop'), JSON.stringify(closeDev));
  check('160.2: it is the Lanes menu\'s develop row, the window knows it is closed, and a lane you can see is selected',
    !!st.lanes && !!st.lanes.develop && st.lanes.develop.label === 'develop' && st.devClosed === true && ['feat/b', 'feat/c'].includes((st.tabs.find(t => t.selected) || {}).label),
    JSON.stringify({ develop: st.lanes && st.lanes.develop, devClosed: st.devClosed, sel: (st.tabs.find(t => t.selected) || {}).label }));
  await sleep(800);
  await windowShot(app, 'develop-reopen-1-closed');
  const lanesMenu = await menuShot(app, 'lanes', 'develop-reopen-2-lanes-menu');
  check('160.3: the Lanes menu lists "develop" first, with the shortcut that reopens it', itemLabels(lanesMenu)[0] === 'develop  (closed)  (Ctrl+Shift+T)', JSON.stringify(itemLabels(lanesMenu)));
  const plusMenu = await menuShot(app, 'plus', 'develop-reopen-3-plus-menu');
  check('160.4: the + menu lists "develop" first, then New branch…', itemLabels(plusMenu)[0] === 'develop  (closed)  (Ctrl+Shift+T)' && itemLabels(plusMenu)[1] === '---' && /^New branch…/.test(itemLabels(plusMenu)[2] || ''), JSON.stringify(itemLabels(plusMenu)));

  for (const l of ['feat/b', 'feat/c']) await command(app, { cmd: 'close', label: l }, 60000);
  st = await waitFor(async () => { const x = await state(app); return stripLabels(x).length === 0 && x.stripPane ? x : null; }, 15000) || await state(app);
  check('160.5: with every tab closed nothing is selected and the window says how to get develop back',
    stripLabels(st).length === 0 && st.selectedKey === null && st.stripPane === 'No tab is open. Open develop or a lane from Lanes ▾ or +.', JSON.stringify({ strip: stripLabels(st), sel: st.selectedKey, pane: st.stripPane }));
  const spawnedNothing = hostsOfThisRun().filter(id => alive(id.pid)).length;
  check('160.6: ...and no lane was started to fill it', spawnedNothing === 0, `${spawnedNothing} hosts alive`);
  await sleep(500);
  await windowShot(app, 'develop-reopen-4-empty');

  // PR #236 Miguel Y4: the empty window is reachable from the keyboard. Ctrl+Shift+T into the strip page reopens the most recent
  // close (feat/c here), which is then closed again so the run goes on from the same empty window.
  const keyed = await command(app, { cmd: 'strip-key', key: 'T', modifiers: ['control', 'shift'] });
  st = await waitFor(async () => { const x = await state(app); return (x.tabs || []).some(t => t.label === 'feat/c' && t.started) ? x : null; }, 40000) || await state(app);
  check('160.5b: Ctrl+Shift+T pressed into the empty window\'s strip page reopens the most recent close (feat/c)',
    keyed.ok === true && labels(st).includes('feat/c'), JSON.stringify({ keyed, labels: labels(st) }));
  // The keyboard itself is the strip page's only while the window has the OS focus, which a probe can't make sure of while
  // someone else uses the machine: checked when it does, said otherwise.
  if (keyed.windowFocused === true) check('160.5c: ...and the strip page held the keyboard when the last view went', keyed.stripFocused === true, JSON.stringify(keyed));
  else console.log(`(160.5c: the window didn't have the OS focus, so whether the strip page held the keyboard isn't measured: ${JSON.stringify(keyed)})`);
  await command(app, { cmd: 'close', label: 'feat/c' }, 60000);
  await waitFor(async () => { const x = await state(app); return stripLabels(x).length === 0 ? x : null; }, 15000);

  const back = await clickRow(app, 'plus', 'develop  (closed)');
  st = await waitFor(async () => { const x = await state(app); const d = (x.tabs || []).find(t => t.label === 'develop'); return d && d.started && d.selected ? x : null; }, 40000) || await state(app);
  check('160.7: the + menu\'s develop row brings it back, selected, first, started', back.ok === true && labels(st)[0] === 'develop' && !!(st.tabs.find(t => t.label === 'develop') || {}).selected,
    JSON.stringify({ back, labels: labels(st) }));
  check('160.8: and the rows are gone', !st.lanes.develop && st.devClosed === false, JSON.stringify(st.lanes && st.lanes.develop));
  await sleep(1200);
  await windowShot(app, 'develop-reopen-5-back');

  // ===== #160: a restart with develop closed =====
  await command(app, { cmd: 'close', label: 'develop' }, 60000);
  await quit(app);
  app = await launchApp(container);
  st = await driverUp(app);
  st = st && await waitFor(async () => { const x = await state(app); return x.lanes && x.lanes.develop && x.stripPane ? x : null; }, 30000);
  check('160.9: after a restart develop is still closed, its row is there, nothing started', !!st && !labels(st).includes('develop') && hostsOfThisRun().filter(id => alive(id.pid)).length === 0,
    st ? JSON.stringify({ labels: labels(st), develop: st.lanes.develop }) : 'no state');
  if (st) await windowShot(app, 'develop-reopen-6-after-restart');
  const back2 = await clickRow(app, 'lanes', 'develop  (closed)');
  st = await waitFor(async () => { const x = await state(app); return (x.tabs || []).some(t => t.label === 'develop' && t.started) ? x : null; }, 40000);
  check('160.10: and its Lanes row reopens it', back2.ok === true && !!st, JSON.stringify(back2));

  // ===== S9: a busy tab at the narrow width (for the report) =====
  for (const l of ['feat/b', 'feat/c']) await clickRow(app, 'lanes', `${l}  (closed)`);
  await sleep(2000);
  st = await state(app);
  for (const h of (st.hosts || [])) if (/feat\/[bc]/.test(h.label || '')) await fireHook(h.pid, 'UserPromptSubmit', { prompt: 'probe S9' });
  await command(app, { cmd: 'select', label: 'develop' }, 30000);
  await command(app, { cmd: 'window-size', width: 640 });
  await sleep(1500);
  st = await state(app);
  console.log(`(S9: at 640 px the strip painted ${JSON.stringify(((st.stripLayout || {}).items || []).map(i => [i.label, i.width]))})`);
  await windowShot(app, 'develop-reopen-s9-narrow-busy');
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
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${tmp}: ${e.message})`); }
  }
  console.log('\npictures written:');
  for (const f of written) console.log(`  ${f}`);
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
