'use strict';
/**
 * Plain shell tabs (BACKLOG #119 A5), in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node verify/probe-shell-tab.js [screenshot-dir]        (exit 0 = every check held)
 *
 * test/tab-shell-shell.test.js pins the lifecycle and test/shell-tab.test.js the host-level pieces. Nothing else runs app/main.js,
 * the strip page, the tab views and a second real host together, and that is where this feature can lie: the shell host must
 * really be a SECOND host on the same folder whose pty runs a shell and NOT `claude`, must take no session lock, must hand the
 * program none of the harness's variables, must turn the tab's dot and an attention frame on from OSC 7501 alone, and must be found
 * again as itself and never as the folder's own host.
 *
 * Against a throwaway container repo  <tmp>\proj\dev  (+ feat-a, feat-b made with `git worktree add`):
 *   open       Open shell here on feat/a: a tab "feat/a . shell" right after feat/a, selected, started, small, with a close button
 *   argv       the shell host's pty process is the shell with NO arguments; the branch tab's is the other way (claude's arguments)
 *   hosts      two hosts for one folder: different pids and ports, the identity file says kind:'shell' for one only
 *   lock       the shell host does not hold the worktree's session lock; the branch tab's host does
 *   env        the program in the shell sees none of CLAUDE_CUSTOM_* and no ELECTRON_RUN_AS_NODE (read from inside the shell)
 *   plain      a program that says nothing leaves the tab plain: no dot
 *   7501       a stand-in program that speaks OSC 7501 turns the tab's dots on (working, then needs-you with a pulse), and the host
 *              broadcasts the input-needed attention frame (the toast's source); the branch tab stays quiet
 *   exit       the shell exits: the tab says so and Open shell here restarts a FRESH host, still one tab
 *   adopt      close the window and reopen: the running shell host comes back as the shell tab, same pid, nothing spawned
 *   close      a real Ctrl+click on the shell tab closes it (Ricardo's look, 2026-10-26): its host, its shell and a ping the shell
 *              started all end, its identity file goes, nothing asks, feat/a shows next; a shell opened from the branch tab's menu
 *              closes the same way by a real click on its x and by its own menu's Close shell; the develop tab's shell closes too
 *   ends       hand-closing feat/a ends BOTH hosts (a fresh shell opened for it) and removes both tabs
 *   shots      screenshots of the strip with the shell tab (open, and with its dot on) land in the directory named
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN) and the shell is cmd.exe too (CLAUDE_CUSTOM_SHELL), so nothing runs that
 * bills; ELECTRON_RUN_AS_NODE is deleted before each window launch; the registry, portraits and uploads point at temp folders. The
 * app is driven through CLAUDE_CUSTOM_TABS_PROBE (app/main.js). Every process it started is ended through host/kill-tree.js by pid AND
 * start time (verify/lib/seen-pids.js), never by name. WINDOWS ONLY (cmd.exe).
 */
const { execFileSync, spawn } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { pickShell } = require(path.join(ROOT, 'host', 'launch-target'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const CMD = 'C:\\Windows\\System32\\cmd.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-shell-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const shotDir = process.argv[2] ? path.resolve(process.argv[2]) : tmp;
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args,
], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
let skipped = false;      // set when the app never came up, so later checks are not answered wrongly
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
  git(dev, 'worktree', 'add', '-q', path.join(container, 'feat-b'), '-b', 'feat/b');
}

