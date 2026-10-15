'use strict';
/**
 * The machine-wide heavy-work lock, taken by the code that does the heavy work (BACKLOG #100 d). It wraps
 * C:\Users\ricar\.claude\scripts\heavy-lock.ps1 (shared by every project, never edited from here): that script queues
 * Electron probes and full test runs so several lanes can't pin the machine at once. It used to work only if each caller
 * remembered to take it by hand.
 *
 * WHO TAKES IT
 *   - `npm test` runs through scripts/with-heavy-lock.js, which acquires, runs the suite, and releases on every way out.
 *   - verify/lib/launch-electron.js takes it on a probe's first launch (createProcessLock) and releases when that
 *     probe process ends: normal exit, error, SIGINT, SIGTERM, SIGHUP.
 *
 * RE-ENTRANCY. Whoever holds the lock sets the environment variable HEAVY_LOCK_HELD=1 for everything it starts, and
 * anything that finds it set does not try to take the lock again (the second asker would wait on its own parent for
 * 20 minutes). A person who took the lock by hand does the same:
 *
 *   powershell -File C:\Users\ricar\.claude\scripts\heavy-lock.ps1 -Acquire -Owner "<lane>: <what>"
 *   $env:HEAVY_LOCK_HELD = '1'        # PowerShell;  Git Bash: export HEAVY_LOCK_HELD=1
 *   npm test                           # and the probes: they see the flag and skip the lock
 *   heavy-lock.ps1 -Release -Owner "<lane>: <what>"
 *
 * THE THREE WAYS NOT TO HOLD IT
 *   - 'reentrant': the flag was already set. Nothing is acquired, and release() does nothing (never clears a flag it
 *     didn't set, never releases a lock it didn't take).
 *   - 'missing': the script isn't on this machine. One warning line, and the work runs without the lock.
 *   - busy / too loaded / any other failure: HeavyLockError. The work does NOT run anyway; the message names the holder.
 *
 * Every dependency (the script runner, the existence check, the env, the process) is injectable, so tests never touch the
 * real lock.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_VAR = 'HEAVY_LOCK_HELD';
const DEFAULT_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'heavy-lock.ps1');
const DEFAULT_WAIT_MINUTES = 20;

class HeavyLockError extends Error {
  constructor(code, message) { super(message); this.name = 'HeavyLockError'; this.code = code; }
}

// Closed with a paren so that "(pid 1)" is never a prefix of "(pid 12)": the script releases by StartsWith(owner).
const ownerFor = (label, pid = process.pid) => `${label} (pid ${pid})`;

function defaultRun(scriptPath) {
  return (args) => {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { encoding: 'utf8', windowsHide: true });
    return { status: r.status, stdout: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
}

function release({ owner, scriptPath = DEFAULT_SCRIPT, run = defaultRun(scriptPath), log = console.log } = {}) {
  let r;
  try { r = run(['-Release', '-Owner', owner]); } catch (err) { r = { status: null, stdout: err && err.message }; }
  if (r && r.status === 0) return true;
  log(`[heavy-lock] could not release "${owner}": ${(r && r.stdout) || 'no answer from the script'}`);
  return false;
}

/** Blocks (a synchronous script call) until the lock is held. Returns { state, release() }; throws HeavyLockError. */
function acquire({
  label = 'claude-custom', pid = process.pid, waitMinutes = DEFAULT_WAIT_MINUTES, env = process.env,
  scriptPath = DEFAULT_SCRIPT, run = defaultRun(scriptPath), exists = fs.existsSync, log = console.log,
} = {}) {
  if (env[ENV_VAR]) return { state: 'reentrant', release: () => false };
  if (!exists(scriptPath)) {
    log(`[heavy-lock] ${scriptPath} not found; running without the heavy-work lock`);
    return { state: 'missing', release: () => false };
  }
  const owner = ownerFor(label, pid);
  let r;
  try { r = run(['-Acquire', '-Owner', owner, '-WaitMinutes', String(waitMinutes)]); } catch (err) { r = { status: null, stdout: err && err.message }; }
  const said = (r && r.stdout) || '';
  if (!r || r.status !== 0) {
    if (r && r.status === 2) throw new HeavyLockError('busy', said || 'busy');
    if (r && r.status === 3) throw new HeavyLockError('loaded', said || 'machine too loaded');
    throw new HeavyLockError('error', `heavy-lock.ps1 failed (exit ${r && r.status}): ${said}`);
  }
  env[ENV_VAR] = '1';
  let done = false;
  return {
    state: 'held', owner,
    release() {
      if (done) return false;
      done = true;
      delete env[ENV_VAR];
      return release({ owner, scriptPath, run, log });
    },
  };
}

/**
 * The lock for a whole process (a probe): `ensure()` takes it once, on the first call, and releases it when the process
 * ends. A failed acquire installs nothing and is tried again by the next ensure() (the caller gets the throw).
 */
function createProcessLock({ proc = process, label = 'probe', ...opts } = {}) {
  let lock = null;
  let warned = false;
  return {
    ensure() {
      if (lock) return lock;
      const log = opts.log || console.log;
      const l = acquire({ ...opts, label, pid: proc.pid, log: (m) => { if (!warned) { warned = true; log(m); } } });
      lock = l;
      if (l.state !== 'held') return l;
      proc.on('exit', () => { l.release(); });
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        proc.once(sig, () => {
          l.release();
          if (proc.listenerCount(sig) === 0) proc.exit(sig === 'SIGINT' ? 130 : 143);
        });
      }
      return l;
    },
  };
}

module.exports = { ENV_VAR, DEFAULT_SCRIPT, HeavyLockError, ownerFor, acquire, release, createProcessLock };
