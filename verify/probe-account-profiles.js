'use strict';
/**
 * Account profiles (BACKLOG #119 A1), in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node verify/probe-account-profiles.js        (exit 0 = every check held)
 *
 * test/tab-env.test.js, test/tab-shell-profiles.test.js and test/profile-service.test.js pin the decisions. Nothing else runs app/main.js,
 * the strip page, a tab page and two real hosts together, and that is where this feature can lie: the profile has to travel from the
 * store, through the shell and hostEnv, into the host, into the `claude` it starts, and back to the page as the chip and the strip's dot.
 *
 * Against a throwaway container repo  <tmp>\proj\dev  (+ feat-a), a throwaway profiles dir with two profiles (work, play) and a saved
 * choice for each tab (dev -> work, feat-a -> play):
 *   env        each tab's `claude` is started with CLAUDE_CONFIG_DIR = its profile's folder (the probe asks each cmd.exe what its environment holds)
 *   chip       the header chip of each tab's page reads that tab's profile name, tinted with its colour
 *   dot        the strip paints a coloured dot on both tabs (neither is the default)
 *   accounts   the Style panel's Accounts section drew a row for the default and for each profile
 *   switch     picking the default on feat-a (as the chip menu's click does): main asked "Restart this session as Default?",
 *              the old host is gone, a new host starts WITHOUT CLAUDE_CONFIG_DIR, the chip reads Default, the dot goes
 *   remember   the pick is saved: the choices file names feat-a -> default
 *   port       REUSED PORT: feat-a's host dies unseen and a stranger (another folder's identity file, a live process of its own) takes its port;
 *              switching feat-a to work kills NOTHING of the stranger and restarts feat-a under work on a port of its own
 *   sessions   a profile that never ran a session has no sessions folder; the task-log registry read must still be ok
 *
 * WHAT IT DOES NOT COVER: cmd.exe as `claude` stops cleanly here, so the proven-kill path for a host that hangs after a stop (measured on
 * this machine: node-pty teardown) is NOT exercised by a real hang; test/tab-shell-profiles.test.js pins it. Read "all checks passed"
 * with that in mind.
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing runs that bills and no login is needed. The app is driven
 * through CLAUDE_CUSTOM_TABS_PROBE (app/main.js), which does nothing when unset. The profiles dir, registry, portraits and uploads are
 * temp folders. Every process it started is ended through host/kill-tree.js by pid AND start time (verify/lib/seen-pids.js), never by name.
 * WINDOWS ONLY (cmd.exe).
 */
const { execFileSync, spawn } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const profilesLib = require(path.join(ROOT, 'host', 'profiles'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-profiles-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const profilesDir = path.join(tmp, 'profiles');
const seenDir = path.join(tmp, 'seen');                  // what each tab's cmd.exe reported
const cfgWork = path.join(tmp, 'cfg-work');
const cfgPlay = path.join(tmp, 'cfg-play');
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

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};

function makeContainer() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');
}

/**
 * What a host's `claude` was given. Its `claude` is an interactive cmd.exe (a .cmd stub HANGS the host on stop under Electron: measured, node-pty
 * AttachConsole fails), so the probe types one line into that cmd, as a person would, and cmd answers with what ITS environment holds: the
 * folder it runs in and CLAUDE_CONFIG_DIR (an unset variable stays the literal %CLAUDE_CONFIG_DIR% in an interactive cmd). One file per call.
 */
