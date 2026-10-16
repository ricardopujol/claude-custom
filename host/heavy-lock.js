'use strict';
/**
 * The machine-wide heavy-work lock, taken by the code that does the heavy work (BACKLOG #100 d). It wraps
 * ~\.claude\scripts\heavy-lock.ps1 (shared by every project, never edited from here): that script queues
 * Electron probes and full test runs so several lanes can't pin the machine at once. It used to work only if each caller
 * remembered to take it by hand.
 *
 * WHO TAKES IT
 *   - `npm test` runs through scripts/with-heavy-lock.js, which acquires, runs the suite, and releases on every way out.
 *   - A probe (a verify/probe-*.js process) takes it when verify/lib/launch-electron.js is first required, which every
 *     probe does before it spawns anything heavy, and releases when that probe process ends: normal exit, error,
 *     SIGINT, SIGTERM, SIGHUP. Its Electron trees are stopped first, then the slot is freed.
 *
 * RE-ENTRANCY. Whoever holds the lock sets the environment variable HEAVY_LOCK_HELD=1 for everything it starts, and
 * anything that finds it set to exactly "1" does not try to take the lock again (the second asker would wait on its own
 * parent). A person who took the lock by hand does the same, and unsets it after:
 *
 *   powershell -File ~\.claude\scripts\heavy-lock.ps1 -Acquire -Owner "<lane>: <what>"
 *   $env:HEAVY_LOCK_HELD = '1'        # PowerShell;  Git Bash: export HEAVY_LOCK_HELD=1
 *   npm test                           # and the probes: they see the flag and skip the lock
 *   heavy-lock.ps1 -Release -Owner "<lane>: <what>"
 *   Remove-Item Env:HEAVY_LOCK_HELD   # Git Bash: unset HEAVY_LOCK_HELD. Forget this and the shell stays exempt.
 *
 * WAIT. A busy slot is waited for 8 minutes (under the Bash tool's 10-minute cap, so one tool call can wait its whole
 * turn); HEAVY_LOCK_WAIT_MINUTES changes it.
 *
 * DEAD HOLDERS. A holder that is killed hard (a tool timeout, taskkill /F) never releases, and heavy-lock.ps1 only frees
 * a hold after 60 minutes. So every Owner this module writes ends in "(pid N start T)" (T: the process start time, a
 * FILETIME as in host/proc-start.js). Before acquiring, and again when the slot is still busy after the wait, the holder
 * is read from the script's status; if it has that shape and the process is gone (or its pid now has another start time),
 * it is released with its own exact owner string and the acquire is tried again. A holder without that shape (a manual
 * one) or a live one is never touched.
 *
 * THE THREE WAYS NOT TO HOLD IT
 *   - 'reentrant': the flag was already set. Nothing is acquired, and release() does nothing (never clears a flag it
 *     didn't set, never releases a lock it didn't take).
 *   - 'missing': the script isn't on this machine. One warning line, and the work runs without the lock.
 *   - busy / too loaded / any other failure: HeavyLockError. The work does NOT run anyway; the message names the holder
 *     and says what to do next.
 *
 * Every dependency (the script runner, spawn, the existence check, the env, the process) is injectable, so tests never
 * touch the real lock.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POWERSHELL } = require('./proc-start');

const ENV_VAR = 'HEAVY_LOCK_HELD';
const WAIT_VAR = 'HEAVY_LOCK_WAIT_MINUTES';
const DEFAULT_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'heavy-lock.ps1');
const DEFAULT_WAIT_MINUTES = 8;
const HINT = 'Wait and retry; if you hold the lock by hand, set HEAVY_LOCK_HELD=1 (see host/heavy-lock.js).';

const waitFromEnv = (env) => { const n = Number(env && env[WAIT_VAR]); return Number.isInteger(n) && n > 0 ? n : DEFAULT_WAIT_MINUTES; };
const isHeld = (env) => !!env && env[ENV_VAR] === '1';

class HeavyLockError extends Error {
  constructor(code, message) { super(message); this.name = 'HeavyLockError'; this.code = code; }
}

// Closed with a paren so that "(pid 1 ...)" is never a prefix of "(pid 12 ...)": the script releases by StartsWith(owner).
// With a start time the owner is "<label> (pid N start T)", the shape a later asker can prove dead.
const ownerFor = (label, pid = process.pid, start = null) =>
  (typeof start === 'string' && /^\d+$/.test(start)) ? `${label} (pid ${pid} start ${start})` : `${label} (pid ${pid})`;

function parseOwner(text) {
  const m = /\(pid (\d+) start (\d+)\)/.exec(String(text || ''));
  return m ? { pid: Number(m[1]), start: m[2] } : null;
}

// Start times as FILETIME strings by pid, synchronously (an acquire is a synchronous call). A Map (a pid that isn't in
// it is not running), or null when the query could not be run: "can't tell" is never "dead".
function queryStarts(pids, spawnFn = spawnSync) {
  const wanted = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 0);
  if (!wanted.length) return new Map();
  const script = "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-Process -Id ${wanted.join(',')} | Where-Object { -not $_.HasExited } | ForEach-Object { ` +
    'if ($_.StartTime) { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } else { "$($_.Id) ?" } }; ' + "'END'";
  let r;
  try {
    r = spawnFn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  } catch { return null; }
  const lines = String((r && r.stdout) || '').split(/\r?\n/).map(l => l.trim());
  if (!r || r.error || !lines.includes('END')) return null;
  const out = new Map();
  for (const l of lines) {
    const m = /^(\d+) (\d+|\?)$/.exec(l);
    if (m) out.set(Number(m[1]), m[2] === '?' ? null : m[2]);
  }
  return out;
}

// powershell.exe by its absolute path (PR #71 G1: a bare name is looked up in the cwd first, and the cwd is the repo).
// The call is bounded by a timeout, and a failure to even start says why.
function defaultRun(scriptPath, { spawnFn = spawnSync, timeoutMs = (DEFAULT_WAIT_MINUTES + 2) * 60000 } = {}) {
  return (args) => {
    const r = spawnFn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    let out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (r.error) out = `${out} [${r.error.code || ''} ${r.error.message}]`.trim();
    else if (r.signal) out = `${out} [powershell ended by ${r.signal}]`.trim();
    return { status: r.status, stdout: out };
  };
}

function release({ owner, scriptPath = DEFAULT_SCRIPT, run = defaultRun(scriptPath), log = console.log } = {}) {
  let r;
  try { r = run(['-Release', '-Owner', owner]); } catch (err) { r = { status: null, stdout: err && err.message }; }
  if (r && r.status === 0) return true;
  log(`[heavy-lock] could not release "${owner}": ${(r && r.stdout) || 'no answer from the script'}`);
  return false;
}

// If the slot's holder wears the "(pid N start T)" shape and that process is gone, release it by its exact owner string.
function reclaimDead({ run, startsOf, log }) {
  let st;
  try { st = run([]); } catch { return false; }
  const m = /^held: (.*)$/m.exec((st && st.stdout) || '');
  if (!m) return false;
  const holder = m[1].trim();
  const p = parseOwner(holder);
  if (!p) return false;                                   // a manual holder, or one with no proof: never touched
  let starts = null;
  try { starts = startsOf([p.pid]); } catch { /* could not ask */ }
  if (!starts) return false;                              // could not ask: not "dead"
  const now = starts.get(p.pid);
  const dead = !starts.has(p.pid) || (typeof now === 'string' && now !== p.start);
  if (!dead) return false;
  let r;
  try { r = run(['-Release', '-Owner', holder]); } catch { return false; }
  if (!r || r.status !== 0) return false;
  log(`[heavy-lock] freed the slot of a dead holder: ${holder}`);
  return true;
}

