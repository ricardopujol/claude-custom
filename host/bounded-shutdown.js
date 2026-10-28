'use strict';
/**
 * A host's WHOLE shutdown runs under a watchdog, so a host told to stop exits even when the pty teardown blocks (BACKLOG #121).
 *
 * The teardown is synchronous native work (killChildTree is a spawnSync of PowerShell, node-pty's kill() a native call), so a
 * `setTimeout` on the host's own event loop can't bound it: a blocked loop never fires its timers. A worker thread can't either
 * (measured: it doesn't start while the main thread is blocked). So the watchdog is a separate process (host/bounded-watchdog.js),
 * spawned before the teardown. It ends the host after the bound, and leaves on its own the moment the host is gone or it is disarmed.
 *
 * The steps keep their order. What the host holds (the session lock, the identity file) is released AFTER the pty is dead, because
 * both mean "a live claude is in this worktree" (PR #217 Dexter F1, F2); the watchdog's kill makes them stale within the bound.
 */
const { spawn } = require('child_process');
const path = require('path');
const { KILL_PROVEN_TIMEOUT_MS, killPidTree } = require('./kill-tree');

// Above every timeout inside the teardown it covers (killProven's, 30 s) plus a margin, so a slow but healthy stop is never cut
// short and the steps after the pty still run (PR #217 Dexter F3).
const SHUTDOWN_BOUND_MS = KILL_PROVEN_TIMEOUT_MS + 15000;

/** Starts the watchdog; the returned function disarms it. `start` is the host's start time (FILETIME string) for the kill's proof. */
function armWatchdog({ boundMs = SHUTDOWN_BOUND_MS, logFile = null, pid = process.pid, start = null, killTree = killPidTree } = {}) {
  let child = null;
  try {
    child = spawn(process.execPath, [path.join(__dirname, 'bounded-watchdog.js'), String(pid), String(boundMs), logFile || '', start || ''], {
      stdio: 'ignore', windowsHide: true, detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', () => {});
    child.unref();
  } catch { child = null; }
  // The watchdog's TREE, not just its node: at the deadline it may already have started a killProven PowerShell, which would
  // taskkill a host whose stop just finished (PR #217 round 2 N2). kill-ok(held-handle): the watchdog this call spawned.
  const disarm = () => { if (child) { try { killTree(child.pid); } catch { /* already gone */ } try { child.kill(); } catch { /* already gone */ } } };
  disarm.pid = child ? child.pid : null;
  return disarm;
}

/**
 * steps: run in order under the watchdog, each isolated (one throw skips none). The caller puts the steps that can block first and
 * the releases after them.
 */
function runShutdown({ steps = [], boundMs = SHUTDOWN_BOUND_MS, logFile = null, start = null, arm = (ms) => armWatchdog({ boundMs: ms, logFile, start }) } = {}) {
  const disarm = arm(boundMs);
  for (const s of steps) { try { s(); } catch { /* best effort */ } }
  try { disarm(); } catch { /* nothing to disarm */ }
}

module.exports = { runShutdown, armWatchdog, SHUTDOWN_BOUND_MS };
