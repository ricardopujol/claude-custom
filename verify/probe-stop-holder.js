'use strict';
const { killChildTree } = require('../host/kill-tree');
/**
 * Does *Stop that session* work between REAL hosts? (host/stop-holder.js)
 *
 *   node verify/probe-stop-holder.js     (exit 0 = every step held)
 *
 * The unit and property tests pin host/stop-holder.js with fakes; this pins
 * the host.js wiring and the real controls, start times and tree kill. Against
 * a throwaway git repo:
 *   1. host A takes the lock; host B on the same worktree is blocked by it;
 *   2. with a window attached to A, Stop on B answers 'has-window': A counts
 *      its own windows (stop-if-idle), brings them forward and does NOT stop;
 *   3. A's window JUST closed (a reload): still refused (Dexter, PR #76 F2);
 *   4. after the grace, Stop on B answers 'stopped': A ends itself, its claude
 *      with it, and B takes the lock and starts; B's log names pid and how;
 *   5. a lock with no `install` (a build before PR #75), its holder WITH a
 *      window: it can't be asked, the OS counts the window, and it is NOT
 *      killed (Dexter F1, Miguel B1);
 *   6. the same holder with its window closed: the OS says 0 and its proven
 *      pid's tree is ended; C takes over;
 *   7. Stop on a host that is not blocked (C, holding) is ignored.
 *
 * Found by Ricardo, 2026-09-30: nine detached hosts with no window held every
 * session lock in this repo, and the blocked pane could only open a second
 * claude. See CLAUDECUSTOM_BUILD_LOG.md.
 *
 * WINDOWS ONLY (cmd.exe, taskkill, Get-Process). SAFE: `claude` is cmd.exe
 * (CLAUDE_CUSTOM_BIN), so nothing is billed.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-stop-'));
execFileSync('git', ['init', '-q', repo]);
const lockPath = path.join(repo, '.git', 'claude-session.lock');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const hosts = [];
function startHost(name, port) {
  const token = `probe-${name}-${Date.now()}`;
  const env = { ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: repo, CLAUDE_CUSTOM_PORT: String(port), CLAUDE_CUSTOM_TOKEN: token };
  // Claude Code is an Electron app: inherited, this makes a child Electron plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  const h = { name, port, token, child, out: '' };
  child.stdout.on('data', d => { h.out += d; });
  child.stderr.on('data', d => { h.out += d; });
  hosts.push(h);
  return h;
}

async function waitFor(h, re, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const m = re.exec(h.out);
    if (m) return m;
    if (h.child.exitCode !== null) throw new Error(`${h.name} exited: ${h.out}`);
    await sleep(100);
  }
  throw new Error(`${h.name}: no ${re} within ${ms}ms\n----\n${h.out}`);
}

async function waitExit(h, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (h.child.exitCode !== null || h.child.signalCode !== null) return true;
    await sleep(100);
  }
  return false;
}

function attach(h) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}?token=${encodeURIComponent(h.token)}`);
    const conn = { ws, msgs: [] };
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      try { conn.msgs.push(JSON.parse(raw.toString())); } catch { /* not control */ }
    });
    ws.on('open', () => resolve(conn));
    ws.on('error', reject);
  });
}

async function waitMsg(conn, pred, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const m = conn.msgs.find(pred);
    if (m) return m;
    await sleep(50);
  }
  throw new Error(`no matching control message within ${ms}ms: ${JSON.stringify(conn.msgs.map(m => m.type))}`);
}