// --- one app instance = one "window" --------------------------------------------------
let windowNo = 0;
async function launchApp(cwd, extraEnv = {}) {
  windowNo++;
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: CMD,
    CLAUDE_CUSTOM_SHELL: CMD,
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_SHELL', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_SCREENSHOT', 'CLAUDE_CUSTOM_SCREENSHOT_DELAY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
const labelsOf = (s) => (s && s.tabs ? s.tabs.map(t => t.label) : []);
const tabOf = (s, label) => (s && s.tabs ? s.tabs.find(t => t.label === label) : null);
const hostOf = (s, label) => (s && s.hosts ? s.hosts.find(h => h.label === label) : null);
const domOf = (s, label) => (s && Array.isArray(s.stripDom) ? s.stripDom.find(d => d.label === label) : null);
const SHELL_A = 'feat/a \u00b7 shell';
const SHELL_DEV = 'develop \u00b7 shell';

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

// The raw identity files of the hosts serving `dir` (the OS-level ground truth of which hosts run), kind included.
function identitiesUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const port = Number(f.replace(/\.json$/, ''));
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'hosts', f), 'utf8')); } catch { continue; }
    const id = readIdentity({ dir: HARNESS_DIR, port });
    if (id && raw && path.resolve(id.cwd).toLowerCase() === path.resolve(dir).toLowerCase()) out.push({ ...id, claudePid: raw.claudePid, processStartedAt: raw.processStartedAt });
  }
  return out;
}

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function commandLineOf(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  } catch { return null; }
}

// A ping.exe the shell `parent` started (the close stage's grandchild), or null. Read only: nothing is ever ended by name.
function pingUnder(parent) {
  if (!Number.isInteger(parent)) return null;
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='PING.EXE'" | Select-Object -First 1).ProcessId`],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid); };

function killEverything() {
  for (const id of identitiesUnder(featA).concat(identitiesUnder(dev), identitiesUnder(path.join(container, 'feat-b')))) {
    seenPids.add(id.pid, id.processStartedAt);
  }
  seenPids.endAll();
}

function removeTemp() {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}
hygiene.addCleanup(killEverything);

const tokenOf = (port) => fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${port}.token`), 'utf8').trim();
const pngOk = (f) => { try { const b = fs.readFileSync(f); return b.length > 2000 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'; } catch { return false; } };

// --- a client of the shell host: types into its pty and reads its screen ------------------------
// role=control: a one-shot control client, not a window, so it answers no terminal query (the real window's xterm does).
async function connectTo(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${tokenOf(port)}&role=control`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = { ws, frames: [], bytes: 0, term: new Terminal({ cols: 100, rows: 30, allowProposedApi: true }) };
  ws.on('message', (data, isBinary) => {
    if (isBinary) { c.bytes += data.length; c.term.write(data.toString('utf8')); return; }
    try { c.frames.push(JSON.parse(data.toString())); } catch { /* not control */ }
  });
  c.type = (text) => ws.send(JSON.stringify({ type: 'input', data: text }));
  c.of = (type) => c.frames.filter(f => f.type === type);
  c.screen = () => {
    const b = c.term.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
    return lines;
  };
  c.close = () => { try { ws.close(); } catch { /* gone */ } };
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  return c;
}

