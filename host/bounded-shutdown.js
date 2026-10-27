'use strict';
/**
 * A host told to stop frees what it holds FIRST and then tears the pty down under a watchdog (BACKLOG #121).
 *
 * The teardown is synchronous native work (killChildTree is a spawnSync of taskkill, node-pty's kill() a native call), so a
 * `setTimeout` on the host's own event loop can't bound it: a blocked loop never fires its timers. A worker thread can't either
 * (measured: it doesn't start while the main thread is blocked). So the watchdog is a separate process, spawned before the
 * teardown. It ends the host after the bound, and leaves on its own the moment the host is gone or it is disarmed.
 */
const { spawn } = require('child_process');

// Over the slowest stop measured (a cold one took 7.8 s, a warm one 1.0 to 1.7 s).
const SHUTDOWN_BOUND_MS = 10000;

const WATCHDOG = `
const [pid, boundMs, logFile] = [Number(process.argv[1]), Number(process.argv[2]), process.argv[3]];
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
const end = Date.now() + boundMs;
setInterval(() => {
  if (!alive()) process.exit(0);
  if (Date.now() < end) return;
  if (logFile) { try { require('fs').appendFileSync(logFile, '[host] shutdown: the pty teardown did not finish within ' + boundMs + ' ms; exiting anyway\\n'); } catch {} }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  process.exit(0);
}, 100);
`;

/** Starts the watchdog; the returned function disarms it. */
function armWatchdog({ boundMs = SHUTDOWN_BOUND_MS, logFile = null, pid = process.pid } = {}) {
  let child = null;
  try {
    child = spawn(process.execPath, ['-e', WATCHDOG, String(pid), String(boundMs), logFile || ''], {
      stdio: 'ignore', windowsHide: true, detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', () => {});
    child.unref();
  } catch { child = null; }
  return () => { if (child) { try { child.kill(); } catch { /* already gone */ } } };   // kill-ok(held-handle): the watchdog this call spawned
}

/**
 * release: steps that free what other processes wait on (session lock, quota lease, identity file), run first.
 * teardown: the steps that can block (the pty, the servers), run under the watchdog. Each step is isolated: one throw skips none.
 */
function runShutdown({ release = [], teardown = [], boundMs = SHUTDOWN_BOUND_MS, logFile = null, arm = (ms) => armWatchdog({ boundMs: ms, logFile }) } = {}) {
  const each = (steps) => { for (const s of steps) { try { s(); } catch { /* best effort */ } } };
  each(release);
  const disarm = arm(boundMs);
  each(teardown);
  try { disarm(); } catch { /* nothing to disarm */ }
}

module.exports = { runShutdown, armWatchdog, SHUTDOWN_BOUND_MS };
