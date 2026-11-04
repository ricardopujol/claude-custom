'use strict';
/**
 * PROBE: a tab whose host won't stop is KEPT, with a Stop offer, in a REAL window (BACKLOG #129, PR #231). (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-tab-close-kept.js      (exit 0 = every check held)
 *   TAB_KEPT_PROBE_PNG=<file>                                                where the picture of the strip goes
 *
 * The unit tests pin the shell's decisions with a fake `stopByPid` and a fake strip. This runs the real parts: the real tab
 * shell and strip page in a real window, the real host-client `stop` frame, the real host/stop-by-pid.js reading a real
 * identity file, and the real host/kill-tree.js killProvenAsync proving a pid by its OS start time.
 *
 * The host is a stand-in (verify/lib/stubborn-host.js): a real process with a real pid that says hello, takes the stop frame
 * and never answers or exits. The probe writes its identity file itself, so it chooses the start time the file names:
 *
 *   feat/a  the file names a WRONG start time: the stop times out, the retry by pid is refused as another process
 *           -> the tab is KEPT, the notice and the Stop button are in the strip's alert line, the stand-in is alive,
 *              and the strip is saved as a PNG;
 *           then the file is corrected, Stop is clicked (a real click on the button)
 *           -> the real stop-by-pid path proves the pid and ends the stand-in, and the tab goes.
 *   feat/b  the file names a wrong start time and stays wrong: a close, and a Stop after it, each keep the tab
 *           and kill nothing (the negative: a live pid whose start doesn't match is not ours to end).
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN); CLAUDE_CUSTOM_WORKTREE_SCRIPTS points at an empty folder; the
 * project is a temp folder; the only processes stopped are the window it started, hosts whose folder is inside the temp folder
 * and the two stand-ins it started, all by PID with a start time proven. A normal window, never offscreen (capturePage hangs).
 */

