'use strict';
/**
 * PROBE: one window per project (lane feat/one-window-per-project, DESIGN_TABS_SESSIONS.md 3.3) in REAL Electron windows.
 * (re-runnable)
 *
 *   node scripts/with-heavy-lock.js node verify/probe-one-window.js        (exit 0 = every check held)
 *
 * The unit tests pin the decision table, the owner file's proof and the pipe (test/window-owner.test.js, test/window-focus.test.js)
 * and read main.js as text. Only a real launch shows that a second Electron on the same project ends WITHOUT a window, that the first
 * window is the one that was told, and that a stale file does not lock a project out.
 *
 *   1  the first launch: one window, and <project>\.claude-custom\window.json names its pid and its OS start time
 *   2  a second launch from dev\ (no lane): it exits 0 with no window of its own, the first is told (focus, no lane), still ONE window,
 *      and the second leaves no process of its own behind
 *   3  a second launch from the feat/a worktree folder: the first window selects feat/a (the forwarded lane), still ONE window
 *   4  a graceful quit removes the owner file
 *   5  a stale file naming a DEAD pid: a launch opens its window and takes the file over
 *   6  a file naming a LIVE pid with ANOTHER start time (a reused pid): a launch opens its window and takes the file over
 *   7  two launches started together on one project: exactly one window survives, the other exits 0
 *
 * SAFE. A scratch project in a temp folder (never dev\), the hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* the probe doesn't set are deleted by the launcher, registry / portraits / uploads / UI state / user data are temp
 * folders. Every host whose folder is inside the probe's temp folder is stopped by pid at the end.
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

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-one-window-');
const userData = path.join(tmp, 'user-data');
const uiState = path.join(tmp, 'ui-state');
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
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_UI_STATE_DIR', 'CLAUDE_CUSTOM_ONE_WINDOW_PROBE'];

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
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
    CLAUDE_CUSTOM_ONE_WINDOW_PROBE: '1',      // the rule under test applies to probe windows only when asked
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
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
  return { container, dev, featA, ownerFile: path.join(dev, '.claude-custom', 'window.json') };
}

const readOwner = (p) => { try { return JSON.parse(fs.readFileSync(p.ownerFile, 'utf8')); } catch { return null; } };
// Every host pid a window reports is noted as it appears, so the end-of-run stop can prove it (verify/lib/seen-pids.js).
async function stateOf(app) {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
}
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };

// Children whose parent is `pid` (a read-only look at the process table): what a launch that ended left behind.
function childrenOf(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId):$($_.Name)" }) -join ','`],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out.trim() ? out.trim().split(',') : [];
  } catch { return null; }
}

async function firstWindowUp(app) {
  return waitFor(async () => {
    const st = await stateOf(app);
    return st && st.ok && st.stripDom && Array.isArray(st.hosts) && st.hosts.length >= 2 ? st : null;
  }, 150000);
}

async function main() {
  const p = makeProject('proj');

  // 1 ---------------------------------------------------------------------------------
  const app1 = await launchApp(p.container);
  const st1 = await firstWindowUp(app1);
  check('1: the first launch came up with its tabs', !!st1, st1 ? '' : app1.out.slice(-600));
  if (!st1) return;
  check('1: it has exactly one window', st1.windows === 1, `windows=${st1.windows}`);
  const own1 = await startTimes([app1.child.pid]);
  const o1 = readOwner(p);
  check('1: window.json names this window: its pid and its OS start time', !!o1 && o1.pid === app1.child.pid && own1 && o1.start === own1.get(app1.child.pid),
    JSON.stringify(o1));
  const dKey = (st1.hosts.find(h => h.label === 'develop') || {}).key;
  const aKey = (st1.hosts.find(h => h.label === 'feat/a') || {}).key;
  check('1: develop is the selected tab', !!dKey && st1.selectedKey === dKey, `selectedKey=${st1.selectedKey}`);

  // 2 ---------------------------------------------------------------------------------
  const app2 = await launchApp(p.dev);
  const t2 = Date.now();
  const said2 = await waitFor(() => /this launch ends/.test(app2.out), 60000);
  const tSaid = Date.now() - t2;
  // Chromium's shutdown can take a minute or more under load (BACKLOG #74 A), so "gone" is checked at the end, not here.
  console.log(`      (second launch: decided to end after ${tSaid} ms; alive now: ${isRunning(app2.child.pid)})`);
  check('2: a second launch from dev\\ decided at once: it said why (handed to the first window) and never reached a window', !!said2 && /this project's window \(pid \d+\) has it; this launch ends/.test(app2.out) && !/\[main\] Open refused/.test(app2.out), `${tSaid} ms`);
  const told = await waitFor(() => /a second launch asked for this window \(no lane\): focused/.test(app1.out), 15000);
  check('2: the first window was told: focus, no lane', !!told, app1.out.slice(-300));
  const st2 = await stateOf(app1);
  check('2: still ONE window, and the selected tab did not move', st2.windows === 1 && st2.selectedKey === dKey, `windows=${st2.windows} selected=${st2.selectedKey}`);

  // 3 ---------------------------------------------------------------------------------
  const app3 = await launchApp(p.featA);
  const said3 = await waitFor(() => /this launch ends/.test(app3.out), 60000);
  check('3: a launch from the feat/a folder decided at once to hand over and end', !!said3);
  const sel = await waitFor(async () => { const s = await stateOf(app1); return s.selectedKey === aKey ? s : null; }, 20000);
  check('3: the first window selected the lane that was forwarded (feat/a)', !!sel && !!aKey, `selectedKey=${(await stateOf(app1)).selectedKey} want ${aKey}`);
  check('3: ...and it still has ONE window', !!sel && sel.windows === 1, `windows=${sel && sel.windows}`);

  // 4 ---------------------------------------------------------------------------------
  await command(app1, { cmd: 'quit', graceful: true });
  const gone = await waitFor(() => (!fs.existsSync(p.ownerFile) ? true : null), 30000);
  check('4: a graceful quit removed the owner file', gone === true, `file=${JSON.stringify(readOwner(p))}`);
  // Chromium's shutdown is slow under load (BACKLOG #74 A): the file goes first, the process much later. So step 5's DEAD owner is a
  // short-lived process of this probe's own, proven by pid and start time while it ran, written down after it ended.
  const shortLived = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore', windowsHide: true });
  const shortStart = (await startTimes([shortLived.pid])).get(shortLived.pid);
  await new Promise((resolve) => shortLived.on('exit', resolve));
  check('5: setup: a process of ours that has ended, with the pid and start time it had', typeof shortStart === 'string' && !isRunning(shortLived.pid));

  // 5 ---------------------------------------------------------------------------------
  fs.mkdirSync(path.dirname(p.ownerFile), { recursive: true });
  fs.writeFileSync(p.ownerFile, JSON.stringify({ pid: shortLived.pid, start: shortStart, at: Date.now() }));
  const app5 = await launchApp(p.container);
  const st5 = await firstWindowUp(app5);
  check('5: a stale file with a dead pid does not lock the project out: a window opens', !!st5 && st5.windows === 1, st5 ? '' : app5.out.slice(-400));
  const o5 = readOwner(p);
  check('5: ...and it took the file over', !!o5 && o5.pid === app5.child.pid, JSON.stringify(o5));

  // 6 ---------------------------------------------------------------------------------
  fs.writeFileSync(p.ownerFile, JSON.stringify({ pid: app5.child.pid, start: '1', at: Date.now() }));   // a LIVE pid, another start time
  const app6 = await launchApp(p.container);
  const st6 = await firstWindowUp(app6);
  check('6: a live pid with another start time (a reused pid) is not an owner: a window opens', !!st6 && st6.windows === 1 && !app6.exited, st6 ? '' : app6.out.slice(-400));
  const o6 = readOwner(p);
  check('6: ...and it took the file over', !!o6 && o6.pid === app6.child.pid, JSON.stringify(o6));
  for (const a of [app5, app6]) { await command(a, { cmd: 'quit', graceful: true }); }
  await waitFor(() => app5.exited && app6.exited, 240000);

  // 7 ---------------------------------------------------------------------------------
  const q = makeProject('proj2');
  const [r1, r2] = await Promise.all([launchApp(q.container), launchApp(q.container)]);
  const decided = await waitFor(() => [r1, r2].some(a => /this launch ends/.test(a.out)) ? true : null, 90000);
  await sleep(5000);                                 // the other one has had every chance to say it too
  const enders = [r1, r2].filter(a => /this launch ends/.test(a.out));
  const keepers = [r1, r2].filter(a => !/this launch ends/.test(a.out));
  check('7: two launches started together: one hands over and ends, the other keeps the project', !!decided && enders.length === 1 && keepers.length === 1,
    `enders=${enders.length} keepers=${keepers.length}`);
  if (keepers.length === 1) {
    const s7 = await firstWindowUp(keepers[0]);
    check('7: ...and the keeper has one window and its file names it', !!s7 && s7.windows === 1 && (readOwner(q) || {}).pid === keepers[0].child.pid,
      `windows=${s7 && s7.windows} keeper=${keepers[0].child.pid} file=${JSON.stringify(readOwner(q))}`);
    await command(keepers[0], { cmd: 'quit', graceful: true });
  }

  // The launches that handed over must END (and leave nothing of their own), however long Chromium takes to shut down.
  const handedOver = [app2, app3, ...[r1, r2].filter(a => /this launch ends/.test(a.out))];
  const allGone = await waitFor(() => handedOver.every(a => a.exited) ? true : null, 300000, 1000);
  check('2/3/7: every launch that handed over ended by itself with exit code 0', allGone === true && handedOver.every(a => a.exitCode === 0),
    handedOver.map(a => `${a.child.pid}:${a.exited ? a.exitCode : 'running'}`).join(' '));
  // Chromium's helper processes (GPU, utility) go a little after the root: "gone eventually", polled.
  let orphans = [];
  await waitFor(() => { orphans = handedOver.map(a => childrenOf(a.child.pid)); return orphans.every(c => c && c.length === 0) ? true : null; }, 120000, 3000);
  check('2/3/7: ...and left no process of their own behind (polled up to 2 minutes)', orphans.every(c => c && c.length === 0), JSON.stringify(orphans));
  // The windows this probe asked to quit end too (the file went first; the process takes Chromium's time, BACKLOG #74 A).
  const quitApps = [app1, app5, app6, ...keepers];
  const quitGone = await waitFor(() => quitApps.every(a => a.exited) ? true : null, 300000, 1000);
  check('4/5/6/7: every window that was quit ended (polled up to 5 minutes)', quitGone === true, quitApps.map(a => `${a.child.pid}:${a.exited ? a.exitCode : 'running'}`).join(' '));
}

main()
  .catch((err) => { console.log('FAIL  the probe threw: ' + ((err && err.stack) || err)); failures++; })
  .finally(() => {
    killEverything();
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
