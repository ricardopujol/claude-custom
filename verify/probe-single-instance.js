'use strict';
/**
 * PROBE: one Jiandu process per install (single-instance PR 3, documentation/PLAN_SINGLE_INSTANCE_PR3.md "Probes") in REAL Electron
 * windows. (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-single-instance.js --cases=1-5     (exit 0 = every check held)
 *   node scripts/with-heavy-lock.js node verify/probe-single-instance.js --cases=6-9
 *
 *   1  launch A: appLock.owns; <uiState>\app.json names its pid and start; the REAL <install>\.harness\app.json is byte-identical before and
 *      after (or still absent); the restore record lists A, not clean
 *   2  a second launch on B exits 0 with no window; `windows` lists A and B under the same pid; B's window.json names that pid
 *   3  a relaunch from A's feat-a folder exits 0; A selects feat/a; still two windows
 *   4  a launch WITHOUT the single-instance flag on C runs its own process and leaves <uiState>\app.json untouched
 *   5  two launches at once on D and E against the running owner: both exit 0, four windows, one pid. Then, from nothing (a fresh state
 *      folder), two launches started together on F and G end as one process with both windows
 *   6  tray (CLAUDE_CUSTOM_TRAY_PROBE=1): one tray; tooltip `Jiandu · 2 windows · N sessions`; a row per window; a row click on a hidden
 *      window shows it. (A cue raised in one window is NOT run: a probe host has no session that can raise one.)
 *   7  unsaved text in A and B (reader-unsaved), graceful quit: exactly one quit question naming both (the probe answers discard), exit 0,
 *      the record is clean, app.json and both window.json are gone
 *   8  crash: A and B open (B hidden), the Electron main is killed by its own pid (hosts left alive); a relaunch on A brings A and B back in
 *      one process, B hidden, every tab on the same host pid. A clean quit, then a relaunch, opens only A
 *   9  hung owner: the owner main is suspended (its own child, by pid + start); a second launch gets no ack in 10 s, finds the owner still
 *      alive and waits the full bound (readyBound + 10 s, PR #258 Dexter 1), then opens its own process and takes app.json over; the first is
 *      resumed and both quit
 *
 * SAFE. Scratch projects in a temp folder (never dev\), the hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* the probe doesn't set are deleted by the launcher, registry / portraits / uploads / UI state / user data are temp folders,
 * so app.json lives in the probe's own state folder (host/app-lock-config.js: the flag is honoured only with one). Every host whose folder
 * is inside the probe's temp folder is stopped by pid at the end; the only processes killed or suspended are this probe's own children.
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
const { startTimes } = require(path.join(ROOT, 'host', 'proc-start'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const arg = process.argv.find((a) => a.startsWith('--cases='));
const [FROM, TO] = arg ? arg.slice('--cases='.length).split('-').map(Number) : [1, 9];
const runs = (n) => n >= FROM && n <= (Number.isFinite(TO) ? TO : FROM);

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-single-instance-');
const userData = path.join(tmp, 'user-data');
const REAL_APP_JSON = path.join(HARNESS_DIR, 'app.json');

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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_REGISTRY',
  'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_UI_STATE_DIR', 'CLAUDE_CUSTOM_ONE_WINDOW_PROBE', 'CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE',
  'CLAUDE_CUSTOM_TRAY_PROBE'];

const stateDir = (name) => { const d = path.join(tmp, `ui-${name}`); fs.mkdirSync(d, { recursive: true }); return d; };

async function launchApp(cwd, { uiState, flag = true, tray = false } = {}) {
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
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
    CLAUDE_CUSTOM_ONE_WINDOW_PROBE: '1',
  };
  if (flag) env.CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE = '1';
  if (tray) env.CLAUDE_CUSTOM_TRAY_PROBE = '1';
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
    if (k === 'CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE' && !flag) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false, exitCode: null };
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

function makeProject(name) {
  const container = path.join(tmp, name);
  const dev = path.join(container, 'dev');
  const featA = path.join(container, 'feat-a');
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
  return { name, container, dev, featA, ownerFile: path.join(dev, '.claude-custom', 'window.json') };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const sameBytes = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };

async function stateOf(app, root) {
  const st = await command(app, root === undefined ? { cmd: 'state' } : { cmd: 'state', window: root });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
}
async function windowUp(app, root) {
  return waitFor(async () => {
    const st = await stateOf(app, root);
    return st && st.ok && Array.isArray(st.hosts) && st.hosts.length >= 2 ? st : null;
  }, 150000, 500);
}
const windowsOf = async (app) => { const r = await command(app, { cmd: 'windows' }); return r && r.ok ? r : null; };
const handedOver = (app) => /single instance: the owner \(pid \d+\) has it; this launch ends/.test(app.out);
async function endsHandedOver(app, ms = 120000) {
  await waitFor(() => (handedOver(app) ? true : null), ms);
  const gone = await waitFor(() => (app.exited ? true : null), 300000, 1000);
  return handedOver(app) && gone === true && app.exitCode === 0;
}
async function quitAndWait(app, ms = 300000) {
  if (app.exited) return true;
  await command(app, { cmd: 'quit', graceful: true });
  return (await waitFor(() => (app.exited ? true : null), ms, 1000)) === true;
}

// ---- cases 1-5 ----------------------------------------------------------------------------------------------------------------------

async function cases1to5() {
  const ui = stateDir('main');
  const appJson = path.join(ui, 'app.json');
  const realBefore = readBytes(REAL_APP_JSON);
  const A = makeProject('alpha');
  const B = makeProject('beta');

  // 1
  const app1 = await launchApp(A.container, { uiState: ui });
  const st1 = await windowUp(app1);
  check('1: launch A came up with its tabs', !!st1, st1 ? '' : app1.out.slice(-800));
  if (!st1) return [app1];
  const lock = await command(app1, { cmd: 'appLock' });
  check('1: appLock.owns is true, in the probe\'s own state folder', lock.ok && lock.owns === true && !!lock.file && path.resolve(lock.file) === path.resolve(appJson), JSON.stringify(lock));
  const own1 = await startTimes([app1.child.pid]);
  const a1 = readJson(appJson);
  check('1: <uiState>\\app.json names its pid and OS start time', !!a1 && a1.pid === app1.child.pid && !!own1 && a1.start === own1.get(app1.child.pid), JSON.stringify(a1));
  check('1: the REAL <install>\\.harness\\app.json is byte-identical (or still absent)', sameBytes(realBefore, readBytes(REAL_APP_JSON)), realBefore === null ? 'absent before' : 'present before');
  const rec1 = await waitFor(async () => { const r = await command(app1, { cmd: 'openWindows' }); return r.ok && r.record && Array.isArray(r.record.windows) && r.record.windows.length === 1 ? r.record : null; }, 20000);
  check('1: the record lists A, not clean', !!rec1 && rec1.clean === false && path.resolve(rec1.windows[0].root) === path.resolve(A.container), JSON.stringify(rec1));

  // 2
  const app2 = await launchApp(B.container, { uiState: ui });
  check('2: a second launch on B exits 0 with no window of its own', await endsHandedOver(app2), `exit=${app2.exitCode} ${app2.out.slice(-300)}`);
  const w2 = await waitFor(async () => { const w = await windowsOf(app1); return w && w.windows.length === 2 ? w : null; }, 120000);
  check('2: `windows` lists A and B under the same pid', !!w2 && w2.pid === app1.child.pid, JSON.stringify(w2 && w2.windows.map((w) => w.root)));
  await windowUp(app1, B.container);
  const ob = readJson(B.ownerFile);
  check('2: B\'s window.json names that pid', !!ob && ob.pid === app1.child.pid, JSON.stringify(ob));

  // 3
  const aKey = (st1.hosts.find((h) => h.label === 'feat/a') || {}).key;
  const app3 = await launchApp(A.featA, { uiState: ui });
  check('3: a relaunch from A\'s feat-a folder exits 0', await endsHandedOver(app3), `exit=${app3.exitCode}`);
  const sel = await waitFor(async () => { const s = await stateOf(app1, A.container); return s && s.selectedKey === aKey ? s : null; }, 30000);
  check('3: A selects feat/a', !!sel && !!aKey, `want ${aKey}`);
  const w3 = await windowsOf(app1);
  check('3: still two windows', !!w3 && w3.windows.length === 2, JSON.stringify(w3 && w3.windows.length));

  // 4
  const C = makeProject('gamma');
  const before4 = readBytes(appJson);
  const app4 = await launchApp(C.container, { uiState: ui, flag: false });
  const st4 = await windowUp(app4);
  check('4: a launch without the flag on C runs its own process', !!st4 && !app4.exited && app4.child.pid !== app1.child.pid, st4 ? '' : app4.out.slice(-400));
  check('4: ...and leaves <uiState>\\app.json untouched', sameBytes(before4, readBytes(appJson)));
  await quitAndWait(app4);

  // 5
  const D = makeProject('delta');
  const E = makeProject('epsilon');
  const [d5, e5] = await Promise.all([launchApp(D.container, { uiState: ui }), launchApp(E.container, { uiState: ui })]);
  const [dOk, eOk] = await Promise.all([endsHandedOver(d5), endsHandedOver(e5)]);
  check('5: two launches at once on D and E both exit 0', dOk && eOk, `D=${d5.exitCode} E=${e5.exitCode}`);
  const w5 = await waitFor(async () => { const w = await windowsOf(app1); return w && w.windows.length === 4 ? w : null; }, 150000);
  check('5: four windows, one pid', !!w5 && w5.pid === app1.child.pid, JSON.stringify(w5 && w5.windows.map((w) => path.basename(w.root))));

  const ui2 = stateDir('fresh');
  const F = makeProject('phi');
  const G = makeProject('gimel');
  const pair = await Promise.all([launchApp(F.container, { uiState: ui2 }), launchApp(G.container, { uiState: ui2 })]);
  await waitFor(() => (pair.some(handedOver) ? true : null), 150000);
  await sleep(5000);
  const enders = pair.filter(handedOver);
  const keepers = pair.filter((a) => !handedOver(a));
  check('5: from nothing, two launches together: one hands over, one keeps', enders.length === 1 && keepers.length === 1, `enders=${enders.length}`);
  if (keepers.length === 1) {
    const wk = await waitFor(async () => { const w = await windowsOf(keepers[0]); return w && w.windows.length === 2 ? w : null; }, 150000);
    check('5: ...and the one process has both windows', !!wk, JSON.stringify(wk && wk.windows.map((w) => path.basename(w.root))));
  }
  return [app1, app2, app3, app4, d5, e5, ...pair];
}

// ---- cases 6-9 ----------------------------------------------------------------------------------------------------------------------

async function cases6and7() {
  const ui = stateDir('tray');
  const appJson = path.join(ui, 'app.json');
  const A = makeProject('tray-a');
  const B = makeProject('tray-b');
  const app = await launchApp(A.container, { uiState: ui, tray: true });
  const st = await windowUp(app);
  check('6: the tray launch came up', !!st, st ? '' : app.out.slice(-600));
  if (!st) return [app];
  const b = await launchApp(B.container, { uiState: ui, tray: true });
  check('6: the second launch handed over', await endsHandedOver(b));
  await waitFor(async () => { const w = await windowsOf(app); return w && w.windows.length === 2 ? w : null; }, 150000);
  const stB = await windowUp(app, B.container);
  const t6 = await waitFor(async () => { const t = await command(app, { cmd: 'tray' }); return t.ok && t.tray && t.tray.windows === 2 ? t : null; }, 30000);
  check('6: one tray; tooltip `Jiandu · 2 windows · N sessions`', !!t6 && /^Jiandu · 2 windows · \d+ sessions?$/.test(t6.tray.tooltip), JSON.stringify(t6 && t6.tray.tooltip));
  const menu = await command(app, { cmd: 'tray-menu' });
  const labels = (menu.rows || []).map((r) => r.label);
  const rowA = labels.find((l) => l.startsWith(`${path.basename(A.container)}  ·`));
  const rowB = labels.find((l) => l.startsWith(`${path.basename(B.container)}  ·`));
  check('6: a row per window, then Quit Jiandu', !!rowA && !!rowB && labels.includes('Quit Jiandu'), JSON.stringify(labels));
  await command(app, { cmd: 'window-hide', window: B.container });
  const hidden = await command(app, { cmd: 'tray-menu' });
  check('6: with B hidden the menu offers Show all windows', (hidden.rows || []).some((r) => r.label === 'Show all windows'));
  if (rowB) await command(app, { cmd: 'tray-menu', label: rowB });
  const shown = await waitFor(async () => { const m = await command(app, { cmd: 'tray-menu' }); return (m.rows || []).some((r) => r.label === 'Hide all windows') ? m : null; }, 10000);
  check('6: a row click on the hidden B shows it', !!shown);
  console.log('      (6: the cue in B, badge 1 and the left click selecting B\'s tab: NOT RUN, a probe host has no session to raise a cue)');

  // 7
  const keyA = (st.hosts.find((h) => h.label === 'develop') || {}).key;
  const keyB = stB ? (stB.hosts.find((h) => h.label === 'develop') || {}).key : null;
  const ua = await command(app, { cmd: 'reader-unsaved', window: A.container, key: keyA, path: 'notes-a.md' });
  const ub = await command(app, { cmd: 'reader-unsaved', window: B.container, key: keyB, path: 'notes-b.md' });
  check('7: unsaved text reported in A and B', ua.ok === true && ub.ok === true, JSON.stringify([ua, ub]));
  await command(app, { cmd: 'quit', graceful: true });
  const gone = await waitFor(() => (app.exited ? true : null), 300000, 1000);
  const asked = app.out.split('\n').filter((l) => /quit question \(probe, answered discard\)/.test(l));
  const seen = app.out.split('\n').filter((l) => /quit question windows \(probe\)/.test(l));
  check('7: exactly one quit question, naming both windows', asked.length === 1 && asked[0].includes(path.basename(A.container)) && asked[0].includes(path.basename(B.container)),
    `${JSON.stringify(asked)} ${JSON.stringify(seen)}`);
  check('7: the process ended with exit 0', gone === true && app.exitCode === 0, `exit=${app.exitCode}`);
  const rec = readJson(path.join(ui, 'open-windows.json'));
  check('7: the record is clean', !!rec && rec.clean === true, JSON.stringify(rec));
  check('7: app.json and both window.json are gone', !fs.existsSync(appJson) && !fs.existsSync(A.ownerFile) && !fs.existsSync(B.ownerFile),
    JSON.stringify([fs.existsSync(appJson), fs.existsSync(A.ownerFile), fs.existsSync(B.ownerFile)]));
  return [app, b];
}

async function case8() {
  const ui = stateDir('crash');
  const A = makeProject('crash-a');
  const B = makeProject('crash-b');
  const app = await launchApp(A.container, { uiState: ui, tray: true });
  const st = await windowUp(app);
  check('8: launch A came up', !!st, st ? '' : app.out.slice(-600));
  if (!st) return [app];
  const b = await launchApp(B.container, { uiState: ui, tray: true });
  await endsHandedOver(b);
  const stB = await windowUp(app, B.container);
  await command(app, { cmd: 'window-hide', window: B.container });
  const recBefore = await waitFor(async () => { const r = await command(app, { cmd: 'openWindows' }); const w = r.record && r.record.windows; return w && w.length === 2 && w.some((x) => x.hidden) ? r.record : null; }, 20000);
  check('8: the record lists A and B, B hidden', !!recBefore, JSON.stringify(recBefore));
  const stA2 = await stateOf(app, A.container);
  const stB2 = await stateOf(app, B.container);
  const hostPids = new Map([...((stA2 && stA2.hosts) || []), ...((stB2 && stB2.hosts) || [])].filter((h) => Number.isInteger(h.pid)).map((h) => [`${h.key}`, h.pid]));
  // The crash: this probe's own Electron main, through the handle the probe holds (that one process, not its tree: the hosts are
  // detached and must outlive it)
  try { app.child.kill('SIGKILL'); } catch { /* reported below */ }
  const died = await waitFor(() => (app.exited ? true : null), 60000, 500);
  check('8: the Electron main was killed by its pid', died === true);
  check('8: ...and the hosts\' pids are still alive', [...hostPids.values()].every(isRunning), JSON.stringify([...hostPids.values()]));
  const again = await launchApp(A.container, { uiState: ui, tray: true });
  const back = await waitFor(async () => { const w = await windowsOf(again); return w && w.windows.length === 2 ? w : null; }, 200000, 1000);
  check('8: a relaunch on A brings A and B back in one process', !!back && back.pid === again.child.pid, again.out.slice(-400));
  const sA = await windowUp(again, A.container);
  const sB = await windowUp(again, B.container);
  const rec = await command(again, { cmd: 'openWindows' });
  const bRec = rec.record && (rec.record.windows || []).find((w) => path.resolve(w.root) === path.resolve(B.container));
  check('8: B came back hidden', !!bRec && bRec.hidden === true, JSON.stringify(rec.record));
  const after = new Map([...((sA && sA.hosts) || []), ...((sB && sB.hosts) || [])].filter((h) => Number.isInteger(h.pid)).map((h) => [`${h.key}`, h.pid]));
  check('8: every tab is on the same host pid', hostPids.size > 0 && [...hostPids].every(([key, pid]) => after.get(key) === pid), JSON.stringify({ before: [...hostPids], after: [...after] }));
  await quitAndWait(again);
  const only = await launchApp(A.container, { uiState: ui, tray: true });
  await windowUp(only);
  await sleep(5000);
  const w = await windowsOf(only);
  check('8: after a clean quit, a relaunch opens only A', !!w && w.windows.length === 1, JSON.stringify(w && w.windows.map((x) => path.basename(x.root))));
  await quitAndWait(only);
  return [app, b, again, only];
}

