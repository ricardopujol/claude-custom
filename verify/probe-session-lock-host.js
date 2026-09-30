'use strict';
/**
 * Does the session lock hold in REAL hosts? (Extension X1, PR 1b.)
 *
 *   node verify/probe-session-lock-host.js     (exit 0 = every step held)
 *
 * The unit tests pin host/session-lock.js and host/session-gate.js; this pins
 * the host.js wiring around them, which no unit test can load. Against a
 * throwaway git repo:
 *   1. host A takes the lock: its log says held, the lock names A and, once
 *      the pty is up, A's claude pid;
 *   2. host B on the same worktree is BLOCKED: hello.lock names A, and B never
 *      spawns a pty;
 *   3. *Open anyway* ({type:'lock-override'}) on B starts B's session and
 *      broadcasts lock.state 'override';
 *   4. A killed outright (no exit handler runs) leaves its lock behind with a
 *      dead pid; host C takes it over silently;
 *   5. C's session gets WORKTREE_NAME / COMPOSE_PROJECT_NAME / WORKTREE_PORT_BASE;
 *   6. host D, blocked by C, exits on its own once its only window closes
 *      (a blocked host has no session to keep alive);
 *   7. host E, blocked by C: C dies, and *Open anyway* on E TAKES the free lock
 *      instead of overriding it (Dexter, PR #71 F1).
 *
 * SAFE: `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing is billed. Side
 * effect: step 5 allocates a port block for the temp repo in the real
 * ~\.claude-custom\worktree-ports.json; the folder is deleted afterwards, so
 * the next allocation anywhere gives the block back.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-lock-'));
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

function attach(h) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}?token=${encodeURIComponent(h.token)}`);
    const conn = { ws, msgs: [], out: '' };
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { conn.out += raw.toString('utf8'); return; }   // the pty's own bytes
      try { conn.msgs.push(JSON.parse(raw.toString())); } catch { /* not control */ }
    });
    ws.on('open', () => resolve(conn));
    ws.on('error', reject);
  });
}

async function waitMsg(conn, pred, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const m = conn.msgs.find(pred);
    if (m) return m;
    await sleep(50);
  }
  throw new Error(`no matching control message within ${ms}ms: ${JSON.stringify(conn.msgs.map(m => m.type))}`);
}

