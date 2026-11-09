'use strict';
/**
 * PROBE: does a session survive with no viewer attached, and is it intact and responsive on reattach? (re-runnable)
 *
 *   node verify/probe-detach.js        (exit 0 = every check held; exit 1 = a check failed or the host died)
 *
 * The host is spawned detached by the app on purpose: it must outlive its window so a Remote Control session survives
 * closing the GUI (verify/probe-multi-project.js). This is the one probe that measures the detached stretch itself: a
 * client types a draft WITHOUT Enter, closes its socket, the probe waits with no viewer, and a brand-new client attaches.
 * The draft must still be in the replayed screen before the new client sends a single key, and the session must still
 * take input. (probe-protocol.js checks that a reattach replays the screen at all; this checks that the session's
 * state, a half-typed line, is the same one.)
 *
 * Rewritten 2026-11-05 (BACKLOG #168): the 2026-09-11 spike hard-coded the pre-worktree repo path, so its host died at
 * start, and it printed readings instead of checking them, so it still exited 0. Its Shift+Tab mode cycle was a reading
 * of the real CLI; that question is verify/probe-keys.js's and is not repeated here.
 *
 * SAFE. The session's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; nothing is ever submitted (no Enter is
 * sent). The project is a temp git repo; the registry, portraits and uploads are temp folders; every CLAUDE_CUSTOM_* of an
 * enclosing tab and ELECTRON_RUN_AS_NODE are stripped. The host gets a free port and its own token (CLAUDE_CUSTOM_TOKEN),
 * so it never binds a real host's port or uses its token. The only process killed is the host this probe spawned, with its
 * tree, by the pid this probe holds (verify/lib/process-hygiene.js), never by name.
 *
 * WHAT IT LEAVES IN THIS CHECKOUT (PR #234 Miguel Y4). host.js writes into the checkout's own .harness/ whatever its cwd, and
 * has no seam to move that (HARNESS_DIR is beside the code). Per port, it writes hosts/<port>.json, hosts/<port>.token,
 * harness-settings-<port>.json and (if the panel is on) state/canvas/_tab-<port>.json; a killed host can't remove them, so the
 * probe removes its own port's. It also rewrites two SHARED files (last writer wins; other probes read them by that path):
 * session-token and harness-settings.json. The probe saves both first and puts them back after, unless something else rewrote
 * them meanwhile (then that writer's value stays). Measured (listing + sha256 of .harness, hosts/ and state/canvas/ before
 * and after a run): identical. Not covered by that listing, and not undone: whatever the host writes deeper under
 * .harness/state/ at start, the same as any probe that starts a host on this checkout.
 */
require('./lib/mark-probe');   // BACKLOG #169: this script starts a host, so its children carry the probe mark
const { noteChild } = require('./lib/launch-electron');   // BACKLOG #179: takes the heavy-work lock now, before anything heavy starts; noteChild records each host / claude it starts
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');
const { createHygieneRegistry } = require('./lib/process-hygiene');

const ROOT = path.join(__dirname, '..');
const COLS = 100, ROWS = 30;
const MARKER = 'MARKER-BEFORE-DETACH';
const DETACHED_MS = 4000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const hygiene = createHygieneRegistry();
hygiene.install();

