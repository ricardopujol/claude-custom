'use strict';
/**
 * Kill a process tree, not just its top pid.
 *
 * Extracted from host/host.js (Miguel, PR #61 review, finding H3): the only
 * vetted implementation of this lived inline in the host, and a probe that
 * needs the same guarantee (a `child.kill()`/`term.kill()` on Windows kills
 * ONE process, not the tree beneath it -- verify/probe-pause.js's own
 * findings show the real CLI's Bash tool nests three nested bash.exe layers
 * before the real leaf) was about to reimplement a thinner, unguarded copy
 * of it. This is the single source of truth both host/host.js and verify/
 * probes require.
 *
 * Dexter, PR #61 review round 2: confirmed this extraction is
 * behaviour-preserving for `killTree`/host.js (no finding there). `spawnFn`
 * below is an ADDITIVE optional parameter (default unchanged) purely so
 * test/probe-hygiene.test.js can inject a fake `spawn` and exercise the
 * 'error'-listener fallback without actually depending on `taskkill` being
 * absent from this machine's PATH.
 */
const { spawn, spawnSync } = require('child_process');

// child is a Node ChildProcess (has .pid, .exitCode, .kill()) -- the shape
// host/host.js's own spawned children (the health runner, the launcher) have.
function killTree(child, { spawnFn = spawn } = {}) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // The try/catch below does NOT catch this: a ChildProcess reports a failed
    // spawn through an ASYNC 'error' event, and an EventEmitter with no 'error'
    // listener THROWS -- an uncaught exception that kills the host (or a probe)
    // and any live Claude session with it. Reproduced: taskkill missing from
    // PATH exits the host with ENOENT.
    try {
      const killer = spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', (err) => {
        console.log('[kill-tree] taskkill failed:', err.code || err.message, '- falling back');
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      });
      return;
    } catch { /* fall through to the portable kill */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// killPidTree is the same primitive for callers that only have a raw pid --
// a Win32_Process table row, or a node-pty IPty's .pid -- not a Node
// ChildProcess object. Synchronous (spawnSync, not spawn+'error' listener):
// callers needing this are cleanup paths (SIGINT handlers, `finally` blocks)
// where "did it actually finish before we exit" matters more than not
// blocking the event loop for the ~50-100ms taskkill takes.
//
// Windows only: taskkill /T walks the tree. Off Windows this sends SIGTERM to
// the single given pid -- NOT a tree kill (Dexter, PR #61 review, finding 5).
// No shipped caller relies on tree semantics off Windows today: probe-pause.js
// gates its whole suspend/resume path on win32, and probe-local-model.js only
// sets `shell: true` (the thing that makes a tree possible in the first
// place) on win32. A future non-Windows caller that needs a real tree kill
// must not assume this function gives it one.
function killPidTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (r.error) {
        console.log('[kill-tree] taskkill could not be run:', r.error.code || r.error.message, '- falling back');
      } else if (r.status !== 0) {
        // Finding 3 (Dexter, PR #61 review): `r.error` is only set when
        // taskkill itself couldn't be spawned. When it runs and FAILS --
        // status 128 "process not found" (already dead, or a stale pid) or
        // 1 "Access is denied" (an elevated process, or a partial tree
        // failure) -- the old code treated that as success and returned
        // silently, leaving the target alive with no fallback attempted.
        const detail = (r.stderr || '').toString().trim();
        console.log(`[kill-tree] taskkill exited ${r.status} for pid ${pid}${detail ? ` (${detail})` : ''} - falling back`);
      } else {
        return; // genuine success: status 0, no spawn error
      }
    } catch (err) { console.log('[kill-tree] taskkill threw:', err.message, '- falling back'); }
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

module.exports = { killTree, killPidTree };