const closeConn = conn => new Promise((resolve) => { conn.ws.once('close', resolve); conn.ws.close(); });
const readLockFile = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ok  ${what}`); };

(async () => {
  // 1. A holds; B is blocked by it.
  const a = startHost('A', await freePort());
  await waitFor(a, /session lock {2}:.*"state":"held"/);
  await waitFor(a, /pty pid {7}: (\d+)/);
  await sleep(300);
  const aClaude = readLockFile().claudePid;
  check(readLockFile().pid === a.child.pid && typeof readLockFile().install === 'string', 'A holds the lock, with its install');

  const b = startHost('B', await freePort());
  await waitFor(b, /session lock {2}:.*"state":"blocked"/);
  const bWin = await attach(b);
  const hello = await waitMsg(bWin, m => m.type === 'hello');
  check(hello.lock.state === 'blocked' && hello.lock.holder.pid === a.child.pid, 'B is blocked, naming A');
  check(Array.isArray(hello.controls) && hello.controls.includes('lock-stop-holder'), 'B\'s hello lists lock-stop-holder');
  // What the pane sends: the holder it SHOWED (Dexter F6).
  const stopFrom = (conn, holder) => {
    conn.msgs.length = 0;
    conn.ws.send(JSON.stringify({ type: 'lock-stop-holder', holder: { pid: holder.pid, startedAt: holder.startedAt } }));
  };

  // 2. A has a window: stop-if-idle refuses, A brings it forward, nothing ends.
  let aWin = await attach(a);
  await waitMsg(aWin, m => m.type === 'hello');
  await sleep(2500);                       // a window, not a one-shot client
  stopFrom(bWin, hello.lock.holder);
  const refused = await waitMsg(bWin, m => m.type === 'lock-note');
  check(refused.outcome === 'has-window', `Stop on a holder with a window answers has-window (${refused.outcome}: ${refused.text})`);
  await waitMsg(aWin, m => m.type === 'raise', 5000);
  check(true, 'A\'s window was sent a raise');
  check(/stop-if-idle refused: 1 window/.test(a.out), 'A decided for itself, counting 1 window');
  check(a.child.exitCode === null && alive(aClaude), 'A and its claude are still running');

  // 3. A's window JUST closed (a reload): still refused (Dexter F2).
  await closeConn(aWin);
  stopFrom(bWin, hello.lock.holder);
  const recent = await waitMsg(bWin, m => m.type === 'lock-note');
  check(recent.outcome === 'has-window' && /reloading/.test(recent.text), `a window that just left still counts (${recent.text})`);
  check(a.child.exitCode === null, 'A is still running');

  // 4. The grace passed: A stops itself, B takes over.
  await sleep(5500);
  stopFrom(bWin, hello.lock.holder);
  const stopped = await waitMsg(bWin, m => m.type === 'lock-note', 40000);
  check(stopped.outcome === 'stopped', `Stop on a windowless holder answers stopped (${stopped.outcome}: ${stopped.text})`);
  check(await waitExit(a), 'host A exited');
  check(/stop-if-idle: no window, stopping/.test(a.out), 'A ended through its own stop-if-idle, not a kill');
  check(!alive(aClaude), `A's claude (pid ${aClaude}) ended with it`);
  await waitFor(b, /pty pid {7}: (\d+)/);
  check(true, 'B started its own session');
  await sleep(300);
  check(readLockFile().pid === b.child.pid, 'the lock now names B');
  const noteAt = bWin.msgs.findIndex(m => m.type === 'lock-note');
  const heldAt = bWin.msgs.findIndex(m => m.type === 'lock' && m.lock.state === 'held');
  check(heldAt !== -1 && noteAt > heldAt, 'the answer lands after the re-check repaint, so the note survives it');
  check(/Stop that session: stopped \(holder pid \d+, how stop-if-idle\)/.test(b.out), 'B logs the pid and how it ended (Miguel I2)');

  // 5. A lock from a build before `install`, its holder WITH a window: the OS
  //    counts it, and it is NOT killed (Dexter F1, Miguel B1).
  const legacy = readLockFile();
  const bClaude = legacy.claudePid;
  delete legacy.install;
  fs.writeFileSync(lockPath, JSON.stringify(legacy));
  const c = startHost('C', await freePort());
  await waitFor(c, /session lock {2}:.*"state":"blocked"/);
  const cWin = await attach(c);
  const cHello = await waitMsg(cWin, m => m.type === 'hello');
  check(cHello.lock.holder.pid === b.child.pid && cHello.lock.holder.install === null, 'C is blocked by B, whose lock has no install');
  stopFrom(cWin, cHello.lock.holder);
  const spared = await waitMsg(cWin, m => m.type === 'lock-note', 40000);
  check(spared.outcome === 'has-window', `an unaskable holder with a window is NOT stopped (${spared.outcome}: ${spared.text})`);
  check(b.child.exitCode === null && alive(bClaude), 'B and its claude are still running');
  check(/controls skipped: its lock has no install/.test(c.out), 'C logs why the controls were skipped');

  // 6. Same holder, window closed: the OS says 0, its proven pid is ended.
  await closeConn(bWin);
  await sleep(1000);
  stopFrom(cWin, cHello.lock.holder);
  const killed = await waitMsg(cWin, m => m.type === 'lock-note', 40000);
  check(killed.outcome === 'stopped', `an unaskable windowless holder is stopped (${killed.outcome}: ${killed.text})`);
  check(await waitExit(b), 'host B was ended');
  check(!/stop-if-idle|stop requested/.test(b.out.split('Stop that session')[1] || ''), 'B was ended by its pid, not asked');
  check(!alive(bClaude), `B's claude (pid ${bClaude}) went with its tree`);
  check(/how kill/.test(c.out), 'C logs that it was a kill');
  await waitMsg(cWin, m => m.type === 'lock' && m.lock.state === 'held');
  await sleep(300);
  check(readLockFile().pid === c.child.pid, 'C took the lock');

  // 7. A stale pane (a holder this lock no longer names) stops nothing.
  stopFrom(cWin, cHello.lock.holder);
  await waitFor(c, /lock-stop-holder ignored in state held/, 5000);
  check(c.child.exitCode === null, 'Stop on a holding host is ignored, and it keeps running');

  console.log('\nprobe-stop-holder: every step held');
  finish(0);
})().catch((err) => {
  console.log(err && err.message);
  for (const h of hosts) console.log(`---- ${h.name} ----\n${h.out}`);
  finish(1);
});

// Ctrl+C mid-run must not orphan the hosts it started -- the very bug this
// probe is about.
process.on('SIGINT', () => { console.log('\ninterrupted: stopping the probe\'s hosts'); finish(130); });

function finish(code) {
  // Only hosts still running (Miguel, PR #76 I1): a pid that already exited
  // may have been reused by now, and taskkill /T /F on it ends a stranger.
  for (const h of hosts) {
    if (h.child.exitCode !== null || h.child.signalCode !== null) continue;
    try { killChildTree(h.child); } catch { /* gone */ }
  }
  setTimeout(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }, 500);
}
