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
 * The host is a stand-in (verify/lib/stubborn-host.js): a real process with a real pid that never ends on its own. 'older' says hello
 * without the stop control, so the shell's stop fails at once; 'silent' takes the stop frame and never answers, so it times out and
 * the shell gives the host its shutdown bound before anything is done to it by pid. The probe writes each identity file itself, so it
 * chooses the start time the file names. The invariant: never a kill without proof that the process is THIS tab's host, and never a
 * dropped tab while its host may be live.
 *
 *   feat/a  (the lane name is long, on purpose) the file names NO start time: the stop fails and nothing can be proved
 *           -> the tab is KEPT, the long notice is clipped but the Stop button is inside the line, the stand-in is alive,
 *              and the strip is saved as a PNG;
 *           then the file is corrected and Stop is clicked (a real click on the button)
 *           -> the real stop-by-pid path proves the pid by its start time and ends the stand-in, and the tab goes.
 *   feat/b  the file names a start that is not that pid's (stale): that host is judged ended, the tab goes, and the live pid is
 *           NOT killed.
 *   feat/c  its host ends and ANOTHER folder's host binds its port, with a perfectly valid identity file (PR #231's Critical): closing
 *           feat/c sends nothing and kills nothing, and the stranger lives.
 *   feat/e  a host that takes the stop and never answers: while the shell waits the tab is in its closing state (greyed, 'Ending its
 *           session...'); after the bound it is kept with its Stop button, and the stand-in lives. (About a minute.)
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN); CLAUDE_CUSTOM_WORKTREE_SCRIPTS points at an empty folder; the
 * project is a temp folder; the only processes stopped are the window it started, hosts whose folder is inside the temp folder
 * and the stand-ins it started, all by PID with a start time proven. A normal window, never offscreen (capturePage hangs).
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
// A long lane name on purpose: the notice repeats it, and a long notice is what used to clip the Stop button off the end of the line (PR #231 Miguel Y2).
const A_BRANCH = 'feat/a-lane-with-a-deliberately-long-name-so-the-notice-is-long';
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
  if (m === null) return true;       // the query itself failed (a loaded machine): the pid is alive and nothing says it changed; never a false 'it died'
  return m.has(s.pid) && m.get(s.pid) === s.start;
}

/**
 * Start a stand-in for `label`'s folder and write the token file that makes the shell attach to it. `mode`: 'older' answers hello
 * without the stop control (a host of older code: the stop fails at once), 'silent' takes the stop frame and never answers
 * (it times out, and the shell then gives the host its shutdown bound before anything is done to it by pid).
 */