const { execFileSync, spawn } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity, writeIdentity, fileFor } = require(path.join(ROOT, 'host', 'host-identity'));
const { startTimes } = require(path.join(ROOT, 'host', 'proc-start'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-tabkept-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const origin = path.join(tmp, 'origin.git');
const userData = path.join(tmp, 'user-data');
const scripts = path.join(tmp, 'no-scripts');
const shots = path.join(tmp, 'shots');
const PNG = process.env.TAB_KEPT_PROBE_PNG || 'C:\\Users\\ricar\\AppData\\Local\\Temp\\cc-try\\pr231-stop-offer.png';
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(scripts, { recursive: true });
fs.mkdirSync(path.dirname(PNG), { recursive: true });

let failures = 0;
let passes = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (ok) passes++; else failures++;
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

// A port in the range the shell walks (host/port-for-project.js: 7700-7799), free now; the top of it, away from the hashed ones.
async function hostRangePort(taken) {
  for (let p = 7799; p >= 7700; p--) {
    if (taken.includes(p)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error('no free port in 7700-7799');
}

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

// Pids seen, each with a start time recorded while it was known to be ours: ended only through a proven start.
const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const standIns = [];       // { label, port, token, child, pid, start, cwd }
function killEverything() {
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { files = []; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) seenPids.add(id.pid, id.processStartedAt);
  }
  seenPids.endAll();
  // The files the probe wrote for its stand-ins, with the pids gone: nothing may name a stand-in's port afterwards.
  for (const s of standIns) {
    for (const f of [fileFor(HARNESS_DIR, s.port), path.join(HARNESS_DIR, 'hosts', `${s.port}.token`)]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid) && !standIns.some(s => s.pid === h.pid)) seenPids.see(h.pid);
  return st;
};
const tabLabels = (st) => ((st && st.tabs) || []).map(t => t.label);
const alertOf = (st) => (st && st.stripChrome && st.stripChrome.alert) || null;
const hasStop = (st) => !!(st && st.stripChrome && st.stripChrome.stop === true);
const isAlive = (s) => { try { process.kill(s.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Alive AND the process that started then (a pid alone proves nothing on Windows).
async function aliveAsItself(s) {
  if (!isAlive(s)) return false;
  const m = await startTimes([s.pid]);
  return !!m && m.get(s.pid) === s.start;
}

/** Start a stubborn stand-in for `label`'s folder and write the identity + token files that make the shell attach to it. */
async function startStandIn(label, dirName, taken) {
  const port = await hostRangePort(taken);
  const token = require('crypto').randomBytes(16).toString('hex');
  const child = spawn(process.execPath, [path.join(__dirname, 'lib', 'stubborn-host.js'), String(port)], { stdio: 'ignore', windowsHide: true });
  noteChild(child);
  const s = { label, port, token, child, pid: child.pid, start: null, cwd: path.join(container, dirName) };
  standIns.push(s);
  const up = await waitFor(() => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
  }), 15000, 200);
  if (!up) throw new Error(`the stand-in for ${label} never listened on ${port}`);
  const starts = await startTimes([s.pid]);
  s.start = starts && starts.get(s.pid);
  if (typeof s.start !== 'string') throw new Error(`no start time for the stand-in's pid ${s.pid}`);
  seenPids.add(s.pid, s.start);
  fs.mkdirSync(path.join(HARNESS_DIR, 'hosts'), { recursive: true });
  fs.writeFileSync(path.join(HARNESS_DIR, 'hosts', `${port}.token`), token);
  return s;
}

// A start that is NOT this process's: an hour later, in FILETIME ticks (100 ns).
const wrongStart = (start) => String(BigInt(start) + 36000000000n);
const writeIdentityFor = (s, processStartedAt) => writeIdentity({ dir: HARNESS_DIR, port: s.port, cwd: s.cwd, pid: s.pid, processStartedAt });

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'remote', 'add', 'origin', origin);
  git(dev, 'push', '-q', 'origin', 'develop');
  for (const [dir, branch] of [['feat-a', 'feat/a'], ['feat-b', 'feat/b']]) {
    git(dev, 'worktree', 'add', '-q', path.join(container, dir), '-b', branch);
  }

  // The stand-ins first: the window attaches to a host that is already there.
  const a = await startStandIn('feat/a', 'feat-a', []);
  const b = await startStandIn('feat/b', 'feat-b', [a.port]);
  writeIdentityFor(a, wrongStart(a.start));
  writeIdentityFor(b, wrongStart(b.start));
  check('0: two stand-in hosts are running, each a real pid with a start time, and each identity file names a WRONG start',
    (await aliveAsItself(a)) && (await aliveAsItself(b)), `a=${a.pid}@${a.port} b=${b.pid}@${b.port}`);

  const app = await launchApp(container);
  const up = await waitFor(async () => {
    const st = await stateOf(app);
    const h = (st && st.hosts) || [];
    const att = (l, s) => h.some(x => x.label === l && x.started === true && x.port === s.port);
    return st && tabLabels(st).length === 3 && att('feat/a', a) && att('feat/b', b) ? st : null;
  }, 60000);
  check('1: the window is up and feat/a and feat/b are attached to the stand-ins', !!up, up ? '' : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!up) return;
  await sleep(1500);

  // --- feat/a: a close whose stop is never answered and whose pid can't be proved ---------------------------------------
  // A stand-in reports nothing a strip counts as "running", so the lane would sit in the Lanes menu: select it, as a person
  // looking at the tab they are about to close has.
  await command(app, { cmd: 'select', label: 'feat/a' });
  await sleep(800);
  const x = await command(app, { cmd: 'xClick', label: 'feat/a' });
  check('2: a real click on feat/a\'s x', x.ok === true, JSON.stringify(x));
  const kept = await waitFor(async () => { const s = await stateOf(app); return hasStop(s) ? s : null; }, 30000, 500);
  check('3: the strip shows the Stop button (the stop timed out and the pid retry was refused)', !!kept, kept ? '' : JSON.stringify((await stateOf(app)).stripChrome));
  if (!kept) return;
  check('3: ...the tab is still there', tabLabels(kept).includes('feat/a'), JSON.stringify(tabLabels(kept)));
  check('3: ...with the notice naming feat/a and saying it may still be running',
    /Couldn't end the session in feat\/a: .*It may still be running\./.test(alertOf(kept) || ''), alertOf(kept));
  check('3: ...on the strip itself, not hidden in the Lanes menu', (kept.stripKeys || []).some(k => /feat-a$/i.test(k)), JSON.stringify(kept.stripKeys));
  check('3: ...and the Stop button is drawn inside the alert line, not clipped off its end', kept.stripChrome.stopInView === true, JSON.stringify(kept.stripChrome.stopInView));
  check('3: ...and the stand-in was not killed by the wrong start time', await aliveAsItself(a));
  check('3: ...nor offered back by Reopen, since it never closed', !(kept.reopenable || []).some(r => /feat\/a|feat-a/i.test(JSON.stringify(r))), JSON.stringify(kept.reopenable));
  check('3: ...and the question was asked once', (kept.confirms || []).length === 1, JSON.stringify(kept.confirms));
  await sleep(500);
  const shot = await command(app, { cmd: 'screenshot', file: path.join(shots, 'stop-offer.png') });
  const stripFile = shot && shot.stripFile;
  check('4: the strip is captured (a normal window, not offscreen)', shot.ok === true && shot.stripBytes > 1000 && !!stripFile && fs.existsSync(stripFile), JSON.stringify(shot));
  if (stripFile && fs.existsSync(stripFile)) fs.copyFileSync(stripFile, PNG);
  check('4: ...and saved at the requested path', fs.existsSync(PNG) && fs.statSync(PNG).size > 1000, PNG);

  // The identity file now tells the truth about the stand-in, as a host's own would. Stop: the REAL stop-by-pid path.
  writeIdentityFor(a, a.start);
  const click = await command(app, { cmd: 'stopClick' });
  check('5: a real click on the Stop button', click.ok === true, JSON.stringify(click));
  const gone = await waitFor(async () => { const s = await stateOf(app); return !tabLabels(s).includes('feat/a') ? s : null; }, 30000, 500);
  check('5: the tab goes', !!gone, JSON.stringify(tabLabels(await stateOf(app))));
  const dead = await waitFor(async () => (await aliveAsItself(a)) ? null : true, 15000, 300);
  check('5: ...and the stand-in was ended through the proven pid (it is no longer the process that started then)', !!dead);
  const after = await stateOf(app);
  check('5: ...the Stop button and the notice are gone, and nothing asked a second time',
    !hasStop(after) && alertOf(after) === null && (after.confirms || []).length === 1, JSON.stringify({ stop: after.stripChrome && after.stripChrome.stop, alert: alertOf(after), confirms: after.confirms }));
  check('5: ...feat/b is untouched', tabLabels(after).includes('feat/b') && await aliveAsItself(b));

  // --- feat/b: the negative. A live pid whose start doesn't match is not ours to end ----------------------------------------
  // feat/a's tab fades out first; the strip repaints around feat/b meanwhile, so its x may not be there on the first try.
  await command(app, { cmd: 'select', label: 'feat/b' });
  await sleep(800);
  let xb = { ok: false };
  await waitFor(async () => { xb = await command(app, { cmd: 'xClick', label: 'feat/b' }); return xb.ok === true; }, 15000, 500);
  check('6: a real click on feat/b\'s x', xb.ok === true, xb.ok === true ? '' : JSON.stringify({ xb, dom: (await stateOf(app)).stripDom, tabs: (await stateOf(app)).tabs }));
  const keptB = await waitFor(async () => { const s = await stateOf(app); return hasStop(s) ? s : null; }, 30000, 500);
  check('6: the tab is kept with its notice and Stop button', !!keptB && tabLabels(keptB).includes('feat/b') && /feat\/b/.test(alertOf(keptB) || ''), keptB ? alertOf(keptB) : 'no Stop button');
  check('6: ...and the stand-in is alive: a pid whose start time does not match is killed by nothing', await aliveAsItself(b));
  const clickB = await command(app, { cmd: 'stopClick' });
  await sleep(6000);        // the stop frame times out (3 s) and the pid retry is refused again
  const stillB = await stateOf(app);
  check('6: Stop on it, with the file still wrong, keeps the tab again and kills nothing',
    clickB.ok === true && tabLabels(stillB).includes('feat/b') && hasStop(stillB) && await aliveAsItself(b), JSON.stringify({ click: clickB, labels: tabLabels(stillB), stop: hasStop(stillB) }));

  await command(app, { cmd: 'quit' });
}

main().catch((err) => { console.log(`FAIL  probe crashed: ${(err && err.stack) || err}`); failures++; })
  .finally(async () => {
    for (const s of standIns) { try { seenPids.add(s.pid, s.start); } catch { /* none */ } }
    killEverything();
    await sleep(500);
    const left = [];
    for (const s of standIns) if (await aliveAsItself(s)) left.push(s.pid);
    if (left.length) { console.log(`FAIL  stand-in(s) still running: ${left.join(', ')}`); failures++; }
    console.log(failures === 0 ? `\nALL CHECKS HELD (${passes} passed)` : `\n${failures} CHECK(S) FAILED (${passes} passed)`);
    console.log(`png: ${PNG}`);
    process.exit(failures === 0 ? 0 : 1);
  });
