'use strict';
/**
 * Does the kill switch stop a REAL host's session, and keep a new one from starting? (documentation/PLAN_SAFETY_NET.md lane 2;
 * host/kill-switch.js, wired in host/host.js.) The unit tests pin the logic with fake timers and a fake pty; this runs host/host.js
 * for real, with a real pty, and measures:
 *
 *   A  a project STOP appearing ends the session's tree within 5 s, host.log (the host's stdout) names the file, the host exits
 *   B  a host started while that STOP is still there never spawns its claude, says why, and goes by itself with no window
 *   C  with the STOP deleted a fresh host starts normally, and a STOP-ALL appearing stops it, naming STOP-ALL
 *
 * SAFE TO RUN ANYWHERE. `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing is billed. The project is a throwaway git repo in the
 * temp folder; STOP-ALL is under a throwaway claude home through the probe seam (CLAUDE_CUSTOM_CLAUDE_HOME, host/probe-seams.js),
 * so the real ~/.claude/STOP-ALL is never written and no other session on this machine is touched. Every CLAUDE_CUSTOM_* and
 * ELECTRON_RUN_AS_NODE is stripped from the hosts' environment first (CLAUDE.md traps). Only processes this probe started are
 * stopped, through their own handles (verify/lib/process-hygiene.js), never by name.
 *
 * No Electron and no window, so it doesn't take the heavy lock: three plain node hosts, one at a time, each a few seconds.
 *
 * Run: node verify/probe-kill-switch.js        (exit 0 = all three held)
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createHygieneRegistry, killChildTree } = require('./lib/process-hygiene');

const ROOT = path.join(__dirname, '..');
const hygiene = createHygieneRegistry();
hygiene.install();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-killswitch-'));
const repo = path.join(tmp, 'proj');
const claudeHome = path.join(tmp, 'claude-home');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(claudeHome, { recursive: true });
spawnSync('git', ['init', '-q', repo], { windowsHide: true });
const PROJECT_STOP = path.join(repo, '.claude-custom', 'STOP');
const STOP_ALL = path.join(claudeHome, 'STOP-ALL');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startHost() {
  const port = await freePort();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('CLAUDE_CUSTOM_')) env[k] = v;
  Object.assign(env, {
    CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    CLAUDE_CUSTOM_CWD: repo,
    CLAUDE_CUSTOM_PORT: String(port),
    CLAUDE_CUSTOM_CLAUDE_HOME: claudeHome,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env, windowsHide: true });
  hygiene.registerChild(child);
  const h = { child, out: '', exited: false, exitAt: null };
  child.stdout.on('data', (d) => { h.out += d; });
  child.stderr.on('data', (d) => { h.out += d; });
  child.on('exit', () => { h.exited = true; h.exitAt = Date.now(); });
  return h;
}

async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return fn();
}
const ptyPid = (h) => { const m = /pty pid\s*:\s*(\d+)/.exec(h.out); return m ? Number(m[1]) : null; };
function stopHost(h) { if (h && !h.exited) killChildTree(h.child); }

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

(async () => {
  // --- A: a session running, then the project's STOP appears ---------------------------------------------------------
  const a = await startHost();
  const pidA = await until(() => ptyPid(a), 20000);
  check('A0 the host spawned its stand-in claude', !!pidA && alive(pidA), `pid ${pidA}`);
  await sleep(1500);                                         // past the first poll, so the trip is a poll's, not the start check's
  fs.mkdirSync(path.dirname(PROJECT_STOP), { recursive: true });
  fs.writeFileSync(PROJECT_STOP, 'probe\n');
  const t0 = Date.now();
  const gone = await until(() => pidA && !alive(pidA), 8000);
  const took = Date.now() - t0;
  check('A1 the session tree ended within 5 s of the STOP appearing', !!gone && took <= 5000, `${took} ms`);
  await until(() => a.exited, 8000);
  check('A2 host.log names the sentinel that tripped it', a.out.includes('[kill-switch] Kill switch: ' + PROJECT_STOP + ' appeared'));
  check('A3 the host exited with its claude', a.exited);
  check('A4 the sentinel was left in place', fs.existsSync(PROJECT_STOP));
  stopHost(a);

  // --- B: a host started while the STOP is still there -------------------------------------------------------------
  const b = await startHost();
  await until(() => /not starting claude/.test(b.out), 20000);
  check('B1 it did not spawn claude', ptyPid(b) === null && /not starting claude: the kill switch stopped this host/.test(b.out));
  check('B2 it said which file and how to undo it', b.out.includes('[kill-switch] Kill switch: ' + PROJECT_STOP + ' exists, so claude was not started'));
  const bStart = Date.now();
  await until(() => b.exited, 40000, 250);
  check('B3 with no window it went by itself after the grace', b.exited && /stopped by the kill switch, no session and no window: exiting/.test(b.out),
    b.exited ? `${Math.round((b.exitAt - bStart) / 1000)} s after its refusal` : 'still running after 40 s');
  stopHost(b);

  // --- C: STOP deleted, a fresh host starts; then STOP-ALL ---------------------------------------------------------
  fs.rmSync(PROJECT_STOP, { force: true });
  const c = await startHost();
  const pidC = await until(() => ptyPid(c), 20000);
  check('C1 with the STOP deleted a fresh host starts its claude', !!pidC && alive(pidC), `pid ${pidC}`);
  await sleep(1500);
  fs.writeFileSync(STOP_ALL, 'probe\n');
  const t1 = Date.now();
  const goneC = await until(() => pidC && !alive(pidC), 8000);
  const tookC = Date.now() - t1;
  check('C2 STOP-ALL ends it within 5 s', !!goneC && tookC <= 5000, `${tookC} ms`);
  await until(() => c.exited, 8000);
  check('C3 host.log names STOP-ALL', c.out.includes('[kill-switch] Kill switch: ' + STOP_ALL + ' appeared'));
  stopHost(c);
})().catch((err) => {
  check('the probe ran to the end', false, err && err.stack);
}).finally(async () => {
  hygiene._emergencyCleanup('done');
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: a host's handle may linger a moment */ }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} held`);
  process.exit(failed ? 1 : 0);
});
