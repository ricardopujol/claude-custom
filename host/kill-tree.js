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
 */
const { spawn, spawnSync } = require('child_process');

// child is a Node ChildProcess (has .pid, .exitCode, .kill()) -- the shape
// host/host.js's own spawned children (the health runner, the launcher) have.
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // The try/catch below does NOT catch this: a ChildProcess reports a failed
    // spawn through an ASYNC 'error' event, and an EventEmitter with no 'error'
    // listener THROWS -- an uncaught exception that kills the host (or a probe)
    // and any live Claude session with it. Reproduced: taskkill missing from
    // PATH exits the host with ENOENT.
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
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
function killPidTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (r.error) console.log('[kill-tree] taskkill failed:', r.error.code || r.error.message, '- falling back');
      else return;
    } catch (err) { console.log('[kill-tree] taskkill threw:', err.message, '- falling back'); }
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

module.exports = { killTree, killPidTree };
