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
 */
const { spawn } = require('child_process');
const { killPidTree } = require('../../host/kill-tree');

function spawnWithTimeout({ cmd, args = [], env, cwd, timeoutMs, shell = false, killFn = killPidTree }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(cmd, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell });
    const timer = setTimeout(() => {
      timedOut = true;
      killFn(child.pid);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, pid: child.pid });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, pid: child.pid, error: err.message });
    });
  });
}

module.exports = { spawnWithTimeout };
