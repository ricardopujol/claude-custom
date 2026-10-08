'use strict';
/**
 * PROBE: a tab that needs you or finished pulses (#31) in a REAL window with REAL hosts.
 * (re-runnable)
 *
 *   node verify/probe-strip-pulse.js            (exit 0 = every check held)
 *   STRIP_PULSE_PROBE_SHOTS=<dir>                also keep screenshots there
 *
 * The unit tests pin the model and the CSS text; no unit test can see Chromium run a keyframe, or
 * the whole path a hook takes: hook event -> host attention -> the tab's page -> tab:status -> the
 * shell's model -> the strip's class. This sends a REAL hook event line down a host's named pipe
 * (what the native helper does) to a tab that isn't selected, and reads the strip's own DOM:
 *
 *   1  nothing pulses at rest
 *   2  a Stop (the session finished) makes the other tab pulse its calm look: class, a running
 *      animation named tab-pulse-done, and a background that CHANGES between samples
 *   3  a Notification (permission_prompt, needs you) switches it to the urgent look
 *   4  the selected tab never pulses
 *   5  selecting the pulsing tab ends the pulse, and it stays ended after selecting away
 *   7  a tab that finished while selected, window behind, then the window comes back: leaving the tab
 *      does not make it pulse (with a control that it does without the focus event, when the OS
 *      window really is unfocused)
 *   8  Ctrl+Alt+T opens New branch… in tabs mode; plain Ctrl+T (the CLI's own) does not
 *   6  under prefers-reduced-motion (a second launch with --force-prefers-reduced-motion) the same
 *      events give a steady highlight: the class is there, the animation is none, the background
 *      is not the plain strip colour and does not change between samples
 *
 * SAFE. The hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE
 * is deleted along with every CLAUDE_CUSTOM_* the probe doesn't set; registry, portraits, uploads
 * and user data are temp folders; the repo is a temp git repo. Every host whose folder is inside
 * the probe's temp folder is killed at the end.
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
const tmp = tmpDir('cc-probe-pulse-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const shots = process.env.STRIP_PULSE_PROBE_SHOTS || path.join(tmp, 'shots');
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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

async function launchApp(cwd, extraArgs = []) {
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
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`, ...extraArgs], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }   // kill-ok: a host pid from an identity file or the app state, no handle held (the seenPids class, PR #130 follow-up)
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

async function stateOf(app) {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
  return st;
}
const tabOf = (st, label) => (Array.isArray(st && st.stripDom) ? st.stripDom.find(t => t.label === label) || null : null);
const hostPidOf = (st, label) => {
  const h = ((st && st.hosts) || []).find(x => x.label === label);
  return h && Number.isInteger(h.pid) ? h.pid : null;
};

// What the native hook helper does: one JSON line down the host's named pipe.
function fireHook(pid, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
}

const pulseOf = async (app, label) => (tabOf(await stateOf(app), label) || {}).pulse || null;
const pulseIs = (app, label, want) => waitFor(async () => {
  const t = tabOf(await stateOf(app), label);
  return t && (t.pulse || null) === want ? t : null;
}, 15000);

// Background colours of one tab over ~1.6 s: moving or still?
async function sampleBg(app, label, n = 8, gap = 200) {
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const t = tabOf(await stateOf(app), label);
    if (t) seen.add(t.bg);
    await sleep(gap);
  }
  return [...seen];
}

// Both tabs started (a view each), `develop` selected, feat/a in the background.
async function bothStarted(app) {
  const up = await waitFor(async () => (tabOf(await stateOf(app), 'feat/a') ? true : null), 45000);
  if (!up) return null;
  // A started tab has a view, but its page is still loading and hasn't joined its host: an event
  // fired before that is heard by nobody. So each is left selected until its terminal is drawn.
  const pageUp = () => waitFor(async () => {
    const v = (await stateOf(app)).viewDom;
    return v && v.hasTerm === true && v.xterm > 0 ? true : null;
  }, 30000);
  const a = await command(app, { cmd: 'select', label: 'feat/a' });
  if (!(a && a.ok && a.started && await pageUp())) return null;
  const d = await command(app, { cmd: 'select', label: 'develop' });
  if (!(d && d.ok && d.started && await pageUp())) return null;
  await sleep(1500);   // and its socket has opened
  return waitFor(async () => {
    const st = await stateOf(app);
    return hostPidOf(st, 'feat/a') && hostPidOf(st, 'develop') && tabOf(st, 'develop').selected ? st : null;
  }, 20000);
}

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');

  // ---- the normal launch -----------------------------------------------------------
  const app = await launchApp(container);
  const ready = await bothStarted(app);
  check('the window came up with both tabs started', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const aPid = hostPidOf(ready, 'feat/a');

  check('1: nothing pulses at rest', (await pulseOf(app, 'feat/a')) === null && (await pulseOf(app, 'develop')) === null);

  // 2 ---------------------------------------------------------------------------------
  check('2: the hook line was delivered to feat/a\'s host', await fireHook(aPid, 'Stop', {}));
  const done = await pulseIs(app, 'feat/a', 'pulse-done');
  check('2: a finished session makes the background tab pulse its calm look', !!done, JSON.stringify(tabOf(await stateOf(app), 'feat/a')));
  check('2: ...with the calm keyframes actually running', !!done && done.anim === 'tab-pulse-done', done ? done.anim : '');
  const doneBg = await sampleBg(app, 'feat/a');
  check('2: ...and its background really moves between samples', doneBg.length > 1, JSON.stringify(doneBg));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-done.png') });

  // 3 ---------------------------------------------------------------------------------
  await fireHook(aPid, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const needs = await pulseIs(app, 'feat/a', 'pulse-needs');
  check('3: a session that needs you switches it to the urgent look', !!needs, JSON.stringify(tabOf(await stateOf(app), 'feat/a')));
  check('3: ...with the urgent keyframes running', !!needs && needs.anim === 'tab-pulse-needs', needs ? needs.anim : '');
  await command(app, { cmd: 'screenshot', file: path.join(shots, '3-needs.png') });

  // 4 ---------------------------------------------------------------------------------
  const sel = tabOf(await stateOf(app), 'develop');
  check('4: the selected tab never pulses', !!sel && sel.selected === true && sel.pulse === null && sel.anim === 'none', JSON.stringify(sel));

  // 5 ---------------------------------------------------------------------------------
  await command(app, { cmd: 'select', label: 'feat/a' });
  const calm = await pulseIs(app, 'feat/a', null);
  check('5: selecting the pulsing tab ends the pulse', !!calm, JSON.stringify(tabOf(await stateOf(app), 'feat/a')));
  await command(app, { cmd: 'select', label: 'develop' });
  await sleep(1500);
  check('5: ...and it stays ended after selecting away', (await pulseOf(app, 'feat/a')) === null);

  // 7 (PR #90 Dexter F1) ----------------------------------------------------------------
  // A tab finishes while it is selected and the window is behind: leaving it later must not make
  // it pulse, because the window coming back WAS the look. The OS may or may not hold focus for
  // this window (it is spawned in the background), so the first round is a control: with focus
  // really away and no focus event, leaving the tab does pulse -- which proves the scenario
  // is real. The second round brings the window back and expects nothing.
  const osFocus = await command(app, { cmd: 'windowFocus' });   // also settles any earlier flag
  const watched = async (bringBack) => {
    await sleep(4500);   // one Stop per 4 s per host
    await command(app, { cmd: 'select', label: 'feat/a' });
    await waitFor(async () => (tabOf(await stateOf(app), 'feat/a') || {}).selected, 5000);
    await fireHook(aPid, 'Stop', {});
    await sleep(2000);
    if (bringBack) await command(app, { cmd: 'windowFocus' });
    await sleep(500);
    await command(app, { cmd: 'select', label: 'develop' });
    await sleep(2000);
    return pulseOf(app, 'feat/a');
  };
  if (osFocus && osFocus.osFocused === false) {
    const without = await watched(false);
    check('7: control: finished while selected, window behind, no focus event -> it pulses after leaving', without === 'pulse-done', String(without));
    await command(app, { cmd: 'select', label: 'feat/a' });   // look at it, to clear
    await command(app, { cmd: 'select', label: 'develop' });
  } else {
    console.log('  (the window holds OS focus in this run, so the control is skipped: the focused report clears it by itself)');
  }
  const back = await watched(true);
  check('7: finished while selected, then the window comes back, then leaving the tab: no pulse', back === null, String(back));

  // 8 (#35, PR #90 Dexter F2) ---------------------------------------------------------------
  await command(app, { cmd: 'key', key: 't', modifiers: ['control'] });
  await sleep(600);
  const plainT = await stateOf(app);
  check('8: plain Ctrl+T does not open the form (it is the CLI\'s key)', plainT.create === null && plainT.stripChrome.form === false,
    JSON.stringify({ create: plainT.create, form: plainT.stripChrome.form }));
  await command(app, { cmd: 'key', key: 't', modifiers: ['control', 'alt'] });
  const opened = await waitFor(async () => {
    const st = await stateOf(app);
    return st.create && st.create.phase === 'input' && st.stripChrome.form === true ? st : null;
  }, 8000);
  check('8: Ctrl+Alt+T opens New branch… in tabs mode', !!opened, JSON.stringify((await stateOf(app)).create));
  await command(app, { cmd: 'cancelCreate' });

  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);

  // ---- reduced motion: the same events, a steady highlight ---------------------------
  await sleep(4500);   // the hosts keep each kind of attention to one per 4 s
  const calmApp = await launchApp(container, ['--force-prefers-reduced-motion']);
  const again = await bothStarted(calmApp);
  check('6: the window came up again, reduced motion forced', !!again, again ? '' : calmApp.out.slice(-600));
  if (again) {
    const rest = tabOf(await stateOf(calmApp), 'feat/a');
    const plain = rest ? rest.bg : null;
    const pid = hostPidOf(again, 'feat/a');
    await sleep(3000);   // a re-attached page needs longer to join its running host than a fresh one
    await fireHook(pid, 'Stop', {});
    const steadyDone = await pulseIs(calmApp, 'feat/a', 'pulse-done');
    check('6: finished: the class is there, the animation is none', !!steadyDone && steadyDone.anim === 'none', JSON.stringify(steadyDone));
    const bgs = await sampleBg(calmApp, 'feat/a');
    check('6: ...the highlight is held (one colour, and not the plain strip colour)', bgs.length === 1 && bgs[0] !== plain, JSON.stringify({ bgs, plain }));
    await sleep(4500);
    await fireHook(pid, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    const steadyNeeds = await pulseIs(calmApp, 'feat/a', 'pulse-needs');
    check('6: needs you: the class is there, the animation is none', !!steadyNeeds && steadyNeeds.anim === 'none', JSON.stringify(steadyNeeds));
    const nbgs = await sampleBg(calmApp, 'feat/a');
    check('6: ...held, and a different colour from the finished one', nbgs.length === 1 && nbgs[0] !== plain && nbgs[0] !== bgs[0], JSON.stringify({ nbgs, bgs }));
    await command(calmApp, { cmd: 'screenshot', file: path.join(shots, '6-reduced.png') });
  }
  await command(calmApp, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    if (process.env.STRIP_PULSE_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
