'use strict';
/**
 * Spawn a child process and guarantee the WHOLE tree dies on timeout, not
 * just the top pid.
 *
 * Written for Miguel's PR #61 review, H3: verify/probe-local-model.js spawned
 * `claude` with `shell: true` on Windows and killed a hung attempt with a bare
 * `child.kill()`. With `shell: true`, `child.pid` is `cmd.exe`'s pid, not the
 * real CLI's -- and the real CLI (spawned with `--allowedTools Bash` and
 * either bypassPermissions or --dangerously-skip-permissions) is a SEPARATE
 * process tree that `cmd.exe` exiting does not cascade into. This helper
 * always tree-kills via host/kill-tree.js's killPidTree on timeout, and is
 * generic (no `claude`-specific knowledge) so a test can exercise the real
 * timeout->kill path against a throwaway Node child instead of the real CLI.
 *
 * Dexter, PR #61 review round 2 (findings 1 & 2) on the first version of this
 * file: it only ever settled/cleared its timer on the child's stdio 'close'
 * event, which waits for EVERY holder of the stdout/stderr pipes to close
 * them -- not just the direct child. A detached grandchild that inherited
 * those pipes (or a `claude` Bash background task that re-parents out of the
 * tree) can hold them open forever. Two failures followed from that single
 * bad assumption:
 *   (1) the promise never settled, hanging every caller indefinitely
 *       (Finding 2) -- and
 *   (2) if the timer DID fire while the pipe stayed open, it force-killed
 *       `child.pid` even though that specific process might already be dead
 *       and its pid recycled by the OS for something unrelated by then
 *       (Finding 1). Windows reuses pids aggressively.
 * The fix tracks the child's own 'exit' (fires independent of pipe state)
 * separately from stdio 'close', settles on whichever of exit/close/error/
 * timeout happens first, and only calls killFn while the child is still
 * confirmed alive.
 */
const { spawn } = require('child_process');
const { killPidTree, killChildTree } = require('../../host/kill-tree');

function spawnWithTimeout({ cmd, args = [], env, cwd, timeoutMs, shell = false, killFn = killPidTree }) {   // kill-ok: the default killFn, reached only through killChildTree(child) on the held child
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let exited = false, exitCode = null;
    const child = spawn(cmd, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell });

    // Settle exactly once, from whichever of exit/close/error/timeout fires
    // first (Finding 2). A small, acknowledged trade-off: settling on 'exit'
    // rather than always waiting for 'close' means a stdout/stderr chunk
    // written in the narrow window between the two can be missed -- an
    // acceptable cost for a probe helper, against the alternative of hanging
    // forever when that window never closes at all.
    const settle = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: exitCode, stdout, stderr, timedOut, pid: child.pid, ...extra });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Finding 1: only kill a pid we know is still the process we spawned.
      // `exited` is set by the 'exit' listener below, which fires as soon as
      // the process terminates -- independent of whether a descendant is
      // still holding its stdio pipes open. If the child has already exited,
      // taskkill /PID <pid> /T /F would be operating on a pid the OS may
      // have since reused for an unrelated process.
      if (!exited) killChildTree(child, { killFn });
      settle();
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    // 'exit' vs 'close': 'exit' fires the moment the process itself
    // terminates; 'close' waits for every stdio pipe to close, which a
    // lingering descendant can hold open indefinitely. Settling here (not
    // only on 'close') is what stops the hang; recording `exited` is what
    // the timeout branch above needs to avoid killing a recycled pid.
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      settle();
    });
    child.on('close', (code) => {
      exitCode = code;
      settle();
    });
    child.on('error', (err) => {
      settle({ error: err.message });
    });
  });
}

module.exports = { spawnWithTimeout };
