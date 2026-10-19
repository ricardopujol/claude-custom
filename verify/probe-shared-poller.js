'use strict';
/**
 * PROBE: ONE shared resource sampler across app instances (BACKLOG #100 c), in two REAL windows. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-shared-poller.js        (exit 0 = every check held)
 *
 * Unit tests pin the policy, the handover and the file protocol (test/shared-poller.test.js, test/poller-policy.test.js,
 * test/persistent-powershell.test.js). They cannot see two Electron mains sharing a folder, nor a real persistent
 * powershell.exe. This starts TWO real windows (two temp projects) that share ONE pool folder (CLAUDE_CUSTOM_UI_STATE_DIR is the
 * same temp folder; the real app's pool is never touched), then checks:
 *
 *   1  both windows come up and the pool names exactly one owner: the first window
 *   2  exactly ONE persistent powershell.exe (`-Command -`) exists under the two windows, and it belongs to the owner
 *   3  the second window, which samples nothing itself, still draws the machine figures and the process model
 *   4  cadence: while a window shows the Resources panel the pool publishes a sample about every 10 s; with only the chip
 *      in view, about every 30 s
 *   5  the persistent shell is the SAME process across samples, and its CPU per minute is measured
 *   6  both windows minimised: no sample is published for 45 s; one restored: a sample comes within seconds
 *   7  handover: the owner's whole Electron tree is ended BY PID; the other window takes the pool within seconds and keeps
 *      publishing, with its own persistent shell
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_*
 * variable of an enclosing tab are stripped (verify/lib/launch-electron.js); the projects are temp git repos and every
 * folder is temp. Two files of THIS checkout are touched because host.js hardcodes its state dir (layout-global.json,
 * layout-tree.json): both are snapshotted and put back on every exit path. Only PIDs this probe started are killed, by
 * PID, through verify/lib/process-hygiene.js. Nothing is ever stopped by name. Take the heavy-work lock first.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { killChildTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const { createExec } = require(path.join(ROOT, 'host', 'resource-sampler'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-pool-'));
const uiState = path.join(tmp, 'ui-state');
const pool = path.join(uiState, 'resource-poller-v1');
fs.mkdirSync(uiState, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (text) => console.log(`NOTE  ${text}`);

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

const LAYOUT_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const layoutSnap = snapshotFile(LAYOUT_FILE);
const treeSnap = snapshotFile(TREE_FILE);
hygiene.addCleanup(() => { layoutSnap.restore(); treeSnap.restore(); });
hygiene.install();

async function launchApp(name, cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_')));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, name, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, name, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, name, 'uploads'),
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const keepEnv = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_UI_STATE_DIR'];
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${path.join(tmp, name, 'user-data')}`], { cwd: ROOT, env }, { keepEnv });
  hygiene.registerChild(child);
  const app = { name, port, token, child, out: '', exited: false };
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
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });

const seenPids = require('./lib/seen-pids').createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
hygiene.addCleanup(() => { for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt); seenPids.endAll(); });

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 60000);
}

// What the OS says about the powershell.exe processes right now: pid, parent pid, command line, CPU time in ms.
async function powershells() {
  const script = `$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object { $cpu = (Get-Process -Id $_.ProcessId).TotalProcessorTime.TotalMilliseconds; "$($_.ProcessId)|$($_.ParentProcessId)|$cpu|$($_.CommandLine)" }
'END'`;
  const out = await createExec(30000)(script);
  return out.split(/\r?\n/).map(l => /^(\d+)\|(\d+)\|([\d.]*)\|(.*)$/.exec(l)).filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: m[3] === '' ? null : Number(m[3]), cmd: m[4] }));
}
const persistentUnder = (list, mains) => list.filter(p => mains.includes(p.ppid) && /-Command\s+-\s*$/.test(p.cmd));

const readOwner = () => { try { return JSON.parse(fs.readFileSync(path.join(pool, 'owner.json'), 'utf8')); } catch { return null; } };
const readHead = () => { try { return JSON.parse(fs.readFileSync(path.join(pool, 'sample.json'), 'utf8').split('\n')[0]); } catch { return null; } };

/** Distinct sample records published over `ms`, read every 500 ms: { count, ats }. */
async function watchSamples(ms) {
  const seen = new Set();
  const ats = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = readHead();
    if (h && !seen.has(h.seq)) { seen.add(h.seq); ats.push(h.at); }
    await sleep(500);
  }
  return { count: seen.size, ats };
}