let recordNo = 0;
async function recordEnv(host) {
  fs.mkdirSync(seenDir, { recursive: true });
  const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
  const token = fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${host.port}.token`), 'utf8').trim();
  const file = path.join(seenDir, `seen-${++recordNo}.txt`);
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${encodeURIComponent(token)}`);
  ws.on('error', () => {});
  ws.on('message', () => {});
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await sleep(1500);                      // let cmd draw its prompt
    ws.send(JSON.stringify({ type: 'input', data: `echo CWD=%CD%^|CFG=%CLAUDE_CONFIG_DIR%>"${file}"\r` }));
    return await waitFor(() => (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '' ? true : null), 15000, 250);
  } finally {
    try { ws.terminate(); } catch { /* our own socket */ }
  }
}
/** Every recording made:  [{ cwd, cfg }] in the order the files were written. */
function seenStarts() {
  let files = [];
  try { files = fs.readdirSync(seenDir).map(f => path.join(seenDir, f)); } catch { return []; }
  const out = [];
  for (const f of files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)) {
    const text = fs.readFileSync(f, 'utf8').trim();
    const m = /^CWD=(.*)\|CFG=(.*)$/.exec(text);
    if (m) out.push({ cwd: m[1].trim(), cfg: m[2].trim() });
  }
  return out;
}
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const startsIn = (dir) => seenStarts().filter(s => sameDir(s.cwd, dir));

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
    CLAUDE_CUSTOM_PROFILES_DIR: profilesDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;           // the default profile must see NO config dir
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_PROFILES_DIR'] });
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
const tabOf = (s, label) => (s && s.tabs ? s.tabs.find(t => t.label === label) : null);
const hostOf = (s, label) => (s && s.hosts ? s.hosts.find(h => h.label === label) : null);
const domOf = (s, label) => (s && Array.isArray(s.stripDom) ? s.stripDom.find(d => d.label === label) : null);

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

function identitiesUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const port = Number(f.replace(/\.json$/, ''));
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'hosts', f), 'utf8')); } catch { continue; }
    const id = readIdentity({ dir: HARNESS_DIR, port });
    if (id && raw && sameDir(id.cwd, dir)) out.push({ ...id, claudePid: raw.claudePid, processStartedAt: raw.processStartedAt });
  }
  return out;
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid); };

function killEverything() {
  for (const id of identitiesUnder(featA).concat(identitiesUnder(dev))) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}

function removeTemp() {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}
hygiene.addCleanup(killEverything);