async function startStandIn(label, dirName, taken, { port: forcePort, mode = 'older' } = {}) {
  const port = forcePort || await hostRangePort(taken);
  const token = require('crypto').randomBytes(16).toString('hex');
  const child = spawn(process.execPath, [path.join(__dirname, 'lib', 'stubborn-host.js'), String(port), mode], { stdio: 'ignore', windowsHide: true });
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
// processStartedAt undefined: a file with no start time, which proves nothing ('unknown': nothing is killed and the tab is kept).
const writeIdentityFor = (s, processStartedAt) => writeIdentity({ dir: HARNESS_DIR, port: s.port, cwd: s.cwd, pid: s.pid, processStartedAt });

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'remote', 'add', 'origin', origin);
  git(dev, 'push', '-q', 'origin', 'develop');
  for (const [dir, branch] of [['feat-a', A_BRANCH], ['feat-b', 'feat/b'], ['feat-c', 'feat/c'], ['feat-e', 'feat/e']]) {
    git(dev, 'worktree', 'add', '-q', path.join(container, dir), '-b', branch);
  }

  // The stand-ins first: the window attaches to a host that is already there.
  const a = await startStandIn(A_BRANCH, 'feat-a', []);
  const b = await startStandIn('feat/b', 'feat-b', [a.port]);
  const c = await startStandIn('feat/c', 'feat-c', [a.port, b.port]);
  const e = await startStandIn('feat/e', 'feat-e', [a.port, b.port, c.port], { mode: 'silent' });
  writeIdentityFor(a, undefined);                   // no start time: nothing can be proved about it
  writeIdentityFor(b, wrongStart(b.start));         // a start that is not this process's: the file is stale
  writeIdentityFor(c, c.start);
  writeIdentityFor(e, undefined);
  check('0: four stand-in hosts are running, each a real pid with a start time; the files name no start (a, e), a wrong one (b), the right one (c)',
    (await Promise.all([a, b, c, e].map(aliveAsItself))).every(Boolean), `a=${a.pid}@${a.port} b=${b.pid}@${b.port} c=${c.pid}@${c.port} e=${e.pid}@${e.port}`);

  const app = await launchApp(container);
  const up = await waitFor(async () => {
    const st = await stateOf(app);
    const h = (st && st.hosts) || [];
    const att = (l, s) => h.some(x => x.label === l && x.started === true && x.port === s.port);
    return st && tabLabels(st).length === 5 && att(A_BRANCH, a) && att('feat/b', b) && att('feat/c', c) && att('feat/e', e) ? st : null;
  }, 60000);
  check('1: the window is up and feat/a, b, c and e are attached to the stand-ins', !!up, up ? '' : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!up) return;
  await sleep(1500);

  // --- feat/a: a stop that fails and a pid that can't be proved ----------------------------------------------------------------
  // A stand-in reports nothing a strip counts as "running", so the lane would sit in the Lanes menu: select it, as a person
  // looking at the tab they are about to close has.
  await command(app, { cmd: 'select', label: A_BRANCH });
  await sleep(800);
  const x = await command(app, { cmd: 'xClick', label: A_BRANCH });
  check('2: a real click on feat/a\'s x', x.ok === true, JSON.stringify(x));
  const kept = await waitFor(async () => { const s = await stateOf(app); return hasStop(s) ? s : null; }, 30000, 500);
  check('3: the strip shows the Stop button (the stop failed and the file proves nothing)', !!kept, kept ? '' : JSON.stringify((await stateOf(app)).stripChrome));
  if (!kept) return;
  check('3: ...the tab is still there', tabLabels(kept).includes(A_BRANCH), JSON.stringify(tabLabels(kept)));
  check('3: ...with the (long) notice naming the lane and saying it may still be running',
    alertOf(kept) !== null && alertOf(kept).startsWith(`Couldn't end the session in ${A_BRANCH}: `) && /It may still be running\./.test(alertOf(kept)), alertOf(kept));
  check('3: ...on the strip itself, not hidden in the Lanes menu', (kept.stripKeys || []).some(k => /feat-a$/i.test(k)), JSON.stringify(kept.stripKeys));
  check('3: ...and the Stop button is drawn inside the alert line, not clipped off its end, although the notice is too long to show whole', kept.stripChrome.stopInView === true && kept.stripChrome.textClipped === true, JSON.stringify({ inView: kept.stripChrome.stopInView, clipped: kept.stripChrome.textClipped }));
  check('3: ...and the stand-in was not killed', await aliveAsItself(a));
  check('3: ...nor offered back by Reopen, since it never closed', !(kept.reopenable || []).some(r => /feat\/a|feat-a/i.test(JSON.stringify(r))), JSON.stringify(kept.reopenable));
  check('3: ...and the question was asked once', (kept.confirms || []).length === 1, JSON.stringify(kept.confirms));
  await sleep(500);
  const shot = await command(app, { cmd: 'screenshot', file: path.join(shots, 'stop-offer.png') });
  const stripFile = shot && shot.stripFile;
  check('4: the strip is captured (a normal window, not offscreen)', shot.ok === true && shot.stripBytes > 1000 && !!stripFile && fs.existsSync(stripFile), JSON.stringify(shot));
  if (stripFile && fs.existsSync(stripFile)) fs.copyFileSync(stripFile, PNG);
  check('4: ...and saved at the requested path', fs.existsSync(PNG) && fs.statSync(PNG).size > 1000, PNG);

  // The identity file now says what a host's own would. Stop: the REAL stop-by-pid path, which proves the pid by its start time.
  writeIdentityFor(a, a.start);
  const click = await command(app, { cmd: 'stopClick' });
  check('5: a real click on the Stop button', click.ok === true, JSON.stringify(click));
  const gone = await waitFor(async () => { const s = await stateOf(app); return !tabLabels(s).includes(A_BRANCH) ? s : null; }, 30000, 500);
  check('5: the tab goes', !!gone, JSON.stringify(tabLabels(await stateOf(app))));
  const dead = await waitFor(async () => (await aliveAsItself(a)) ? null : true, 15000, 300);
  check('5: ...and the stand-in was ended through the proven pid (it is no longer the process that started then)', !!dead);
  const after = await stateOf(app);
  check('5: ...the Stop button and the notice are gone, and nothing asked a second time',
    !hasStop(after) && alertOf(after) === null && (after.confirms || []).length === 1, JSON.stringify({ stop: after.stripChrome && after.stripChrome.stop, alert: alertOf(after), confirms: after.confirms }));
  check('5: ...the other stand-ins are untouched', await aliveAsItself(b) && await aliveAsItself(c) && await aliveAsItself(e));

  // --- feat/b: a stale file. A live pid whose start doesn't match is not the host, and not ours to end ------------------------
  // feat/a's tab fades out first; the strip repaints around feat/b meanwhile, so its x may not be there on the first try.
  await command(app, { cmd: 'select', label: 'feat/b' });
  await sleep(800);
  let xb = { ok: false };
  await waitFor(async () => { xb = await command(app, { cmd: 'xClick', label: 'feat/b' }); return xb.ok === true; }, 15000, 500);
  check('6: a real click on feat/b\'s x', xb.ok === true, xb.ok === true ? '' : JSON.stringify({ xb, dom: (await stateOf(app)).stripDom, tabs: (await stateOf(app)).tabs }));
  const goneB = await waitFor(async () => { const s = await stateOf(app); return !tabLabels(s).includes('feat/b') ? s : null; }, 30000, 500);
  check('6: the file names a start that is not that pid\'s: the host is judged ended, the tab goes with no notice and no Stop button',
    !!goneB && alertOf(goneB) === null && !hasStop(goneB), goneB ? JSON.stringify({ alert: alertOf(goneB) }) : JSON.stringify(tabLabels(await stateOf(app))));
  check('6: ...and nothing was killed: the stand-in is alive', await aliveAsItself(b));

  // --- feat/c: its host ends, and another folder's host binds its port --------------------------------------------------------
  c.child.kill();                                   // its own process, by the handle this probe holds
  await waitFor(async () => !(await aliveAsItself(c)), 15000, 300);
  try { fs.unlinkSync(fileFor(HARNESS_DIR, c.port)); } catch { /* a host removes its own file on the way out */ }
  const ended = await waitFor(async () => { const s = await stateOf(app); return (s.tabs || []).some(t => t.label === 'feat/c' && t.ended === true) ? s : null; }, 30000, 500);
  check('7: the poll sees feat/c\'s host end', !!ended);
  const d = await startStandIn('feat/d', 'feat-d', [], { port: c.port });      // a host of ANOTHER folder takes the freed port, with a valid file
  writeIdentityFor(d, d.start);
  check('7: another folder\'s host holds feat/c\'s old port, and its identity file is valid', d.port === c.port && await aliveAsItself(d) && readIdentity({ dir: HARNESS_DIR, port: d.port }).cwd === d.cwd);
  await command(app, { cmd: 'select', label: 'feat/c' });
  const xc = await command(app, { cmd: 'xClick', label: 'feat/c' });
  const goneC = await waitFor(async () => { const s = await stateOf(app); return !tabLabels(s).includes('feat/c') ? s : null; }, 30000, 500);
  check('7: closing the dead tab closes it, with no notice and no Stop button', xc.ok === true && !!goneC && alertOf(goneC) === null && !hasStop(goneC), JSON.stringify({ xc, alert: goneC && alertOf(goneC) }));
  await sleep(1500);
  check('7: ...and the other folder\'s live host was NOT killed', await aliveAsItself(d));

  // --- feat/e: a host that takes the stop and never answers: the tab is in a closing state while the shell waits ------------------
  await command(app, { cmd: 'select', label: 'feat/e' });
  await sleep(800);
  const xe = await command(app, { cmd: 'xClick', label: 'feat/e' });
  check('8: a real click on feat/e\'s x', xe.ok === true, JSON.stringify(xe));
  const closingE = await waitFor(async () => { const s = await stateOf(app); return (s.tabs || []).some(t => t.label === 'feat/e' && t.ending === true) ? s : null; }, 15000, 250);
  check('8: while the stop is waited on, the tab is in its closing state and the strip says so', !!closingE && alertOf(closingE) === 'Ending its session…', closingE ? alertOf(closingE) : 'never ending');
  check('8: ...greyed in the strip', !!closingE && (closingE.stripDom || []).some(t => t.label === 'feat/e' && t.dim === true));
  const keptE = await waitFor(async () => { const s = await stateOf(app); return hasStop(s) ? s : null; }, 120000, 1000);
  check('8: after the host\'s shutdown bound the tab is kept with its Stop button (the file proves nothing)', !!keptE && tabLabels(keptE).includes('feat/e') && /feat\/e/.test(alertOf(keptE) || ''), keptE ? alertOf(keptE) : 'no Stop button');
  const eAlive = await aliveAsItself(e);
  const stillEnding = !!keptE && (keptE.tabs || []).filter(t => t.ending === true).map(t => t.label);
  check('8: ...the closing state is over, and the stand-in was not killed', !!keptE && stillEnding.length === 0 && eAlive, JSON.stringify({ stillEnding, eAlive }));

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
