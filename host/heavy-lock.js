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
 * WAIT. A busy slot is waited for 20 minutes in total; HEAVY_LOCK_WAIT_MINUTES changes it (BACKLOG #178 b). Why 20: one
 * full `npm test` holds the slot about 8 minutes, and the script's load gate (8 GB free, under 70% CPU) adds about a
 * minute between holders when lanes are busy (measured 2026-11-05). Waiting 7, the second lane in a queue always gave up
 * before the first finished. 20 covers one suite ahead with room, and two suites ahead (the common case on a busy day,
 * about 18 minutes) with a little; a third ahead gives up, and says so (below). It's also the script's own default.
 * The total stays bounded: the retry after a reclaim gets only what is left of that budget (at least 1 minute), each
 * -Acquire call is killed 1 minute after its own deadline, and every status and release call has its own 1-minute leash
 * (STATUS_TIMEOUT_MS, #112 Dexter 2: they used to inherit the acquire's long timeout). A wait this long is longer than the
 * Bash tool's 10-minute cap: a call that's moved to the background keeps waiting, and its output file shows the wait.
 * A timed-out call leaves its queue ticket behind, but the script keys a ticket to its waiter's pid and start time and
 * drops a dead one the next time anyone reads the queue (Miguel r2 N4, read from heavy-lock.ps1).
 * WHILE IT WAITS. The -Acquire call is one synchronous spawn that prints nothing, so a small side process
 * (host/heavy-lock-watch.js) runs alongside it: once a minute it prints who holds the slot and how long this asker has
 * waited, and frees a holder that DIED during the wait by the same dead-holder rules as below, so the waiter's own ticket
 * (its place in the queue) then gets the slot. A longer wait never means a dead holder costs the whole wait. The side
 * process is stopped by its handle when the acquire returns, and ends on its own if its asker is gone or the wait is over.
 * GIVING UP. A busy slot after the whole wait is a HeavyLockError carrying who held it and how long it waited; notRunLine()
 * turns it into the last line a caller prints, `[heavy-lock] lock busy for <n> min, held by <owner>: NOT RUN`, and the
 * caller exits NOT_RUN_EXIT (75, EX_TEMPFAIL: "try again later"), never 1, which is what a failing suite exits.
 * QUEUE POSITION. The script owns the tickets, so a retry after a reclaim is a NEW ticket, behind anyone who asked
 * after the first call did (Dexter r2 #2). Node can't keep the place; the fix would be the script reclaiming a dead
 * holder inside its own wait loop (see the Open question in the lane brief). What this module guarantees is the bound.
 *
 * DEAD HOLDERS. A holder that is killed hard (a tool timeout, taskkill /F) never releases, and heavy-lock.ps1 only frees
 * a hold after 60 minutes. So every Owner this module writes ends in "(pid N start T)" (T: the process start time, a
 * FILETIME as in host/proc-start.js). Before acquiring, and again when the slot is still busy after the wait, the holder
 * is read from the script's status; if it has that shape and the process is gone (or its pid now has another start time),
 * it is released with its own exact owner string and the acquire is tried again. A holder without that shape (a manual
 * one) or a live one is never touched.
 * THE WORK COUNTS TOO (Dexter r2 #1). The owner's pid is the asker (the wrapper, the probe). Stopping only that pid leaves
 * its `node --test` or Electron running. So the holder also records its heavy children (lock.addWork(pid): the suite's
 * node, a probe's Electron root) with their start times in a side file next to the lock, and a holder is dead only when
 * the asker AND every recorded child are gone. A side file that can't be read is "can't tell", never "dead".
 * WHAT IS RECORDED, AND WHAT IS NOT (BACKLOG #112). Recorded: the asker (in the owner string), and every heavy child the holder
 * starts and tells the lock about, each with its start time and under the owner that started it. Those are the suite's
 * `node --test` (scripts/with-heavy-lock.js), a probe's Electron root (launch-electron's noteWork) and a host.js or claude
 * a probe starts by hand (launch-electron's noteChild). A child is written first with an unknown start (alive while its pid
 * runs), then again with its start time once that is read, so a hard kill in the 0.5-1.5 s gap still leaves it listed.
 * NOT recorded: grandchildren (what a host.js or the suite's node starts in turn), a probe that starts something without
 * calling noteChild, and a probe that never requires the launcher (it takes no lock at all). Stopping the listed pids can
 * still leave those running.
 * KNOWN LIMIT (Miguel r2 N1): a live process this user can't inspect (elevated) may be missing from the start-time
 * query and so read as gone. Holders are same-user node processes, so it is theoretical today.
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
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POWERSHELL } = require('./proc-start');

const ENV_VAR = 'HEAVY_LOCK_HELD';
const WAIT_VAR = 'HEAVY_LOCK_WAIT_MINUTES';
const DEFAULT_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'heavy-lock.ps1');
const DEFAULT_WAIT_MINUTES = 20;
const STATUS_TIMEOUT_MS = 60000;
const WATCH_EVERY_MS = 60000;
const NOT_RUN_EXIT = 75;
const WATCH_SCRIPT = path.join(__dirname, 'heavy-lock-watch.js');
const WORK_FILE = path.join(os.tmpdir(), 'claude-custom-heavy.work.json');
const HINT = 'Wait and retry; if you hold the lock by hand, set HEAVY_LOCK_HELD=1 (see host/heavy-lock.js).';

const waitFromEnv = (env) => { const n = Number(env && env[WAIT_VAR]); return Number.isInteger(n) && n > 0 ? n : DEFAULT_WAIT_MINUTES; };
const isHeld = (env) => !!env && env[ENV_VAR] === '1';

// `holder`: who held the slot when the wait ended (null: nobody, or unknown); `waitedMs`: how long this asker waited.
class HeavyLockError extends Error {
  constructor(code, message, { holder = null, waitedMs = null, detail = null } = {}) {
    super(message); this.name = 'HeavyLockError'; this.code = code; this.holder = holder; this.waitedMs = waitedMs; this.detail = detail;
  }
}

// The one last line a caller prints when its work did not run, so it can't be misread as a failing run. Any error works:
// a HeavyLockError says why in its own words, anything else is "the lock failed".
function notRunLine(err) {
  const mins = (err && typeof err.waitedMs === 'number') ? `${Math.round(err.waitedMs / 60000)} min` : 'the whole wait';
  if (err && err.code === 'busy') {
    const by = err.holder ? `held by ${err.holder}` : `held by nobody now${err.detail ? ` (${err.detail})` : ''}`;
    return `[heavy-lock] lock busy for ${mins}, ${by}: NOT RUN`;
  }
  if (err && err.code === 'loaded') return `[heavy-lock] machine too loaded for ${mins}${err.detail ? ` (${err.detail})` : ''}: NOT RUN`;
  return `[heavy-lock] the lock could not be taken (${(err && err.message) || 'unknown error'}): NOT RUN`;
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
function defaultRun(scriptPath, { spawnFn = spawnSync, timeoutMs = (DEFAULT_WAIT_MINUTES + 1) * 60000 } = {}) {
  return (args, opts = {}) => {
    const r = spawnFn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: opts.timeoutMs || timeoutMs });
    let out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (r.error) out = `${out} [${r.error.code || ''} ${r.error.message}]`.trim();
    else if (r.signal) out = `${out} [powershell ended by ${r.signal}]`.trim();
    return { status: r.status, stdout: out };
  };
}

function release({ owner, scriptPath = DEFAULT_SCRIPT, run = defaultRun(scriptPath), log = console.log } = {}) {
  let r;
  try { r = run(['-Release', '-Owner', owner], { timeoutMs: STATUS_TIMEOUT_MS }); } catch (err) { r = { status: null, stdout: err && err.message }; }
  if (r && r.status === 0) return true;
  log(`[heavy-lock] could not release "${owner}": ${(r && r.stdout) || 'no answer from the script'}`);
  return false;
}

// The heavy children a holder started, by owner, in a side file. Only the holder writes it (one holder at a time), so
// a read-modify-write is enough; the write goes to a temp file and is renamed. read() THROWS when the file exists but
// can't be read or parsed: the caller must treat that as "can't tell".
function createWorkStore(file = WORK_FILE, fsx = fs) {
  const readAll = () => {
    try { return JSON.parse(fsx.readFileSync(file, 'utf8')); } catch (err) { if (err && err.code === 'ENOENT') return {}; throw err; }
  };
  const mine = (d, holder) => d && typeof d.owner === 'string' && String(holder).startsWith(d.owner);
  return {
    file,
    read(holder) { const d = readAll(); return mine(d, holder) && Array.isArray(d.work) ? d.work : []; },
    add(owner, pid, start) {
      let d; try { d = readAll(); } catch { d = {}; }
      if (!d || d.owner !== owner || !Array.isArray(d.work)) d = { owner, work: [] };
      // One entry per pid: a provisional record (start unknown) is replaced when the start time is read.
      d.work = d.work.filter(w => w.pid !== pid);
      d.work.push({ pid, start: typeof start === 'string' ? start : null });
      const tmp = `${file}.${process.pid}.tmp`;
      fsx.writeFileSync(tmp, JSON.stringify(d));
      fsx.renameSync(tmp, file);
    },
    clear(holder) { try { if (mine(readAll(), holder)) fsx.unlinkSync(file); } catch { /* nothing to clear, or not ours to read */ } },
  };
}

// A pid is gone when it isn't listed, or is listed with another start time (a reused pid). An unreadable start is alive.
const isGone = (starts, pid, start) => {
  if (!starts.has(pid)) return true;
  const now = starts.get(pid);
  return typeof now === 'string' && typeof start === 'string' && now !== start;
};

// If the slot's holder wears the "(pid N start T)" shape and that process AND everything it recorded are gone, release it
// by its exact owner string.
function reclaimDead({ run, startsOf, log, work }) {
  let st;
  try { st = run([], { timeoutMs: STATUS_TIMEOUT_MS }); } catch { return false; }
  const m = /^held: (.*)$/m.exec((st && st.stdout) || '');
  if (!m) return false;
  const holder = m[1].trim();
  const p = parseOwner(holder);
  if (!p) return false;                                   // a manual holder, or one with no proof: never touched
  let children;
  try { children = work.read(holder); } catch { return false; }   // can't read what it started: not "dead"
  let starts = null;
  try { starts = startsOf([p.pid, ...children.map(c => c.pid)]); } catch { /* could not ask */ }
  if (!starts) return false;                              // could not ask: not "dead"
  if (!isGone(starts, p.pid, p.start)) return false;
  const orphan = children.find(c => !isGone(starts, c.pid, c.start));
  if (orphan) {
    log(`[heavy-lock] ${holder} is gone but its work (pid ${orphan.pid}) is still running; the slot stays held`);
    return false;
  }
  let r;
  try { r = run(['-Release', '-Owner', holder], { timeoutMs: STATUS_TIMEOUT_MS }); } catch { return false; }
  if (!r || r.status !== 0) return false;
  try { work.clear(holder); } catch { /* the next holder overwrites it */ }
  log(`[heavy-lock] freed the slot of a dead holder: ${holder}`);
  return true;
}

/**
 * The side process that speaks for a waiting acquire (see WHILE IT WAITS). Returns { stop() }; a watcher that can't start
 * is no watcher (the wait itself goes on, silent as before). Its lines go to this process's stderr.
 */
function startWatcher({ scriptPath, workFile, parentPid, parentStart, startedAt, waitMinutes, everyMs = WATCH_EVERY_MS, spawnFn = spawn, execPath = process.execPath, env = process.env } = {}) {
  const cfg = { scriptPath, workFile, parentPid, parentStart, startedAt, everyMs, maxMs: (waitMinutes + 2) * 60000 };
  const childEnv = { ...env };
  delete childEnv[ENV_VAR];
  if (process.versions && process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';   // a plain node, even from an Electron main
  let c = null;
  try { c = spawnFn(execPath, [WATCH_SCRIPT, JSON.stringify(cfg)], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, env: childEnv }); } catch { return { stop() {} }; }
  if (c && typeof c.on === 'function') c.on('error', () => { /* no watcher: the wait goes on */ });
  if (c && typeof c.unref === 'function') c.unref();
  return {
    // Its own handle, held since the spawn: stopped only while it hasn't exited.
    stop() { try { if (c && c.exitCode === null && c.signalCode === null) c.kill(); } catch { /* gone */ } },
  };
}

/** Blocks (a synchronous script call) until the lock is held. Returns { state, release() }; throws HeavyLockError. */
function acquire({
  label = 'claude-custom', pid = process.pid, env = process.env, waitMinutes = waitFromEnv(env),
  scriptPath = DEFAULT_SCRIPT, spawnFn,
  run,
  exists = fs.existsSync, log = console.log, startsOf,
  work = createWorkStore(), now = Date.now,
  // The side process that prints the wait and frees a holder that dies during it. Started only on the real machine path
  // (no injected run or spawn), so a test never starts one unless it hands one in.
  watch,
} = {}) {
  const injected = run !== undefined || spawnFn !== undefined;
  if (watch === undefined) watch = injected ? null : startWatcher;
  if (spawnFn === undefined) spawnFn = spawnSync;
  if (run === undefined) run = defaultRun(scriptPath, { spawnFn, timeoutMs: (waitMinutes + 1) * 60000 });
  if (startsOf === undefined) startsOf = (pids) => queryStarts(pids, spawnFn);
  if (isHeld(env)) {
    log(`[heavy-lock] ${ENV_VAR}=1 is set: not taking the lock (an outer holder, or a hand-taken lock you must unset after)`);
    return { state: 'reentrant', release: () => false, addWork: () => false };
  }
  if (!exists(scriptPath)) {
    log(`[heavy-lock] ${scriptPath} not found; running without the heavy-work lock`);
    return { state: 'missing', release: () => false, addWork: () => false };
  }
  let ownStart = null;
  try { const m = startsOf([pid]); const v = m && m.get(pid); ownStart = typeof v === 'string' ? v : null; } catch { /* owner without a start */ }
  const owner = ownerFor(label, pid, ownStart);
  reclaimDead({ run, startsOf, log, work });
  const startedAt = now();
  let watcher = null;
  if (typeof watch === 'function') {
    try { watcher = watch({ scriptPath, workFile: work.file || WORK_FILE, parentPid: pid, parentStart: ownStart, startedAt, waitMinutes }); } catch { watcher = null; }
  }
  let r;
  try {
    let wait = waitMinutes;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { r = run(['-Acquire', '-Owner', owner, '-WaitMinutes', String(wait)], { timeoutMs: (wait + 1) * 60000 }); } catch (err) { r = { status: null, stdout: err && err.message }; }
      // Busy because of a holder (not "n ahead in the queue"): a dead one is freed and the acquire tried once more, with
      // only what is left of the wait budget (at least 1 minute), so the whole acquire stays bounded.
      if (r && r.status === 2 && /^busy: (?!\d+ ahead)/.test(r.stdout || '') && reclaimDead({ run, startsOf, log, work })) {
        wait = Math.max(1, Math.min(waitMinutes, Math.floor((waitMinutes * 60000 - (now() - startedAt)) / 60000)));
        continue;
      }
      break;
    }
  } finally {
    if (watcher && typeof watcher.stop === 'function') { try { watcher.stop(); } catch { /* gone */ } }
  }
  const said = (r && r.stdout) || '';
  if (!r || r.status !== 0) {
    const waitedMs = now() - startedAt;
    if (r && r.status === 2) {
      const m = /^busy: (.*)$/m.exec(said);
      const what = m ? m[1].trim() : '';
      const queued = /^\d+ ahead in the queue$/.test(what);
      throw new HeavyLockError('busy', `${said || 'busy'}. ${HINT}`, { holder: what && !queued ? what : null, detail: queued ? what : null, waitedMs });
    }
    if (r && r.status === 3) {
      const m = /^machine too loaded: (.*)$/m.exec(said);
      throw new HeavyLockError('loaded', `${said || 'machine too loaded'}. ${HINT}`, { detail: m ? m[1].trim() : null, waitedMs });
    }
    throw new HeavyLockError('error', `heavy-lock.ps1 failed (exit ${r && r.status}): ${said}`, { waitedMs });
  }
  env[ENV_VAR] = '1';
  let done = false;
  return {
    state: 'held', owner,
    // Record a heavy child (the suite's node, a probe's Electron root) so a dead asker with a live child isn't "dead".
    addWork(childPid, childStart) {
      if (done || !Number.isInteger(childPid) || childPid <= 0) return false;
      let start = childStart;
      if (start === undefined) { try { const v = (startsOf([childPid]) || new Map()).get(childPid); start = typeof v === 'string' ? v : null; } catch { start = null; } }
      try { work.add(owner, childPid, start); return true; } catch (err) { log(`[heavy-lock] could not record pid ${childPid} as work: ${err && err.message}`); return false; }
    },
    release() {
      if (done) return false;
      done = true;
      delete env[ENV_VAR];
      const ok = release({ owner, scriptPath, run, log });
      if (ok) { try { work.clear(owner); } catch { /* the next holder overwrites it */ } }
      return ok;
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
      // Release must be the LAST 'exit' listener: a probe registers its own cleanup (it kills its host) after requiring the
      // launcher, so whenever someone adds an 'exit' listener ours moves behind it (Dexter r2 #4).
      proc.on('exit', letGo);
      let moving = false;
      proc.on('newListener', (ev) => {
        if (ev !== 'exit' || moving) return;
        process.nextTick(() => {
          moving = true;
          try { proc.removeListener('exit', letGo); proc.on('exit', letGo); } finally { moving = false; }
        });
      });
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        proc.once(sig, () => {
          if (proc.listenerCount(sig) === 0) { letGo(); proc.exit(sig === 'SIGINT' ? 130 : 143); }
        });
      }
      return l;
    },
    // Record a heavy child of this process (a probe's Electron root); nothing if the lock isn't held.
    addWork(pid, start) { return !!(lock && lock.addWork && lock.addWork(pid, start)); },
  };
}

module.exports = {
  ENV_VAR, WAIT_VAR, DEFAULT_SCRIPT, DEFAULT_WAIT_MINUTES, STATUS_TIMEOUT_MS, WATCH_EVERY_MS, NOT_RUN_EXIT, WATCH_SCRIPT,
  HeavyLockError, notRunLine, ownerFor, parseOwner, queryStarts, defaultRun, createWorkStore, WORK_FILE, isGone, reclaimDead,
  startWatcher, acquire, release, createProcessLock,
};