const HARNESS = path.join(ROOT, '.harness');
const SHARED_TOKEN = path.join(HARNESS, 'session-token');
const readOrNull = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const savedSharedToken = readOrNull(SHARED_TOKEN);   // before the host can write it
const SHARED_SETTINGS = path.join(HARNESS, 'harness-settings.json');
const savedSharedSettings = readOrNull(SHARED_SETTINGS);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 15000, step = 200) {
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
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function newTerm() {
  const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
// xterm-headless applies writes asynchronously: read the screen only after the queued writes are parsed.
const flush = t => new Promise(r => t.write('', r));
async function screenText(t) {
  await flush(t);
  const b = t.buffer.active, out = [];
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l) out.push(l.translateToString(true).replace(/\s+$/, '')); }
  return out.filter(s => s !== '').join('\n');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-detach-'));
const dev = path.join(tmp, 'proj', 'dev');
let host = null;
let hostLog = '';
let hostExit = null;   // { code, signal } once the host is gone
let hostPort = null;
let hostToken = null;

// After the host's tree is killed (process-hygiene runs extra cleanups after the trees, on a normal end, SIGINT or an uncaught
// error alike; PR #234 Miguel G1): this port's own files, the shared session-token put back, the temp project removed.
hygiene.addCleanup(() => {
  if (hostPort !== null) {
    // host/settings-writer.js writes the same body to harness-settings-<port>.json and the shared harness-settings.json: the shared
    // one is put back only while it still holds this host's body (a later writer's stays).
    const own = path.join(HARNESS, `harness-settings-${hostPort}.json`);
    const ownBody = readOrNull(own);
    const sharedNow = readOrNull(SHARED_SETTINGS);
    if (ownBody !== null && sharedNow !== null && sharedNow.equals(ownBody)) {
      try {
        if (savedSharedSettings === null) fs.rmSync(SHARED_SETTINGS, { force: true });
        else fs.writeFileSync(SHARED_SETTINGS, savedSharedSettings);
      } catch (e) { console.log(`NOTE  could not put .harness/harness-settings.json back: ${e.message}`); }
    }
    try { fs.rmSync(own, { force: true }); } catch { /* gone */ }
    for (const f of [path.join(HARNESS, 'hosts', `${hostPort}.json`), path.join(HARNESS, 'hosts', `${hostPort}.token`), path.join(HARNESS, 'state', 'canvas', `_tab-${hostPort}.json`)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
    }
  }
  // Only if it still holds THIS host's token: a value someone else wrote since is theirs, and stays.
  const now = readOrNull(SHARED_TOKEN);
  if (hostToken !== null && now !== null && now.toString('utf8').trim() === hostToken) {
    try {
      if (savedSharedToken === null) fs.rmSync(SHARED_TOKEN, { force: true });
      else fs.writeFileSync(SHARED_TOKEN, savedSharedToken, { mode: 0o600 });
    } catch (e) { console.log(`NOTE  could not put .harness/session-token back: ${e.message}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
});

async function attach(port, token, t) {
  for (let i = 0; i < 60; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);
    // Before `open` is awaited: the host replays the screen as soon as it accepts, and a listener added after the await could miss
    // that first frame (PR #234 Miguel G2).
    ws.on('message', (d, isBinary) => { if (isBinary) t.write(Buffer.from(d).toString('utf8')); });
    const ok = await new Promise(r => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); });
    if (ok) {
      ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }));
      return { ws, send: d => ws.send(JSON.stringify({ type: 'input', data: d })) };
    }
    if (hostExit) return null;
    await sleep(250);
  }
  return null;
}

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'init', '-q', '-b', 'develop'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  const port = await freePort();
  const token = crypto.randomBytes(16).toString('hex');
  hostPort = port;
  hostToken = token;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_')));
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: dev,
    CLAUDE_CUSTOM_PORT: String(port),
    CLAUDE_CUSTOM_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  });
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });

  host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  noteChild(host);   // the lock's work record: a live host keeps this probe a live holder (BACKLOG #112)
  hygiene.registerChild(host);
  host.stdout.on('data', d => { hostLog += d; });
  host.stderr.on('data', d => { hostLog += d; });
  host.on('exit', (code, signal) => { hostExit = { code, signal }; });
  const tail = () => hostLog.trim().split('\n').slice(-6).join(' | ');

  // 1 the session comes up -----------------------------------------------------------
  const t1 = newTerm();
  const a = await attach(port, token, t1);
  check('1: a client attaches to the host', !!a, a ? '' : `host ${hostExit ? `exited ${JSON.stringify(hostExit)}` : 'never accepted'}: ${tail()}`);
  if (!a) return;
  const prompt = await waitFor(async () => (/[A-Z]:\\[^\n]*>\s*$/m.test(await screenText(t1)) ? true : null), 20000);
  check('1: the session draws its prompt (cmd.exe stand-in for claude)', !!prompt, JSON.stringify((await screenText(t1)).slice(-200)));
  const ptyPid = Number((hostLog.match(/pty pid\s*:\s*(\d+)/) || [])[1]);
  check('1: the host names its pty pid, and it is running', Number.isInteger(ptyPid) && ptyPid > 0 && alive(ptyPid), String(ptyPid));

  // 2 a draft typed, then nobody watching --------------------------------------------
  a.send(MARKER);   // no Enter: a half-typed line is the state that must survive
  const typed = await waitFor(async () => ((await screenText(t1)).includes(MARKER) ? true : null), 8000);
  check('2: the draft shows on the first client\'s screen', !!typed);
  a.ws.close();
  await sleep(DETACHED_MS);
  check(`2: with no viewer for ${DETACHED_MS / 1000} s the host is still running`, hostExit === null && alive(host.pid), hostExit ? `exited ${JSON.stringify(hostExit)}: ${tail()}` : '');
  check(`2: ...and so is the session's pty`, Number.isInteger(ptyPid) && alive(ptyPid), String(ptyPid));

  // 3 a fresh client --------------------------------------------------------------------
  const t2 = newTerm();
  const b = await attach(port, token, t2);
  check('3: a fresh client attaches after the detach', !!b, b ? '' : tail());
  if (!b) return;
  const replayed = await waitFor(async () => ((await screenText(t2)).includes(MARKER) ? true : null), 8000);
  check('3: before it sends a key, its replayed screen holds the draft typed before the detach', !!replayed, JSON.stringify((await screenText(t2)).slice(-200)));
  b.send('-AFTER');
  const responsive = await waitFor(async () => ((await screenText(t2)).includes(`${MARKER}-AFTER`) ? true : null), 8000);
  check('3: the session still takes input: the new client\'s keys land on the same line', !!responsive, JSON.stringify((await screenText(t2)).slice(-200)));
  b.ws.close();
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');   // the host's tree by the pid it holds, then the cleanup above (its files, the token, the temp project)
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