const readLockFile = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ok  ${what}`); };

(async () => {
  // 1. A holds.
  const a = startHost('A', await freePort());
  await waitFor(a, /session lock {2}:.*"state":"held"/);
  await waitFor(a, /pty pid {7}: (\d+)/);
  await sleep(300);
  const aLock = readLockFile();
  check(aLock.pid === a.child.pid, `A's lock names host A (pid ${a.child.pid})`);
  check(Number.isInteger(aLock.claudePid), `A's lock carries its claude pid (${aLock.claudePid})`);
  check(aLock.port === a.port && typeof aLock.processStartedAt === 'string', 'A\'s lock carries its port and OS start time');

  // 2. B is blocked, and spawns nothing.
  const b = startHost('B', await freePort());
  await waitFor(b, /session lock {2}:.*"state":"blocked"/);
  await waitFor(b, /listening on ws:/);
  const bConn = await attach(b);
  const hello = await waitMsg(bConn, m => m.type === 'hello');
  check(hello.lock && hello.lock.state === 'blocked' && hello.lock.holder.pid === a.child.pid,
    `B's hello says blocked by A (${JSON.stringify(hello.lock)})`);
  await sleep(500);
  check(!/pty pid/.test(b.out), 'B has not spawned a pty');
  check(readLockFile().pid === a.child.pid, 'the lock still names A');

  // 3. Open anyway -- after the blocked window was resized (Miguel, PR #71 R1:
  // the session must start at the window's size, not a fixed 120x30).
  bConn.ws.send(JSON.stringify({ type: 'resize', cols: 97, rows: 33 }));
  await sleep(200);
  bConn.ws.send(JSON.stringify({ type: 'lock-override' }));
  const lockMsg = await waitMsg(bConn, m => m.type === 'lock' && m.lock.state === 'override');
  check(lockMsg.lock.holder.pid === a.child.pid, 'B broadcasts override, still naming A');
  await waitFor(b, /pty pid {7}: \d+/);
  check(true, 'B started its session after Open anyway');
  check(readLockFile().pid === a.child.pid, 'the override did not take the lock from A');
  await sleep(800);
  bConn.ws.send(JSON.stringify({ type: 'input', data: 'mode con\r' }));
  const sizeUntil = Date.now() + 8000;
  while (!/Columns:\s+\d+/.test(bConn.out) && Date.now() < sizeUntil) await sleep(100);
  const cols = /Columns:\s+(\d+)/.exec(bConn.out);
  check(cols && Number(cols[1]) === 97, `B's pty started at the window's 97 columns (mode con says ${cols ? cols[1] : 'nothing'})`);
  bConn.ws.close();

  // 4. A killed outright; C takes over.
  execFileSync('taskkill', ['/PID', String(a.child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(500);
  check(readLockFile().pid === a.child.pid, 'A\'s lock survived A (killed, no exit handler)');
  const c = startHost('C', await freePort());
  await waitFor(c, /session lock {2}:.*"state":"held"/);
  check(readLockFile().pid === c.child.pid, 'C took the dead host\'s lock over');

  // 5. C's worktree env.
  const envLine = await waitFor(c, /worktree env {2}: (\{.*\})/);
  const env = JSON.parse(envLine[1]);
  check(env.WORKTREE_NAME === path.basename(repo), `WORKTREE_NAME is the folder (${env.WORKTREE_NAME})`);
  check(typeof env.COMPOSE_PROJECT_NAME === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(env.COMPOSE_PROJECT_NAME),
    `COMPOSE_PROJECT_NAME is normalised (${env.COMPOSE_PROJECT_NAME})`);
  check(/^\d+$/.test(env.WORKTREE_PORT_BASE || ''), `WORKTREE_PORT_BASE is set (${env.WORKTREE_PORT_BASE})`);

  // 6. A blocked host whose only window closes exits on its own.
  const d = startHost('D', await freePort());
  await waitFor(d, /session lock {2}:.*"state":"blocked"/);
  await waitFor(d, /listening on ws:/);
  const dConn = await attach(d);
  await waitMsg(dConn, m => m.type === 'hello');
  dConn.ws.close();
  const until = Date.now() + 10000;
  while (d.child.exitCode === null && Date.now() < until) await sleep(100);
  check(d.child.exitCode === 0 && /blocked, no session and no window: exiting/.test(d.out),
    'a blocked host exits once its last window has gone');
  check(readLockFile().pid === c.child.pid, 'and leaves the holder\'s lock alone');

  // 7. Dexter, PR #71 F1: E is blocked by C; C dies; *Open anyway* on E must
  // TAKE the now-free lock, not start an unlocked second session beside it.
  const e = startHost('E', await freePort());
  await waitFor(e, /session lock {2}:.*"state":"blocked"/);
  await waitFor(e, /listening on ws:/);
  const eConn = await attach(e);
  await waitMsg(eConn, m => m.type === 'hello');
  execFileSync('taskkill', ['/PID', String(c.child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(500);
  eConn.ws.send(JSON.stringify({ type: 'lock-override' }));
  const taken = await waitMsg(eConn, m => m.type === 'lock' && m.lock.state !== 'blocked');
  check(taken.lock.state === 'held', `Open anyway on a dead holder's lock takes it (state ${taken.lock.state})`);
  await waitFor(e, /pty pid {7}: \d+/);
  check(readLockFile().pid === e.child.pid, 'the lock now names E');
  eConn.ws.close();

  console.log('PASS: the session lock holds in real hosts');
  finish(0);
})().catch((err) => {
  console.log(err && err.message);
  for (const h of hosts) console.log(`---- ${h.name} ----\n${h.out}`);
  finish(1);
});

function finish(code) {
  for (const h of hosts) {
    try { execFileSync('taskkill', ['/PID', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  setTimeout(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }, 500);
}