// The stand-in for a program that speaks OSC 7501 (as Codex, cargo or terraform would). It writes what a control file tells it to.
// String.raw: the escapes below are for the PROGRAM's source, not for this file.
const PROGRAM = String.raw`
const fs = require('fs');
const [ctl] = process.argv.slice(2);
if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();
let last = '';
setInterval(() => {
  let c; try { c = fs.readFileSync(ctl, 'utf8'); } catch { return; }
  if (c === last) return;
  last = c;
  const out = JSON.parse(c).out;
  if (out === '__exit__') process.exit(0);
  process.stdout.write(out);
}, 40);
`;
const osc = (body) => `\x1b]7501;${body}\x07`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// --- the probe ---------------------------------------------------------------------------
async function main() {
  console.log('temp repo:', tmp);
  fs.mkdirSync(shotDir, { recursive: true });
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
  s = await waitFor(async () => { const x = await state(app); return labelsOf(x).length >= 3 ? x : null; }, 30000);
  remember(s);
  check('three tabs, dev first, and no shell tab until one is asked for',
    !!s && JSON.stringify(labelsOf(s)) === JSON.stringify(['develop', 'feat/a', 'feat/b']), s ? labelsOf(s).join(', ') : 'no tabs');
  if (!s) { skipped = true; return; }

  // The branch tab's own session first, so there are two hosts on one folder to tell apart.
  const sel = await command(app, { cmd: 'select', label: 'feat/a' }, 60000);
  s = await state(app);
  remember(s);
  const aHost = hostOf(s, 'feat/a');
  check("feat/a's own host is running", !!sel.ok && sel.started === true && !!aHost && alive(aHost.pid), JSON.stringify(sel));
  if (!aHost) { skipped = true; return; }

  // ===== open =====
  const opened = await command(app, { cmd: 'shell-open', label: 'feat/a' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SHELL_A) && tabOf(x, SHELL_A).started ? x : null; }, 40000);
  remember(s);
  check('Open shell here on feat/a: the tab "feat/a \u00b7 shell" is there, started, and the open succeeded', !!s && opened.ok === true, JSON.stringify(opened));
  if (!s) { skipped = true; return; }
  check('it sits right after its branch tab, before feat/b',
    JSON.stringify(labelsOf(s)) === JSON.stringify(['develop', 'feat/a', SHELL_A, 'feat/b']), labelsOf(s).join(', '));
  const shellTab = tabOf(s, SHELL_A);
  check('it is selected, a shell (not a side session, not a reader), and closable (Ricardo\'s look, 2026-10-26)',
    shellTab.selected === true && shellTab.shell === true && shellTab.side !== true && shellTab.role === undefined && shellTab.closable === true, JSON.stringify(shellTab));
  s = await waitFor(async () => { const x = await state(app); return domOf(x, SHELL_A) ? x : null; }, 15000) || s;
  const dom = domOf(s, SHELL_A);
  check('the strip PAINTED it as a small shell tab with a close button of its own, and no dot yet',
    !!dom && dom.shell === true && dom.side === false && dom.hasClose === true && Array.isArray(dom.dots) && dom.dots.length === 0, JSON.stringify(dom));
  check('and its hover says it is a shell, not a Claude session', !!dom && /shell/i.test(dom.title || '') && /not a Claude session/.test(dom.title || ''), dom && dom.title);
  check('the shell tab\'s page rendered and connected (xterm mounted)', !!(await waitFor(async () => {
    const x = await state(app);
    return x.viewDom && x.viewDom.xterm > 0 && x.viewDom.hasTerm ? x : null;
  }, 30000)));
  const shot1 = path.join(shotDir, 'shell-tab-open.png');
  const r1 = await command(app, { cmd: 'screenshot', file: shot1 });
  check('a screenshot of the strip with the shell tab selected is a real image', !!r1.ok && pngOk(r1.stripFile), r1.stripFile);

  // ===== hosts, argv, lock =====
  const shellHost = hostOf(s, SHELL_A);
  check('a SECOND host: its own pid and port, the branch tab\'s host untouched',
    !!shellHost && shellHost.pid !== aHost.pid && shellHost.port !== aHost.port && alive(aHost.pid) && alive(shellHost.pid),
    shellHost && `shell ${shellHost.pid}:${shellHost.port}, branch ${aHost.pid}:${aHost.port}`);
  const ids = identitiesUnder(featA);
  const shellId = ids.find(i => i.pid === (shellHost && shellHost.pid));
  const mainId = ids.find(i => i.pid === aHost.pid);
  check('the identity files say so: kind "shell" for the shell host only, both serving feat-a, neither a side host',
    !!shellId && !!mainId && shellId.kind === 'shell' && mainId.kind === undefined && shellId.side !== true && mainId.side !== true,
    JSON.stringify(ids.map(i => ({ pid: i.pid, kind: i.kind || null, side: i.side === true }))));
  if (shellId) seenPids.add(shellId.pid, shellId.processStartedAt);
  if (mainId) seenPids.add(mainId.pid, mainId.processStartedAt);

  const shellLine = await waitFor(async () => {
    const id = identitiesUnder(featA).find(i => i.pid === (shellHost && shellHost.pid));
    return id && id.claudePid ? commandLineOf(id.claudePid) : null;
  }, 20000, 500);
  const mainLine = await waitFor(async () => {
    const id = identitiesUnder(featA).find(i => i.pid === aHost.pid);
    return id && id.claudePid ? commandLineOf(id.claudePid) : null;
  }, 20000, 500);
  const expectPick = pickShell({ CLAUDE_CUSTOM_SHELL: CMD });
  check('the shell host\'s pty runs the picked shell with NO arguments (nothing of claude\'s: no --settings, no --dangerously-skip-permissions)',
    !!shellLine && shellLine.replace(/^"|"$/g, '').toLowerCase() === expectPick.bin.toLowerCase() && !/--/.test(shellLine), shellLine || 'no command line');
  check('the branch tab\'s claude is the other way round (claude\'s arguments, bypass on)',
    !!mainLine && /--dangerously-skip-permissions/.test(mainLine) && /--settings/.test(mainLine), mainLine || 'no command line');

  // The session lock lives in the worktree's git dir: the branch tab's host holds it, the shell host does not.
  const gitDir = git(featA, 'rev-parse', '--git-dir').trim();
  const lockDir = path.isAbsolute(gitDir) ? gitDir : path.join(featA, gitDir);
  let lockPid = null;
  try {
    const name = fs.readdirSync(lockDir).find(f => /lock/i.test(f) && /claude-custom|session/i.test(f));
    if (name) lockPid = JSON.parse(fs.readFileSync(path.join(lockDir, name), 'utf8')).pid;
  } catch { /* reported below */ }
  check('the session lock names the branch tab\'s host, never the shell host',
    Number.isInteger(lockPid) && lockPid === aHost.pid && lockPid !== (shellHost && shellHost.pid), `lock pid ${lockPid}, branch host ${aHost.pid}`);

  // ===== inside the shell =====
  const c = await connectTo(shellHost.port);
  const hello = await waitFor(() => c.of('hello')[0], 10000);
  check('the shell host answers a client like any host, and lists program-status among its control types', !!hello && hello.controls.includes('program-status'));
  check('and its quota is not polled: no quota frame ever reaches a client', c.of('quota').length === 0);
  check('and no mod is loaded into it', !!hello && (!hello.modStatus || hello.modStatus.state !== 'on'), hello && JSON.stringify(hello.modStatus));
  const prompt = await waitFor(() => c.screen().join('').toLowerCase().includes(featA.toLowerCase() + '>') || null, 20000, 200);
  // The rows joined: a long temp folder wraps the prompt past the 100 columns, and the pty breaks it into rows.
  check('the shell shows its prompt in the lane\'s folder', !!prompt && c.screen().join('').toLowerCase().includes(featA.toLowerCase() + '>'), c.screen().filter(Boolean).slice(-3).join(' | '));
  // cmd expands an undefined %NAME% to the literal text, so the ENVCHECK line shows the name when the variable is NOT set.
  // The typed lines hold only %T% and %E%, so a line that STARTS with ENVCHECK is the program's own output.
  c.type('set "T=%CLAUDE_CUSTOM_TOKEN%"\r');
  await sleep(500);
  c.type('set "E=%ELECTRON_RUN_AS_NODE%"\r');
  await sleep(500);
  c.type('set "H=%CLAUDE_CUSTOM_SHELL_HOST%"\r');
  await sleep(500);
  c.type('echo ENVCHECK[%T%][%E%][%H%]\r');
  const envLine = await waitFor(() => c.screen().find(l => /^ENVCHECK\[/.test(l)) || null, 10000, 200);
  check('the program in the shell sees no CLAUDE_CUSTOM_* variable (not the host\'s session token, not its own flag) and no ELECTRON_RUN_AS_NODE',
    envLine === 'ENVCHECK[%CLAUDE_CUSTOM_TOKEN%][%ELECTRON_RUN_AS_NODE%][%CLAUDE_CUSTOM_SHELL_HOST%]', envLine || 'no output line');

  // ===== plain: a program that says nothing =====
  await sleep(1500);
  s = await state(app);
  const plain = tabOf(s, SHELL_A);
  check('a program that does not speak 7501 leaves the tab plain: no dot, no pulse, no program state',
    !!plain && plain.working === false && plain.needsInput === false && plain.pulse === null && plain.program === null, JSON.stringify(plain && { w: plain.working, n: plain.needsInput, p: plain.pulse, g: plain.program }));

  // ===== 7501 =====
  const progFile = path.join(tmp, 'prog.js');
  const ctl = path.join(tmp, 'prog.ctl');
  fs.writeFileSync(progFile, PROGRAM);
  const say = async (out) => { fs.writeFileSync(ctl, JSON.stringify({ out, n: Math.random() })); await sleep(250); };
  c.type(`node "${progFile}" "${ctl}"\r`);
  await sleep(1500);
  await command(app, { cmd: 'select', label: 'feat/b' }, 60000);     // looking at the shell tab would answer a need at once
  await say(osc('state=working:progress=40'));
  s = await waitFor(async () => { const x = await state(app); const t = tabOf(x, SHELL_A); return t && t.working === true ? x : null; }, 15000, 300);
  check('state=working turns the shell tab\'s working dot on', !!s, s ? '' : 'the tab never showed working');
  if (s) {
    const d = domOf(s, SHELL_A);
    check('and the strip PAINTED it (a working dot with the program\'s words)', !!d && d.dots.some(x => /^dot working\|/.test(x) && /Working, 40%/.test(x)), JSON.stringify(d && d.dots));
  }
  const nAtt = c.of('attention').length;
  await say(osc(`state=blocked:kind=permission:title=${b64('cargo publish')}:msg=${b64('Publish v0.1.0?')}`));
  s = await waitFor(async () => { const x = await state(app); const t = tabOf(x, SHELL_A); return t && t.needsInput === true ? x : null; }, 15000, 300);
  const needTab = s && tabOf(s, SHELL_A);
  check('state=blocked turns the needs-you state on, with a pulse, and carries the program\'s own words',
    !!needTab && needTab.pulse === 'needs' && !!needTab.program && needTab.program.state === 'blocked' && needTab.program.msg === 'Publish v0.1.0?', JSON.stringify(needTab && { p: needTab.pulse, g: needTab.program }));
  if (s) {
    const d = domOf(s, SHELL_A);
    check('the strip PAINTED the needs-you dot with the program\'s message in its tooltip, and the pulse', !!d && d.dots.some(x => /^dot needs\|/.test(x) && /Publish v0\.1\.0\?/.test(x)) && d.pulse === 'pulse-needs', JSON.stringify(d && { dots: d.dots, pulse: d.pulse }));
    const branch = tabOf(s, 'feat/a');
    const dBranch = domOf(s, 'feat/a');
    check('feat/a (the branch tab) stays quiet: its own state is not the shell\'s', !!branch && branch.needsInput === false && branch.pulse === null && !!dBranch && dBranch.dots.length === 0, JSON.stringify(branch && { n: branch.needsInput, p: branch.pulse }));
  }
  const need = await waitFor(() => c.of('attention').slice(nAtt).find(a => a.kind === 'input-needed') || null, 8000, 200);
  check('and the host raises the urgent input-needed attention frame (the toast\'s source), in the program\'s words',
    !!need && need.urgent === true && /Publish v0\.1\.0\?/.test(need.body || ''), need && JSON.stringify(need));
  const shot2 = path.join(shotDir, 'shell-tab-needs-you.png');
  const r2 = await command(app, { cmd: 'screenshot', file: shot2 });
  check('a screenshot of the strip with the shell tab asking for you is a real image', !!r2.ok && pngOk(r2.stripFile), r2.stripFile);
  await say(osc('state=done'));
  const done = await waitFor(async () => { const x = await state(app); const t = tabOf(x, SHELL_A); return t && t.pulse === 'done' ? x : null; }, 15000, 300);
  check('state=done ends the need and the tab shows finished', !!done);
  await say(osc('state=clear'));
  await say('__exit__');

  // ===== exit: the shell ends, the tab says so, Open shell here restarts it =====
  c.type('exit\r');
  const gone = await waitFor(async () => !alive(shellHost.pid), 20000, 250);
  check('exiting the shell ends its host (the branch tab\'s host is untouched)', !!gone && alive(aHost.pid));
  c.close();
  const endedState = await waitFor(async () => { const x = await state(app); return /exited/.test(((tabOf(x, SHELL_A) || {}).phaseText) || '') ? x : null; }, 20000, 400);
  check('its tab says the shell exited and how to restart it', !!endedState, endedState ? tabOf(endedState, SHELL_A).phaseText : 'no phase text');
  const reopened = await command(app, { cmd: 'shell-open', label: 'feat/a' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SHELL_A) && tabOf(x, SHELL_A).started && hostOf(x, SHELL_A) && alive(hostOf(x, SHELL_A).pid) ? x : null; }, 40000);
  remember(s);
  const newShell = s && hostOf(s, SHELL_A);
  check('Open shell here again starts a FRESH host, and there is still one shell tab',
    reopened.ok === true && !!newShell && newShell.pid !== shellHost.pid && labelsOf(s).filter(l => l === SHELL_A).length === 1,
    newShell && `new pid ${newShell.pid}, old ${shellHost.pid}`);
  const again = await command(app, { cmd: 'shell-open', label: 'feat/a' }, 60000);
  check('opening it again goes to the live one and spawns nothing', again.ok === true && again.already === true, JSON.stringify(again));

  // ===== adopt: close the window, reopen =====
  const before = { shell: newShell && newShell.pid, count: identitiesUnder(featA).length };
  await quit(app);
  check('closing the window leaves the shell host running (detach), like every host', !!before.shell && alive(before.shell));
  app = await launchApp(container);
  s = await driverUp(app);
  if (!s) { check('the window reopened', false, app.out.split('\n').slice(-15).join('\n')); skipped = true; return; }
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SHELL_A) && tabOf(x, SHELL_A).started ? x : null; }, 40000);
  remember(s);
  check('reopened: the running shell host came back as the shell tab, same pid, nothing spawned',
    !!s && (hostOf(s, SHELL_A) || {}).pid === before.shell && identitiesUnder(featA).length === before.count,
    s && `${(hostOf(s, SHELL_A) || {}).pid}/${before.shell}, hosts ${identitiesUnder(featA).length}/${before.count}`);
  check('and the branch tab did not pick the shell host up as its own, nor become a side session',
    !!s && !!hostOf(s, 'feat/a') && hostOf(s, 'feat/a').pid === aHost.pid && !labelsOf(s).some(l => /side$/.test(l)), s && `feat/a host ${(hostOf(s, 'feat/a') || {}).pid}/${aHost.pid}`);

  // ===== close by hand (Ricardo's look, 2026-10-26: a shell tab could not be closed) =====
  // A grandchild in the shell (a background ping), so what is checked is the pty's whole TREE ending, not only the shell.
  // Its own shell, whatever the adopt stage left: an open goes to a live one, or starts one.
  await command(app, { cmd: 'shell-open', label: 'feat/a' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SHELL_A) && tabOf(x, SHELL_A).started && hostOf(x, SHELL_A) ? x : null; }, 40000);
  remember(s);
  const closingShell = s && hostOf(s, SHELL_A);
  if (!closingShell) { check('a shell on feat/a to close', false, s ? labelsOf(s).join(', ') : 'no state'); skipped = true; return; }
  const closingId = await waitFor(async () => { const i = identitiesUnder(featA).find(x => x.pid === closingShell.pid); return i && i.claudePid ? i : null; }, 15000, 300);
  if (closingId) seenPids.add(closingId.pid, closingId.processStartedAt);
  const cc = closingShell ? await connectTo(closingShell.port) : null;
  if (cc) cc.type('start /b "" ping -n 600 127.0.0.1 >nul\r');
  const pingPid = closingId && closingId.claudePid ? await waitFor(async () => pingUnder(closingId.claudePid), 15000, 500) : null;
  if (pingPid) seenPids.see(pingPid);
  if (cc) cc.close();
  check('the shell tab has a process tree to end: its shell, and a ping the shell started', !!closingId && !!pingPid && alive(closingId.claudePid),
    closingId ? `shell ${closingId.claudePid}, ping ${pingPid}` : 'no shell host');
  const confirmsBefore = (((await state(app)) || {}).confirms || []).length;
  const clicked = await command(app, { cmd: 'ctrlClick', label: SHELL_A });
  const treeGone = await waitFor(async () => !alive(closingShell.pid) && !alive(closingId.claudePid) && !alive(pingPid), 20000, 300);
  s = await waitFor(async () => { const x = await state(app); return x && !tabOf(x, SHELL_A) ? x : null; }, 10000, 300);
  check('a real Ctrl+click on the shell tab in the strip closes it: the host, its shell and the ping are all gone',
    clicked.ok === true && !!treeGone, `host ${alive(closingShell.pid) ? 'alive' : 'gone'}, shell ${alive(closingId.claudePid) ? 'alive' : 'gone'}, ping ${alive(pingPid) ? 'alive' : 'gone'}`);
  check('its identity file is gone with it', !identitiesUnder(featA).some(i => i.kind === 'shell'), JSON.stringify(identitiesUnder(featA).map(i => i.kind || null)));
  check('the tab left the strip, its branch tab shows next and its host is untouched',
    !!s && JSON.stringify(labelsOf(s)) === JSON.stringify(['develop', 'feat/a', 'feat/b']) && (tabOf(s, 'feat/a') || {}).selected === true && alive(aHost.pid),
    s ? labelsOf(s).join(', ') : 'no state');
  check('closing a shell asked nothing', !!s && (s.confirms || []).length === confirmsBefore, s && JSON.stringify(s.confirms));

  // Every other close a person has: the tab's own x, and its menu's Close shell. Each on a shell opened the way Ricardo opened his,
  // from the branch tab's right-click Open shell here (the popup's own template, clicked by the driver).
  async function openFromMenu() {
    const opened = await command(app, { cmd: 'tabMenu', label: 'feat/a', item: 'Open shell here' }, 60000);
    const x = await waitFor(async () => { const y = await state(app); return tabOf(y, SHELL_A) && tabOf(y, SHELL_A).started && hostOf(y, SHELL_A) ? y : null; }, 40000);
    remember(x);
    const host = x && hostOf(x, SHELL_A);
    const id = host ? await waitFor(async () => { const i = identitiesUnder(featA).find(z => z.pid === host.pid); return i && i.claudePid ? i : null; }, 15000, 300) : null;
    if (id) seenPids.add(id.pid, id.processStartedAt);
    return { opened, host, id };
  }
  for (const way of [
    { name: 'a real click on its x', cmd: { cmd: 'xClick', label: SHELL_A } },
    { name: 'its menu\'s Close shell', cmd: { cmd: 'tabMenu', label: SHELL_A, item: 'Close shell' } },
  ]) {
    const o = await openFromMenu();
    check(`the branch tab's menu Open shell here opens a shell (to close by ${way.name})`,
      o.opened.ok === true && !!o.host && !!o.id && alive(o.id.claudePid), JSON.stringify(o.opened));
    if (!o.host || !o.id) continue;
    if (way.cmd.cmd === 'tabMenu') {
      const menu = await command(app, { cmd: 'tabMenu', label: SHELL_A });
      check('the shell tab\'s menu is Go to shell and Close shell, both on',
        JSON.stringify(menu.items) === JSON.stringify([{ label: 'Go to shell', enabled: true }, { label: 'Close shell', enabled: true }]), JSON.stringify(menu));
    }
    const r = await command(app, way.cmd);
    const gone = await waitFor(async () => !alive(o.host.pid) && !alive(o.id.claudePid) && !identitiesUnder(featA).some(i => i.kind === 'shell'), 20000, 300);
    const x = await waitFor(async () => { const y = await state(app); return y && !tabOf(y, SHELL_A) ? y : null; }, 10000, 300);
    check(`${way.name} closes the shell tab: its host and its shell end, its identity file goes, feat/a shows next`,
      r.ok === true && !!gone && !!x && (tabOf(x, 'feat/a') || {}).selected === true && alive(aHost.pid),
      `host ${alive(o.host.pid) ? 'alive' : 'gone'}, shell ${alive(o.id.claudePid) ? 'alive' : 'gone'}, tabs ${x ? labelsOf(x).join(', ') : '?'}`);
  }

  // The develop tab never closes, so its shell is the one that had no way to end at all.
  const devOpened = await command(app, { cmd: 'shell-open', label: 'develop' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SHELL_DEV) && tabOf(x, SHELL_DEV).started && hostOf(x, SHELL_DEV) ? x : null; }, 40000);
  remember(s);
  const devShell = s && hostOf(s, SHELL_DEV);
  check('a shell opens on the develop tab', devOpened.ok === true && !!devShell && alive(devShell.pid), JSON.stringify(devOpened));
  const devClosed = devShell ? await command(app, { cmd: 'close', label: SHELL_DEV }) : { ok: false };
  const devGone = devShell && await waitFor(async () => !alive(devShell.pid) && !identitiesUnder(dev).some(i => i.kind === 'shell'), 20000, 300);
  s = await state(app);
  check('and closing it ends its host and removes its identity file, while the develop tab stays',
    devClosed.ok === true && !!devGone && !!s && !tabOf(s, SHELL_DEV) && !!tabOf(s, 'develop'), JSON.stringify(devClosed));

  // ===== ends with its branch tab =====
  const lastOpen = await command(app, { cmd: 'shell-open', label: 'feat/a' }, 60000);
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, SHELL_A) && tabOf(x, SHELL_A).started && hostOf(x, SHELL_A) ? x : null; }, 40000);
  remember(s);
  const lastShell = s && hostOf(s, SHELL_A);
  check('Open shell here after a hand close starts a fresh one', lastOpen.ok === true && !!lastShell && lastShell.pid !== closingShell.pid, JSON.stringify(lastOpen));
  const closed = await command(app, { cmd: 'close', label: 'feat/a' });
  const bothGone = await waitFor(async () => !alive(aHost.pid) && !!lastShell && !alive(lastShell.pid), 20000, 300);
  s = await state(app);
  check('hand-closing feat/a ends BOTH hosts', closed.ok === true && !!bothGone, JSON.stringify(closed));
  check('and both tabs leave the strip', !!s && !tabOf(s, 'feat/a') && !tabOf(s, SHELL_A), labelsOf(s).join(', '));
  check('the folder is still there', fs.existsSync(featA));
  await quit(app);

  // ===== a shell that cannot start (Dexter 1): the host must END, not sit bound with no pty =====
  const BOGUS = path.join(tmp, 'no-such-dir', 'no-such-shell.exe');
  const SHELL_B = 'feat/b · shell';
  app = await launchApp(container, { CLAUDE_CUSTOM_SHELL: BOGUS });
  s = await driverUp(app);
  if (!s) { check('the window for the bogus-shell stage came up', false, app.out.split('\n').slice(-15).join('\n')); skipped = true; return; }
  const bOpen = await command(app, { cmd: 'shell-open', label: 'feat/b' }, 60000);
  const bEnded = await waitFor(async () => {
    const x = await state(app);
    const t = tabOf(x, SHELL_B);
    return t && /exited/.test(t.phaseText || '') ? x : null;
  }, 40000, 400);
  remember(bEnded || (await state(app)));
  const bShellIds = identitiesUnder(path.join(container, 'feat-b')).filter(i => i.kind === 'shell');
  for (const i of bShellIds) seenPids.add(i.pid, i.processStartedAt);
  const bGone = await waitFor(async () => identitiesUnder(path.join(container, 'feat-b')).filter(i => i.kind === 'shell').every(i => !alive(i.pid)), 20000, 300);
  let hostLog = '';
  try { hostLog = fs.readFileSync(path.join(HARNESS_DIR, 'host.log'), 'utf8'); } catch { /* none */ }
  check('a shell that cannot start (a bogus CLAUDE_CUSTOM_SHELL) opens the tab and the tab then says the shell exited, with Restart on offer',
    bOpen.ok === true && !!bEnded, bEnded ? tabOf(bEnded, SHELL_B).phaseText : JSON.stringify(bOpen));
  check('and its host is GONE, not left bound with no pty', !!bGone && bShellIds.every(i => !alive(i.pid)), JSON.stringify(bShellIds.map(i => i.pid)));
  check('and host.log says why', hostLog.includes('could not start the shell:') && hostLog.includes('no-such-shell.exe'));
  await quit(app);
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.log(`FAIL  the probe threw: ${err && err.stack || err}`);
    failures++;
  } finally {
    hygiene._emergencyCleanup('done');     // ends the window(s) and, via the cleanup, every host it started
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
