'use strict';
/**
 * Does host/host.js actually BOOT -- load every line, listen, and tick?
 *
 * WHY THIS EXISTS. host.js is ~1300 lines of module-level wiring that no unit
 * test can require without starting a real host, so a load-order defect is
 * invisible to the suite. PR #34 (fix for Dexter's Finding 6) wired
 * `createProcessesBroadcast(broadcastControl)` ~300 lines ABOVE
 * `const broadcastControl = ...`: every unit test passed, `node --check`
 * passed, and the host died at startup with
 *
 *   ReferenceError: Cannot access 'broadcastControl' before initialization
 *
 * This probe booted a copy with that line and saw exactly that; with the
 * closure fix it reaches "listening" and its first tick.
 *
 * SAFE TO RUN ANYWHERE. `claude` is replaced by cmd.exe through
 * CLAUDE_CUSTOM_BIN, so no session starts and nothing is billed (this machine
 * has ANTHROPIC_API_KEY set globally -- see the build log). The cwd is a
 * throwaway temp folder and the port is a spare one.
 *
 * Run: node verify/probe-host-boot.js           (exit 0 = booted and ticked)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-boot-'));

// Wrap the tick so "it ticked" is observed, not inferred from silence.
const bootstrap = `
const Module = require('module'); const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = orig.apply(this, arguments);
  if (id === './processes-broadcast') {
    const make = m.createProcessesBroadcast;
    return { createProcessesBroadcast: (b) => { const x = make(b); const t = x.tick;
      x.tick = (r, p) => { console.log('[probe] tick'); return t(r, p); }; return x; } };
  }
  return m;
};
require(${JSON.stringify(path.join(ROOT, 'host', 'host.js'))});`;

// A port the OS says is free right now (Miguel, PR #34 r1, S4: a random pick
// from a 90-port range could collide and read as a boot failure). There is
// still a gap before the host binds it, so a collision is also DETECTED below
// and reported as what it is.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

(async () => {
const port = String(await freePort());
const env = { ...process.env,
  CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
  CLAUDE_CUSTOM_CWD: cwd, CLAUDE_CUSTOM_PORT: port };
// Claude Code is itself an Electron app: an inherited ELECTRON_RUN_AS_NODE is
// harmless for plain node, but never let it leak into anything this spawns.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, ['-e', bootstrap], { cwd: ROOT, env });
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

const done = (ok, why) => {
  try { child.kill(); } catch { /* already gone */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(ok ? `PASS: ${why}` : `FAIL: ${why}\n----\n${out}`);
  process.exit(ok ? 0 : 1);
};

const timer = setInterval(() => {
  if (/EADDRINUSE/.test(out)) done(false, `port ${port} was taken before the host bound it -- a collision, not a boot failure; re-run`);
  else if (/ReferenceError|TypeError|SyntaxError/.test(out)) done(false, 'the host threw while loading');
  else if (/listening on ws:/.test(out) && /\[probe\] tick/.test(out)) done(true, 'host loaded, listened and ticked');
}, 100);
child.on('exit', () => {
  clearInterval(timer);
  if (/EADDRINUSE/.test(out)) done(false, `port ${port} was taken before the host bound it -- a collision, not a boot failure; re-run`);
  else if (/ReferenceError|TypeError|SyntaxError/.test(out)) done(false, 'the host threw while loading');
  else done(/\[probe\] tick/.test(out), 'host exited');
});
setTimeout(() => done(false, 'no listen + tick within 15s'), 15000);
})().catch((err) => { console.log(`FAIL: probe could not start: ${err && err.message}`); process.exit(1); });