let apps = [];
async function main() {
  const dev1 = path.join(tmp, 'p1', 'dev');
  const dev2 = path.join(tmp, 'p2', 'dev');
  for (const d of [dev1, dev2]) { fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'develop'); git(d, 'commit', '-q', '--allow-empty', '-m', 'init'); }
  for (const f of [LAYOUT_FILE, TREE_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }

  // 1 -----------------------------------------------------------------------------
  const A = await launchApp('a', dev1);
  apps.push(A);
  const readyA = await viewReady(A);
  check('1: window A came up with a session', !!readyA, readyA ? '' : A.out.slice(-600));
  if (!readyA) return;
  const B = await launchApp('b', dev2);
  apps.push(B);
  const readyB = await viewReady(B);
  check('1: window B came up with a session', !!readyB, readyB ? '' : B.out.slice(-600));
  if (!readyB) return;
  const mains = [A.child.pid, B.child.pid];
  const owner = await waitFor(() => readOwner(), 20000, 300);
  check('1: the pool names ONE owner, the first window', !!owner && owner.pid === A.child.pid, JSON.stringify(owner));
  check('1: the owner is recorded with its start time (so a reused pid cannot pass for it)', !!owner && /^\d+$/.test(String(owner.start)));

  // 2 -----------------------------------------------------------------------------
  const head0 = await waitFor(() => readHead(), 40000, 300);
  check('2: the owner published a sample', !!head0, JSON.stringify(head0));
  const ps1 = await powershells();
  const persistent1 = persistentUnder(ps1, mains);
  check('2: exactly ONE persistent powershell.exe under the two windows', persistent1.length === 1, JSON.stringify(persistent1.map(p => [p.pid, p.ppid])));
  check('2: it belongs to the owner, window A', persistent1.length === 1 && persistent1[0].ppid === A.child.pid);
  const listed = await view(B, 'resourcesState');

  // 3 -----------------------------------------------------------------------------
  const followerFull = await waitFor(async () => { const s = await view(B, 'resourcesState'); return s && s.payloadHasModel && s.chip && /^CPU .* GB \/ .* GB/.test(s.chip.text) ? s : null; }, 60000, 500);
  check('3: window B, which samples nothing itself, draws the machine figures and the process model', !!followerFull, JSON.stringify(followerFull ? followerFull.chip : listed));
  check('3: window B has no persistent powershell of its own', persistentUnder(await powershells(), [B.child.pid]).length === 0);

  // 4 -----------------------------------------------------------------------------
  // Neither window shows the Resources panel yet: the chip level, about every 30 s.
  const stateA = await view(A, 'resourcesState');
  check('4: window A starts with the panel NOT in view', stateA && stateA.shown === false, JSON.stringify(stateA && stateA.shown));
  const chipWatch = await watchSamples(70000);
  const chipGaps = chipWatch.ats.slice(1).map((t, i) => Math.round((t - chipWatch.ats[i]) / 1000));
  note(`chip level: ${chipWatch.count} records in 70 s, gaps (s) ${JSON.stringify(chipGaps)}`);
  check('4: with only the chip in view the pool publishes about every 30 s (gaps of 25 to 40 s)', chipGaps.length >= 1 && chipGaps.every(g => g >= 25 && g <= 40), JSON.stringify(chipGaps));

  await view(B, 'select', { id: 'resources' });
  const bShown = await waitFor(async () => { const s = await view(B, 'resourcesState'); return s && s.shown ? s : null; }, 10000, 200);
  check('4: window B (the FOLLOWER) shows the panel', !!bShown);
  await sleep(4000);    // within a control tick (2 s) the owner hears it
  const panelWatch = await watchSamples(45000);
  const panelGaps = panelWatch.ats.slice(1).map((t, i) => Math.round((t - panelWatch.ats[i]) / 1000));
  note(`panel level (shown in the follower): ${panelWatch.count} records in 45 s, gaps (s) ${JSON.stringify(panelGaps)}`);
  check('4: with the panel in view in the follower the OWNER samples about every 10 s (gaps of 8 to 16 s)', panelGaps.length >= 2 && panelGaps.every(g => g >= 8 && g <= 16), JSON.stringify(panelGaps));

  // 5 -----------------------------------------------------------------------------
  const before = (await powershells()).find(p => persistent1.length === 1 && p.pid === persistent1[0].pid);
  const t0 = Date.now();
  const w = await watchSamples(60000);
  const after = (await powershells()).find(p => persistent1.length === 1 && p.pid === persistent1[0].pid);
  check('5: the persistent shell is the SAME process after more than a minute of samples', !!before && !!after, `${before && before.pid} -> ${after && after.pid}`);
  if (before && after && before.cpuMs !== null && after.cpuMs !== null) {
    const perMin = Math.round((after.cpuMs - before.cpuMs) / ((Date.now() - t0) / 60000));
    note(`persistent shell CPU: ${perMin} ms per minute at the panel level (${w.count} samples in the window)`);
  }

  // 6 -----------------------------------------------------------------------------
  await view(B, 'select', { id: 'git' });
  await command(A, { cmd: 'window-state', state: 'minimize' });
  await command(B, { cmd: 'window-state', state: 'minimize' });
  await sleep(5000);
  const quiet = await watchSamples(45000);
  check('6: both windows minimised, nothing is published for 45 s', quiet.count <= 1, `${quiet.count} record(s) seen (the first reading may be the last one before the hide)`);
  const headBefore = readHead();
  await command(B, { cmd: 'window-state', state: 'restore' });
  const back = await waitFor(() => { const h = readHead(); return h && headBefore && h.seq > headBefore.seq ? h : null; }, 20000, 300);
  check('6: one window restored, a sample is published within seconds, not a whole interval', !!back);

  // 7 -----------------------------------------------------------------------------
  const ownerBefore = readOwner();
  const aPid = A.child.pid;
  note(`ending the owner's Electron tree (pid ${aPid}) by pid`);
  killChildTree(A.child);
  const taken = await waitFor(() => { const o = readOwner(); return o && o.pid === B.child.pid ? o : null; }, 15000, 300);
  check('7: the other window takes the pool within seconds of the owner dying', !!taken, JSON.stringify({ ownerBefore, taken }));
  const headTaken = readHead();
  const resumed = await waitFor(() => { const h = readHead(); return headTaken && h && h.seq > headTaken.seq && h.ownerPid === B.child.pid ? h : null; }, 60000, 500);
  check('7: it keeps publishing, the sequence continuing upward', !!resumed, JSON.stringify({ headTaken, resumed }));
  const ps2 = persistentUnder(await powershells(), [B.child.pid]);
  check('7: exactly one persistent powershell.exe now, under B', ps2.length === 1, JSON.stringify(ps2.map(p => [p.pid, p.ppid])));
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${(err && err.stack) || err}`); failures++; })
  .finally(async () => {
    for (const a of apps) { if (!a.exited) await command(a, { cmd: 'quit' }, 5000); }
    await sleep(1500);
    for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
    seenPids.endAll();           // a dead pid, or one reused since, is left alone (killProven)
    for (const a of apps) { if (!a.exited) { try { killChildTree(a.child); } catch { /* gone */ } } }   // the tree this probe spawned, by its handle
    layoutSnap.restore();
    treeSnap.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
