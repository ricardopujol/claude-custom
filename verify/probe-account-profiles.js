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
 *   env        each tab's `claude` is started with CLAUDE_CONFIG_DIR = its profile's folder (the stub `claude` writes what it saw)
 *   chip       the header chip of each tab's page reads that tab's profile name, tinted with its colour
 *   dot        the strip paints a coloured dot on both tabs (neither is the default)
 *   accounts   the Style panel's Accounts section drew a row for the default and for each profile
 *   switch     picking the default on feat-a (as the chip menu's click does): main asked "Restart this session as Default?",
 *              the old host is gone, a new host starts WITHOUT CLAUDE_CONFIG_DIR, the chip reads Default, the dot goes
 *   remember   the pick is saved: the choices file names feat-a -> default
 *
 * SAFE. Every host's `claude` is a stub .cmd (CLAUDE_CUSTOM_BIN), so nothing runs that bills and no login is needed. The app is driven
 * through CLAUDE_CUSTOM_TABS_PROBE (app/main.js), which does nothing when unset. The profiles dir, registry, portraits and uploads are
 * temp folders. Every process it started is ended through host/kill-tree.js by pid AND start time (verify/lib/seen-pids.js), never by name.
 * WINDOWS ONLY (cmd.exe).
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
const seenDir = path.join(tmp, 'seen');                  // what each stub `claude` saw
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
 * The stub `claude`: writes the folder it runs in and the CLAUDE_CONFIG_DIR it was given (cmd leaves an unset variable as the literal
 * %CLAUDE_CONFIG_DIR%), then waits. One file per start, so a restart shows as a second file for the same folder.
 */
function makeStub() {
  fs.mkdirSync(seenDir, { recursive: true });
  const stub = path.join(tmp, 'claude-stub.cmd');
  const lines = [
    '@echo off',
    'setlocal',
    '>"%CC_PROBE_SEEN%\\seen-%RANDOM%%RANDOM%.txt" echo CWD=%CD%^|CFG=%CLAUDE_CONFIG_DIR%',
    'ping -n 600 127.0.0.1 >nul',
  ];
  fs.writeFileSync(stub, lines.join('\r\n') + '\r\n');
  return stub;
}

/** Every start the stub recorded: [{ cwd, cfg }] in the order the files were written. */
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
async function launchApp(cwd, stub) {
  windowNo++;
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: stub,
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_PROFILES_DIR: profilesDir,
    CC_PROBE_SEEN: seenDir,
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
  const stub = makeStub();

  // Two profiles and a saved choice per tab, written through the real store so the file is what the app writes.
  fs.mkdirSync(profilesDir, { recursive: true });
  let store = { version: 1, profiles: [] };
  store = profilesLib.addProfile(store, { name: 'Work', colour: '#4c8bf5', configDir: cfgWork }, { home: tmp }).store;
  store = profilesLib.addProfile(store, { name: 'Play', colour: '#4caf6a', configDir: cfgPlay }, { home: tmp }).store;
  profilesLib.writeProfiles(profilesLib.profilesFile(profilesDir), store);
  const keyOf = (p) => require(path.join(ROOT, 'host', 'project-layout')).normPath(p);
  let choices = profilesLib.emptyChoices();
  choices = profilesLib.remember(choices, { worktree: keyOf(dev), project: keyOf(container) }, 'work');
  choices = profilesLib.remember(choices, { worktree: keyOf(featA), project: keyOf(container) }, 'play');
  profilesLib.writeChoices(profilesLib.choicesFile(profilesDir), choices);

  const app = await launchApp(container, stub);
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
  const devStart = await waitFor(() => startsIn(dev)[0] || null, 30000, 300);
  const aStart = await waitFor(() => startsIn(featA)[0] || null, 30000, 300);
  check("develop's claude was started with CLAUDE_CONFIG_DIR = the work profile's folder", !!devStart && sameDir(devStart.cfg, cfgWork), JSON.stringify(devStart));
  check("feat/a's claude was started with CLAUDE_CONFIG_DIR = the play profile's folder", !!aStart && sameDir(aStart.cfg, cfgPlay), JSON.stringify(aStart));
  check('the two tabs got different folders', !!devStart && !!aStart && !sameDir(devStart.cfg, aStart.cfg));
  check("the shell holds each tab's profile id", s.profileOf && s.profileOf.develop === 'work' && s.profileOf['feat/a'] === 'play', JSON.stringify(s.profileOf));

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
  const picked = await command(app, { cmd: 'profile', label: 'feat/a', id: 'default' }, 90000);
  check('picking the default on feat/a restarted it', picked.ok === true && picked.restarted === true, JSON.stringify(picked));
  const afterSwitch = await waitFor(async () => {
    const x = await state(app);
    const h = hostOf(x, 'feat/a');
    return h && aHost && h.pid !== aHost.pid && alive(h.pid) && tabOf(x, 'feat/a').started ? x : null;
  }, 60000, 400);
  remember(afterSwitch);
  check('main asked "Restart this session as Default?" before ending the live session',
    !!afterSwitch && afterSwitch.profileAsks.length === asksBefore + 1 && /^Restart this session as Default\?/.test(afterSwitch.profileAsks[asksBefore]),
    afterSwitch ? JSON.stringify(afterSwitch.profileAsks) : 'no state');
  check('the old host is gone and a new one serves feat/a', !!aHost && !alive(aHost.pid) && !!afterSwitch, aHost ? `old ${aHost.pid}` : 'no old host');
  const second = await waitFor(() => (startsIn(featA).length >= 2 ? startsIn(featA)[1] : null), 30000, 300);
  check('the new claude was started WITHOUT CLAUDE_CONFIG_DIR (the default account)', !!second && second.cfg === "", JSON.stringify(second));
  const devStarts = startsIn(dev).length;
  check("develop's session was left alone by feat/a's switch", devStarts === 1, `${devStarts} start(s)`);
  await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
  const sAfter = await waitFor(async () => { const x = await state(app); return x.viewDom && x.viewDom.profileChip && x.viewDom.profileChip.text === 'Default' ? x : null; }, 30000, 400);
  check("feat/a's chip now reads Default, with no profile colour", !!sAfter && sAfter.viewDom.profileChip.colour === null, sAfter ? JSON.stringify(sAfter.viewDom.profileChip) : 'no chip');
  check("feat/a's strip dot is gone (the default has none)", !!sAfter && !!domOf(sAfter, 'feat/a') && domOf(sAfter, 'feat/a').profileDot === null);

  // ===== remember =====
  const saved = profilesLib.readChoices(profilesLib.choicesFile(profilesDir));
  check('the pick is saved: the choices file names feat/a -> default and keeps develop -> work',
    saved.state === 'ok' && saved.choices.byWorktree[keyOf(featA)] === 'default' && saved.choices.byWorktree[keyOf(dev)] === 'work', JSON.stringify(saved));

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