// --- the probe ---------------------------------------------------------------------------
async function main() {
  console.log('temp repo:', tmp);
  makeContainer();

  // Two profiles and a saved choice per tab, written through the real store so the file is what the app writes.
  fs.mkdirSync(profilesDir, { recursive: true });
  let store = { version: 1, profiles: [] };
  // ids are random (never recycled), so they are read back rather than assumed
  const addedWork = profilesLib.addProfile(store, { name: 'Work', colour: '#4c8bf5', configDir: cfgWork }, { home: tmp });
  store = addedWork.store;
  const addedPlay = profilesLib.addProfile(store, { name: 'Play', colour: '#4caf6a', configDir: cfgPlay }, { home: tmp });
  store = addedPlay.store;
  const workId = addedWork.profile.id;
  const playId = addedPlay.profile.id;
  profilesLib.writeProfiles(profilesLib.profilesFile(profilesDir), store);
  const keyOf = (p) => require(path.join(ROOT, 'host', 'project-layout')).normPath(p);
  let choices = profilesLib.emptyChoices();
  choices = profilesLib.remember(choices, { worktree: keyOf(dev), project: keyOf(container) }, workId);
  choices = profilesLib.remember(choices, { worktree: keyOf(featA), project: keyOf(container) }, playId);
  profilesLib.writeChoices(profilesLib.choicesFile(profilesDir), choices);

  const app = await launchApp(container);
  let s = await driverUp(app);
  if (!s) {
    check('the window came up and its driver answers', false, `\n${app.out.split('\n').slice(-25).join('\n')}`);
    skipped = true;
    await quit(app);
    return;
  }
  check('the window came up and its driver answers', true, `pid ${app.child.pid}`);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'develop') && tabOf(x, 'feat/a') && tabOf(x, 'develop').started ? x : null; }, 40000);
  remember(s);
  if (!s) { check('both tabs are listed and develop started', false); skipped = true; return; }

  // ===== env =====
  const sel = await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
  s = await state(app);
  remember(s);
  check('feat/a started', !!sel.ok && sel.started === true, JSON.stringify(sel));
  const devHost = hostOf(s, 'develop');
  const aHost0 = hostOf(s, 'feat/a');
  const recorded = !!devHost && !!aHost0 && !!(await recordEnv(devHost)) && !!(await recordEnv(aHost0));
  check("each tab's claude (cmd.exe) answered when asked for its environment", recorded);
  const devStart = startsIn(dev)[0] || null;
  const aStart = startsIn(featA)[0] || null;
  check("develop's claude was started with CLAUDE_CONFIG_DIR = the work profile's folder", !!devStart && sameDir(devStart.cfg, cfgWork), JSON.stringify(devStart));
  check("feat/a's claude was started with CLAUDE_CONFIG_DIR = the play profile's folder", !!aStart && sameDir(aStart.cfg, cfgPlay), JSON.stringify(aStart));
  check('the two tabs got different folders', !!devStart && !!aStart && !sameDir(devStart.cfg, aStart.cfg));
  check("the shell holds each tab's profile id", s.profileOf && s.profileOf.develop === workId && s.profileOf['feat/a'] === playId, JSON.stringify(s.profileOf));

  // ===== chip =====
  s = await waitFor(async () => { const x = await state(app); return x.viewDom && x.viewDom.profileChip && x.viewDom.profileChip.text === 'Play' ? x : null; }, 30000, 400);
  check("feat/a's header chip reads Play, tinted with its colour",
    !!s && s.viewDom.profileChip.colour === '#4caf6a' && /Play/.test(s.viewDom.profileChip.title), s ? JSON.stringify(s.viewDom.profileChip) : 'no chip');
  await command(app, { cmd: 'select', label: 'develop' }, 60000);
  const sDev = await waitFor(async () => { const x = await state(app); return x.viewDom && x.viewDom.profileChip && x.viewDom.profileChip.text === 'Work' ? x : null; }, 30000, 400);
  check("develop's header chip reads Work, tinted with its colour", !!sDev && sDev.viewDom.profileChip.colour === '#4c8bf5', sDev ? JSON.stringify(sDev.viewDom.profileChip) : 'no chip');

  // ===== dot =====
  const dDev = domOf(sDev || s, 'develop');
  const dA = domOf(sDev || s, 'feat/a');
  check('the strip paints a dot on both tabs, in their profile colours',
    !!dDev && !!dA && !!dDev.profileDot && !!dA.profileDot && /Work/.test(dDev.profileDot.title) && /Play/.test(dA.profileDot.title),
    JSON.stringify([dDev && dDev.profileDot, dA && dA.profileDot]));

  // ===== accounts =====
  check('the Style panel drew an Accounts row for the default and for each profile', !!sDev && sDev.viewDom.accountsRows === 3, sDev ? `rows ${sDev.viewDom.accountsRows}` : 'no state');

  // ===== switch =====
  const aHost = hostOf(sDev || s, 'feat/a');
  const asksBefore = ((sDev || s).profileAsks || []).length;
  // The chip belongs to the SELECTED tab, so that is where the pick comes from (an unselected tab restarts lazily, on its next selection).
  await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
  const picked = await command(app, { cmd: 'profile', label: 'feat/a', id: 'default' }, 90000);
  check('picking the default on feat/a restarted it', picked.ok === true && picked.restarted === true, JSON.stringify(picked));
  if (picked.ok !== true && aHost) {
    const t0 = Date.now();
    const died = await waitFor(() => !alive(aHost.pid), 40000, 250);
    const port = await require(path.join(ROOT, 'host', 'port-probe')).probePort(aHost.port);
    if (!died) {
      try {
        const ps = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${aHost.pid}; 'cpu=' + $p.CPU + ' threads=' + $p.Threads.Count + ' children=' + ((Get-CimInstance Win32_Process -Filter 'ParentProcessId=${aHost.pid}' | ForEach-Object { $_.Name + ':' + $_.ProcessId }) -join ',')`], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
        console.log(`DIAG  ${ps}`);
      } catch (e) { console.log(`DIAG  ps failed: ${e.message}`); }
    }
    console.log(`DIAG  old host ${aHost.pid} on ${aHost.port}: ${died ? `exited ${Date.now() - t0} ms after the failed switch` : 'still alive 40 s later'}; port probe says ${port}; identity file ${fs.existsSync(path.join(HARNESS_DIR, 'hosts', `${aHost.port}.json`)) ? 'still there' : 'gone'}`);
  }
  const afterSwitch = await waitFor(async () => {
    const x = await state(app);
    const h = hostOf(x, 'feat/a');
    return h && aHost && h.pid !== aHost.pid && alive(h.pid) && tabOf(x, 'feat/a').started ? x : null;
  }, 60000, 400);
  remember(afterSwitch);
  if (!afterSwitch) {
    const x = await state(app);
    console.log(`DIAG  after the switch: host ${JSON.stringify(hostOf(x, 'feat/a'))}, old pid ${aHost && aHost.pid} alive=${aHost ? alive(aHost.pid) : null}, tab ${JSON.stringify(tabOf(x, 'feat/a'))}`);
    console.log(`DIAG  identity files under feat-a: ${JSON.stringify(identitiesUnder(featA).map(i => ({ pid: i.pid, port: i.port })))}`);
  }
  check('main asked "Restart this session as Default?" before ending the live session',
    !!afterSwitch && afterSwitch.profileAsks.length === asksBefore + 1 && /^Restart this session as Default\?/.test(afterSwitch.profileAsks[asksBefore]),
    afterSwitch ? JSON.stringify(afterSwitch.profileAsks) : 'no state');
  check('the old host is gone and a new one serves feat/a', !!aHost && !alive(aHost.pid) && !!afterSwitch, aHost ? `old ${aHost.pid}` : 'no old host');
  const newHost = afterSwitch && hostOf(afterSwitch, 'feat/a');
  const asked = !!newHost && !!(await recordEnv(newHost));
  const second = asked && startsIn(featA).length >= 2 ? startsIn(featA)[1] : null;
  check('the new claude was started WITHOUT CLAUDE_CONFIG_DIR (the default account: the variable is unset)', !!second && second.cfg === '%CLAUDE_CONFIG_DIR%', JSON.stringify(second));
  const devStarts = startsIn(dev).length;
  check("develop's session was left alone by feat/a's switch", devStarts === 1, `${devStarts} start(s)`);
  const sAfter = await waitFor(async () => { const x = await state(app); return x.viewDom && x.viewDom.profileChip && x.viewDom.profileChip.text === 'Default' ? x : null; }, 30000, 400);
  check("feat/a's chip now reads Default, with no profile colour", !!sAfter && sAfter.viewDom.profileChip.colour === null, sAfter ? JSON.stringify(sAfter.viewDom.profileChip) : 'no chip');
  check("feat/a's strip dot is gone (the default has none)", !!sAfter && !!domOf(sAfter, 'feat/a') && domOf(sAfter, 'feat/a').profileDot === null);

  // ===== remember =====
  const saved = profilesLib.readChoices(profilesLib.choicesFile(profilesDir));
  check('the pick is saved: the choices file names feat/a -> default and keeps develop -> work',
    saved.state === 'ok' && saved.choices.byWorktree[keyOf(featA)] === 'default' && saved.choices.byWorktree[keyOf(dev)] === workId, JSON.stringify(saved));

  // ===== sessions: a profile that never ran a session =====
  {
    const taskLogsFs = require(path.join(ROOT, 'host', 'task-logs-fs'));
    const defaultCfg = path.join(tmp, 'default-cfg');
    fs.mkdirSync(path.join(defaultCfg, 'sessions'), { recursive: true });
    const profileCfgs = [cfgWork, cfgPlay];
    const reg = await taskLogsFs.readRegistries(taskLogsFs.registryDirs([], () => defaultCfg, profileCfgs), undefined, taskLogsFs.profileRegistryDirs(profileCfgs));
    check('a profile with no sessions folder yet does not make the task-log registry unreadable (the same call main makes)', reg.ok === true, JSON.stringify(reg));
  }

  // ===== port: a reused port =====
  {
    const aNow = hostOf(await state(app), 'feat/a');
    const P = aNow && aNow.port;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${P}.json`), 'utf8')); } catch { /* reported below */ }
    const procStart = require(path.join(ROOT, 'host', 'proc-start'));
    const { killProvenAsync } = require(path.join(ROOT, 'host', 'kill-tree'));
    // the stranger: a live process of its own that stands in for another folder's host
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    noteChild(stranger);
    const strangerStart = ((await procStart.startTimes([stranger.pid])) || new Map()).get(stranger.pid);
    let decoy = null;
    const idFile = path.join(HARNESS_DIR, 'hosts', `${P}.json`);
    try {
      check('the setup for the reused port exists (feat/a\'s identity file, a stranger with a start time)', !!raw && !!strangerStart, JSON.stringify({ P, raw: !!raw, strangerStart }));
      if (raw && strangerStart) {
        // feat/a's own host dies, and the stranger takes the port at once (before the next poll could notice)
        const k = await killProvenAsync(raw.pid, raw.processStartedAt);
        decoy = net.createServer((sock) => sock.destroy());
        let listening = false;
        for (let i = 0; i < 100 && !listening; i++) {
          listening = await new Promise((resolve) => { decoy.once('error', () => resolve(false)); decoy.listen(P, '127.0.0.1', () => resolve(true)); });
          if (!listening) await sleep(30);
        }
        fs.writeFileSync(idFile, JSON.stringify({ port: P, cwd: path.join(tmp, 'some-other-project'), pid: stranger.pid, startedAt: Date.now(), processStartedAt: strangerStart }));
        check('feat/a\'s own host was ended and the stranger holds its port', k === 'killed' && listening, `kill ${k}, listening ${listening}`);
        const strangerAsks = (await state(app)).profileAsks.length;
        const r = await command(app, { cmd: 'profile', label: 'feat/a', id: workId }, 90000);
        check('switching feat/a to work succeeds, and does NOT touch the stranger', r.ok === true && alive(stranger.pid), JSON.stringify(r) + ` stranger alive ${alive(stranger.pid)}`);
        const after = await waitFor(async () => { const x = await state(app); const h = hostOf(x, 'feat/a'); return h && h.pid && h.pid !== raw.pid && h.pid !== stranger.pid && alive(h.pid) ? x : null; }, 60000, 400);
        remember(after);
        check('feat/a restarted under work on a port of its own', !!after && hostOf(after, 'feat/a').port !== P && after.profileOf['feat/a'] === workId, after ? JSON.stringify(hostOf(after, 'feat/a')) : 'no new host');
        const nh = after && hostOf(after, 'feat/a');
        const got = !!nh && !!(await recordEnv(nh));
        const last = got ? startsIn(featA).pop() : null;
        check('and its claude got the work profile\'s folder', !!last && sameDir(last.cfg, cfgWork), JSON.stringify(last));
        void strangerAsks;
      }
    } finally {
      try { if (decoy) decoy.close(); } catch { /* ours */ }
      try { stranger.kill(); } catch { /* ours */ }
      try { const cur = JSON.parse(fs.readFileSync(idFile, 'utf8')); if (cur.pid === stranger.pid) fs.unlinkSync(idFile); } catch { /* already replaced or gone */ }
    }
  }

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
    console.log(`\n${failures} FAILED -- the app or a host did not start, so the rest was never measured`);
    process.exit(1);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