async function case9() {
  const ui = stateDir('hung');
  const appJson = path.join(ui, 'app.json');
  const A = makeProject('hung-a');
  const B = makeProject('hung-b');
  const app = await launchApp(A.container, { uiState: ui });
  const st = await windowUp(app);
  check('9: the owner came up', !!st, st ? '' : app.out.slice(-600));
  if (!st) return [app];
  const start = (await startTimes([app.child.pid])).get(app.child.pid);
  // host/process-suspend.js refuses a root with protected processes under it (an Electron main's renderers and hosts), so the probe freezes
  // ONLY its own Electron main, proven by pid + start, with NtSuspendProcess: the main's event loop stops, which is a hung owner.
  const freeze = (action) => {
    const fn = action === 'suspend' ? 'NtSuspendProcess' : 'NtResumeProcess';
    const ps = `$ErrorActionPreference='Stop'
$t = Add-Type -MemberDefinition '[DllImport("ntdll.dll")] public static extern uint ${fn}(IntPtr h);' -Name 'P${fn}' -Namespace 'ProbeSingleInstance' -PassThru
$p = Get-Process -Id ${app.child.pid}
if ([math]::Abs($p.StartTime.ToFileTimeUtc() - ${start}) -gt 10000000) { 'reused'; exit }
$r = $t::${fn}($p.Handle)
"done $r"`;
    try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim(); } catch (e) { return `failed ${e.message}`; }
  };
  const s = freeze('suspend');
  check('9: the owner main is suspended (this probe\'s own child, by pid + start)', s === 'done 0', s);
  let b = null;
  try {
    const t0 = Date.now();
    b = await launchApp(B.container, { uiState: ui });
    // PR #258 Dexter 1: a missed ack is not a hang by itself; the live owner is waited for (readyBound 180 s + 10 s), then passed by
    const slow = await waitFor(() => (/single instance: owner pid \d+ did not acknowledge within 10000 ms but is still alive; waiting/.test(b.out) ? true : null), 120000, 500);
    check('9: a second launch got no ack, found the owner still alive, and waited', slow === true, b.out.slice(-400));
    const said = await waitFor(() => (/single instance: owner pid \d+ did not accept \(timed out/.test(b.out) ? true : null), 260000, 1000);
    check('9: ...the owner stayed silent for the full wait (a true hang), and the launch went on', said === true, b.out.slice(-400));
    const up = await windowUp(b);
    check('9: ...it opened its own process', !!up && !b.exited, `${Date.now() - t0} ms`);
    const o = readJson(appJson);
    check('9: ...and took app.json over', !!o && o.pid === b.child.pid, JSON.stringify(o));
  } finally {
    const r = freeze('resume');
    check('9: the first is resumed', r === 'done 0', r);
  }
  const q = await Promise.all([quitAndWait(app), b ? quitAndWait(b) : Promise.resolve(true)]);
  check('9: both quit', q.every((x) => x === true));
  return [app, b].filter(Boolean);
}

async function main() {
  const all = [];
  if (runs(1) || runs(2) || runs(3) || runs(4) || runs(5)) all.push(...await cases1to5());
  if (runs(6) || runs(7)) all.push(...await cases6and7());
  if (runs(8)) all.push(...await case8());
  if (runs(9)) all.push(...await case9());
  const left = all.filter((a) => a && !a.exited);
  for (const a of left) await command(a, { cmd: 'quit', graceful: true });
  const gone = await waitFor(() => (all.every((a) => !a || a.exited) ? true : null), 300000, 1000);
  check('every Electron this probe started has ended', gone === true, all.filter((a) => a && !a.exited).map((a) => a.child.pid).join(' '));
}

main()
  .catch((err) => { console.log('FAIL  the probe threw: ' + ((err && err.stack) || err)); failures++; })
  .finally(() => {
    killEverything();
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