/** Blocks (a synchronous script call) until the lock is held. Returns { state, release() }; throws HeavyLockError. */
function acquire({
  label = 'claude-custom', pid = process.pid, env = process.env, waitMinutes = waitFromEnv(env),
  scriptPath = DEFAULT_SCRIPT, spawnFn = spawnSync,
  run = defaultRun(scriptPath, { spawnFn, timeoutMs: (waitMinutes + 2) * 60000 }),
  exists = fs.existsSync, log = console.log, startsOf = (pids) => queryStarts(pids, spawnFn),
} = {}) {
  if (isHeld(env)) return { state: 'reentrant', release: () => false };
  if (!exists(scriptPath)) {
    log(`[heavy-lock] ${scriptPath} not found; running without the heavy-work lock`);
    return { state: 'missing', release: () => false };
  }
  let ownStart = null;
  try { const m = startsOf([pid]); const v = m && m.get(pid); ownStart = typeof v === 'string' ? v : null; } catch { /* owner without a start */ }
  const owner = ownerFor(label, pid, ownStart);
  reclaimDead({ run, startsOf, log });
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { r = run(['-Acquire', '-Owner', owner, '-WaitMinutes', String(waitMinutes)]); } catch (err) { r = { status: null, stdout: err && err.message }; }
    // Busy because of a holder (not "n ahead in the queue"): a dead one is freed and the acquire tried once more.
    if (r && r.status === 2 && /^busy: (?!\d+ ahead)/.test(r.stdout || '') && reclaimDead({ run, startsOf, log })) continue;
    break;
  }
  const said = (r && r.stdout) || '';
  if (!r || r.status !== 0) {
    if (r && r.status === 2) throw new HeavyLockError('busy', `${said || 'busy'}. ${HINT}`);
    if (r && r.status === 3) throw new HeavyLockError('loaded', `${said || 'machine too loaded'}. ${HINT}`);
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
 * `beforeRelease` (sync) runs first on every way out: the heavy work is stopped, THEN the slot is freed (Dexter 5).
 * On a signal the process exits (and so releases) only if nothing else listens for it; a probe with its own handler
 * keeps its slot until its process really ends.
 */
function createProcessLock({ proc = process, label = 'probe', beforeRelease = null, ...opts } = {}) {
  let lock = null;
  return {
    ensure() {
      if (lock) return lock;
      const l = acquire({ ...opts, label, pid: proc.pid });
      lock = l;
      if (l.state !== 'held') return l;
      const letGo = () => {
        if (beforeRelease) { try { beforeRelease(); } catch { /* the slot is freed regardless */ } }
        l.release();
      };
      proc.on('exit', letGo);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        proc.once(sig, () => {
          if (proc.listenerCount(sig) === 0) { letGo(); proc.exit(sig === 'SIGINT' ? 130 : 143); }
        });
      }
      return l;
    },
  };
}

module.exports = {
  ENV_VAR, WAIT_VAR, DEFAULT_SCRIPT, DEFAULT_WAIT_MINUTES, HeavyLockError, ownerFor, parseOwner, queryStarts, defaultRun,
  acquire, release, createProcessLock,
};
