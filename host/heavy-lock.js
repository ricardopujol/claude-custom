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
 * RE-ENTRANCY. Whoever holds the lock sets the environment variable HEAVY_LOCK_HELD to ITS OWN IDENTITY (the owner string
 * it holds the slot with, "<label> (pid N start T)") for everything it starts, and anything that finds the flag under that
 * same live holder does not try to take the lock again (the second asker would wait on its own parent). A variable can
 * outlive its holder (a shell that exported it and forgot, a background shell that inherited it), so the flag alone is
 * never trusted (2026-11-05; #237 Dexter 2): the slot's holder is read from the script's status first.
 *   - the live holder is the one the flag names: the lock is not taken, and the line NAMES that holder;
 *   - a live holder the flag does NOT name (another lane's wrapper or probe): a STRANGER'S variable. A warning, and the
 *     lock is waited for the normal way, so a leftover flag never runs a second suite beside another lane's;
 *   - nobody holds it, or the holder is provably dead: a STALE variable. A warning, and the lock is taken for real
 *     (a dead holder is freed first by the usual rules). On release the flag goes, like any flag this module sets;
 *   - the status can't be read: can't tell, so the flag is trusted, and the line says so.
 * "Live" is the dead-holder rule below: a "(pid N start T)" owner whose asker or recorded work still runs, or a by-hand
 * owner, which can't be proven dead. THE BARE "1" is the by-hand form: it names a by-hand holder only, never a holder in the
 * wrapper form "(pid N ...)" (that is some lane's own run). Any other value ("0", "true", "") is no flag at all. A person
 * who took the lock by hand sets the bare flag, and unsets it after:
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
 * THE LOAD GATE EATS INTO THE SAME 20. heavy-lock.ps1 has one deadline for the whole -Acquire: the time spent behind the
 * holders AND the time this ticket, first in line with the slot free, waits for the machine to drop under the gate are
 * both counted against it (each 20 s poll checks the gate only then). So the gate's minute between holders comes out of
 * the margin, twice with two suites ahead; and a machine kept loaded by something outside the lock (Ricardo's REAPER, a
 * build) spends the rest of the budget at the head of the queue. Ran out there, the script exits 3 and the last line
 * starts "machine busy" (notRunLine), not "lock busy": the slot was free, the machine wasn't. The gate is deliberate:
 * never worked around from here, and a longer wait would only make a loaded machine cost a longer wait.
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
 * turns it into the last line a caller prints, `[heavy-lock] lock busy for <n> min, held by <owner>: NOT RUN` (or, when the
 * slot was free but the load gate held it, `[heavy-lock] machine busy after a <n> min wait: ...: NOT RUN`), and the
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
 * the asker AND every recorded child are gone. A side file that can't be read is "can't tell", never "dead": the slot then
 * stays held until the script's 60-minute takeover, and a line says why (#112 M2).
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
 *   - 'reentrant': the flag was set and the slot has a live holder (or who holds it can't be read). Nothing is acquired,
 *     and release() does nothing (never clears a flag it didn't set, never releases a lock it didn't take).
 *   - 'missing': the script isn't on this machine. One warning line, and the work runs without the lock.
 *     HEAVY_LOCK_SCRIPT=<absolute path> points this module at another script (a test's fake, or a path that doesn't
 *     exist, which is how a test child runs a probe's code with no lock at all); a relative path is ignored.
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
// Retry later is the only next step (#237 Miguel M5): no variable is a way past a NOT RUN, so none is named here. The by-hand
// form lives in the header (RE-ENTRANCY), for someone who really took the lock by hand.
const HINT = 'Retry later: the lock is deliberate, and neither HEAVY_LOCK_HELD nor HEAVY_LOCK_SCRIPT is a way past it.';

const SCRIPT_VAR = 'HEAVY_LOCK_SCRIPT';
const scriptFromEnv = (env) => { const p = env && env[SCRIPT_VAR]; return typeof p === 'string' && path.isAbsolute(p) ? p : DEFAULT_SCRIPT; };
const waitFromEnv = (env) => { const n = Number(env && env[WAIT_VAR]); return Number.isInteger(n) && n > 0 ? n : DEFAULT_WAIT_MINUTES; };
// The flag's two forms (RE-ENTRANCY): a holder's identity (the owner string this module wrote, "<label> (pid N start T)" or
// "<label> (pid N)"), or a bare "1" (the by-hand way). Anything else ("0", "true", "") is no flag.
const WRAPPER_OWNER = /\(pid \d+(?: start \d+)?\)/;
const isHeld = (env) => !!env && typeof env[ENV_VAR] === 'string' && (env[ENV_VAR] === '1' || WRAPPER_OWNER.test(env[ENV_VAR]));
// Is the live holder the one this flag names? An identity names exactly the holder that wrote it (the script's own
// StartsWith match, so "(pid 1 ...)" never names "(pid 12 ...)"). A bare "1" names a by-hand holder only: never a holder in
// the wrapper form, which is some lane's wrapper or probe and set its own identity for its own children.
const flagNames = (flag, holder) => (flag === '1' ? !WRAPPER_OWNER.test(holder) : String(holder).startsWith(flag));

// `holder`: who held the slot when the wait ended (null: nobody, or unknown); `waitedMs`: how long this asker waited.
class HeavyLockError extends Error {
  constructor(code, message, { holder = null, waitedMs = null, detail = null, timedOut = false } = {}) {
    super(message); this.name = 'HeavyLockError'; this.code = code; this.holder = holder; this.waitedMs = waitedMs; this.detail = detail;
    this.timedOut = timedOut;
  }
}

// The one last line a caller prints when its work did not run, so it can't be misread as a failing run. Any error works:
// a HeavyLockError says why in its own words, anything else is "the lock failed". Two give-ups read apart from the first word:
//   - "lock busy": another holder had the slot when the wait ran out (or tickets ahead of this one still waited for it);
//   - "machine busy": the slot was FREE and this ticket was first, but the script's load gate (LOAD_GATE) held it back.
const LOAD_GATE = '8 GB free RAM and under 70% CPU';
// One physical line, whatever the script printed (#237 Miguel S1): a PowerShell exception is several lines, and the last
// line of the output must still start with "[heavy-lock]".
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// `timedOut`: the -Acquire call ran past its wait and was stopped by its own wait + 1 timer (#237 Dexter 6).
const TIMED_OUT = ' (heavy-lock.ps1 ran past its wait and was stopped)';
function notRunLine(err) {
  const known = err && typeof err.waitedMs === 'number';
  const n = known ? `${Math.round(err.waitedMs / 60000)} min` : null;
  const timed = err && err.timedOut ? TIMED_OUT : '';
  const holder = err && err.holder ? oneLine(err.holder) : null;
  const detail = err && err.detail ? oneLine(err.detail) : null;
  if (err && err.code === 'busy') {
    const span = n ? `lock busy for ${n}` : 'lock busy for the whole wait';
    // Tickets ahead and nobody holding: the first in line is between two polls, or held back by the load gate itself.
    if (!holder && detail) return `[heavy-lock] ${span}${timed}, held by nobody now but ${detail} (the first may be held back by the load gate: ${LOAD_GATE}): NOT RUN`;
    if (!holder && timed) return `[heavy-lock] ${span}${timed}, held by a holder its status could not name: NOT RUN`;
    return `[heavy-lock] ${span}${timed}, held by ${holder || 'nobody now'}: NOT RUN`;
  }
  if (err && err.code === 'loaded') {
    const span = n ? `machine busy after a ${n} wait` : 'machine busy after the whole wait';
    return `[heavy-lock] ${span}${timed}: the lock is free, but its load gate needs ${LOAD_GATE}${detail ? ` (now ${detail})` : ''}: NOT RUN`;
  }
  return `[heavy-lock] the lock could not be taken (${oneLine((err && err.message) || 'unknown error')}): NOT RUN`;
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
    // Drop one child of this owner's record (#113 Dexter 1: a child that has exited must not keep a reused pid in the slot).
    remove(owner, pid) {
      const d = readAll();
      if (!d || d.owner !== owner || !Array.isArray(d.work) || !d.work.some(w => w.pid === pid)) return;
      d.work = d.work.filter(w => w.pid !== pid);
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

// Is this holder provably dead? true only when it wears the "(pid N start T)" shape and that process AND everything it
// recorded are gone. false for a live one, a manual one, and every "can't tell". `log` hears why a dead asker still holds.
function holderIsDead(holder, { startsOf, work, log = () => {} }) {
  const p = parseOwner(holder);
  if (!p) return false;                                   // a manual holder, or one with no proof: never dead
  let children;
  // Can't read what it started: not "dead" (#112 M2, decided 2026-11-05: kept on the safe side, now said). Only this module
  // writes the record, by temp file and rename, so an unreadable one is damage, not a half-write, and it may list a suite
  // that still runs. The slot then stays until the script's 60-minute takeover, and that next holder's first write heals it.
  try {
    children = work.read(holder);
    // A malformed entry (`work: [null]`, a pid that isn't a number) is damage too: "can't tell", never a throw (#237 Miguel S4).
    if (!Array.isArray(children) || children.some(c => !c || typeof c !== 'object' || !Number.isInteger(c.pid) || c.pid <= 0)) {
      const e = new Error('malformed entry'); e.code = 'EMALFORMED'; throw e;
    }
  } catch (err) {
    log(`[heavy-lock] the work record of ${holder} can't be read (${(err && (err.code || err.message)) || 'unreadable'}): `
      + 'whether its work still runs can\'t be told, so the slot stays held (heavy-lock.ps1 frees a hold after 60 minutes)');
    return false;
  }
  let starts = null;
  try { starts = startsOf([p.pid, ...children.map(c => c.pid)]); } catch { /* could not ask */ }
  if (!starts) return false;                              // could not ask: not "dead"
  if (!isGone(starts, p.pid, p.start)) return false;
  const orphan = children.find(c => !isGone(starts, c.pid, c.start));
  if (orphan) {
    log(`[heavy-lock] ${holder} is gone but its work (pid ${orphan.pid}) is still running; the slot stays held`);
    return false;
  }
  return true;
}

// The slot's holder from the script's status: { holder, live } where live is true (someone holds it and isn't provably
// dead), false (free, or the holder is provably dead), or null (the status could not be read).
// `log` hears why a dead-looking holder still counts as live (#237 Dexter 5: the #112 "can't be read" line).
function readHolder({ run, startsOf, work, log = () => {} }) {
  let st = null;
  try { st = run([], { timeoutMs: STATUS_TIMEOUT_MS }); } catch { st = null; }
  const text = (st && st.stdout) || '';
  const m = /^held: (.*)$/m.exec(text);
  if (!m) return /^free$/m.test(text) ? { holder: null, live: false } : { holder: null, live: null };
  const holder = m[1].trim();
  return { holder: holder || null, live: !holderIsDead(holder, { startsOf, work, log }) };
}

// If the slot's holder is provably dead (holderIsDead), release it by its exact owner string. `status`: the script's status
// text when the caller has just read it (saves a second powershell); otherwise it's read here.
function reclaimDead({ run, startsOf, log, work, status }) {
  let text = status;
  if (typeof text !== 'string') {
    let st;
    try { st = run([], { timeoutMs: STATUS_TIMEOUT_MS }); } catch { return false; }
    text = (st && st.stdout) || '';
  }
  const m = /^held: (.*)$/m.exec(text);
  if (!m) return false;
  const holder = m[1].trim();
  if (!holderIsDead(holder, { startsOf, work, log })) return false;
  let r;
  try { r = run(['-Release', '-Owner', holder], { timeoutMs: STATUS_TIMEOUT_MS }); } catch { return false; }
  if (!r || r.status !== 0) return false;
  try { work.clear(holder); } catch { /* the next holder overwrites it */ }
  log(`[heavy-lock] freed the slot of a dead holder: ${holder}`);
  return true;
}

// After a busy give-up (#237 Dexter 1): is the slot open now? Free (whoever freed it), or held by a provably dead holder,
// which is then released here. A status that can't be read, a live holder, or a dead one that won't release: not open.
function slotOpenNow({ run, startsOf, log, work }) {
  let st;
  try { st = run([], { timeoutMs: STATUS_TIMEOUT_MS }); } catch { return false; }
  const text = (st && st.stdout) || '';
  if (/^free$/m.test(text)) { log('[heavy-lock] the slot came free just after the wait gave up: trying once more'); return true; }
  return reclaimDead({ run, startsOf, log, work, status: text });
}

/**
 * The side process that speaks for a waiting acquire (see WHILE IT WAITS). Returns { stop() }; a watcher that can't start
 * is no watcher (the wait itself goes on, silent as before). Its lines go to this process's stderr.
 */
// `waitMinutes` is the ONE -Acquire call this watcher speaks for (each attempt starts its own, #237 Dexter 1). That call is
// killed at its wait + 1 minute, so the watcher's own end at wait + 2 always outlasts it (#237 Miguel S9): it never goes
// quiet while its call still waits, and never outlives it by more than a minute and a tick.
const watcherMaxMs = (waitMinutes) => (waitMinutes + 2) * 60000;
function startWatcher({ scriptPath, workFile, parentPid, parentStart, startedAt, waitMinutes, everyMs = WATCH_EVERY_MS, spawnFn = spawn, execPath = process.execPath, env = process.env, versions = process.versions } = {}) {
  const cfg = { scriptPath, workFile, parentPid, parentStart, startedAt, everyMs, maxMs: watcherMaxMs(waitMinutes) };
  const childEnv = { ...env };
  delete childEnv[ENV_VAR];
  if (versions && versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';   // a plain node, even from an Electron main
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
  scriptPath = scriptFromEnv(env), spawnFn,
  run,
  exists = fs.existsSync, log = console.log, startsOf,
  work = createWorkStore(), now = Date.now,
  // The side process that prints the wait and frees a holder that dies during it: an explicit dependency (#237 Miguel M2).
  // `watch`: a function starts one, null starts none (every unit test passes null or a fake). Not given: the real one,
  // started through `spawnAsync` (child_process.spawn unless injected). One safety net stays: a caller that fakes the
  // script calls (`run` or `spawnFn`) but not `spawnAsync` gets NO default watcher, because a real one would read and
  // reclaim on the real lock that the fake was meant to keep the test away from.
  spawnAsync,
  watch,
} = {}) {
  if (watch === undefined) {
    const fakesTheScript = run !== undefined || spawnFn !== undefined;
    watch = (fakesTheScript && spawnAsync === undefined) ? null
      : (cfg) => startWatcher({ ...cfg, spawnFn: spawnAsync || spawn, env });
  }
  if (spawnFn === undefined) spawnFn = spawnSync;
  if (run === undefined) run = defaultRun(scriptPath, { spawnFn, timeoutMs: (waitMinutes + 1) * 60000 });
  if (startsOf === undefined) startsOf = (pids) => queryStarts(pids, spawnFn);
  if (isHeld(env)) {
    // The flag is trusted only while the holder it names really holds the slot (RE-ENTRANCY above): the skip names who.
    const flag = env[ENV_VAR];
    const scriptThere = exists(scriptPath);
    const outer = scriptThere ? readHolder({ run, startsOf, work, log }) : { holder: null, live: null };
    if (outer.live === null || (outer.live === true && flagNames(flag, outer.holder))) {
      // Flag set and no script: the reason is the missing script, not an unreadable status (#237 Miguel S3).
      log(outer.holder
        ? `[heavy-lock] ${ENV_VAR} is set and the slot is held by ${outer.holder}: not taking the lock (re-entrant, under that holder)`
        : !scriptThere
          ? `[heavy-lock] ${ENV_VAR} is set and the lock script ${scriptPath} is not on this machine: not taking the lock (re-entrant, no script to ask)`
          : `[heavy-lock] ${ENV_VAR} is set and who holds the slot could not be read: not taking the lock (re-entrant, can't tell)`);
      return { state: 'reentrant', holder: outer.holder, flag, release: () => false, addWork: () => false };
    }
    if (outer.live === true) {
      // A live holder the flag doesn't name: another lane's. Running beside it is exactly what the lock is for (#237 Dexter 2).
      log(`[heavy-lock] WARNING: ${ENV_VAR}=${flag} is set, but the slot is held by ${outer.holder}, which `
        + `${flag === '1' ? 'is another lane\'s wrapper or probe' : 'is not the holder that set it'}: a STRANGER'S variable in this shell. `
        + `Waiting for the lock the normal way; unset ${ENV_VAR} (see host/heavy-lock.js).`);
    } else {
      log(`[heavy-lock] WARNING: ${ENV_VAR} is set but ${outer.holder ? `the slot's holder is gone (${outer.holder})` : 'nobody holds the lock'}: `
        + `a STALE variable in this shell. Taking the lock for real; unset ${ENV_VAR} (see host/heavy-lock.js).`);
    }
  }
  if (!exists(scriptPath)) {
    log(`[heavy-lock] ${scriptPath} not found; running without the heavy-work lock`);
    return { state: 'missing', flag: isHeld(env) ? env[ENV_VAR] : undefined, release: () => false, addWork: () => false };
  }
  let ownStart = null;
  try { const m = startsOf([pid]); const v = m && m.get(pid); ownStart = typeof v === 'string' ? v : null; } catch { /* owner without a start */ }
  const owner = ownerFor(label, pid, ownStart);
  reclaimDead({ run, startsOf, log, work });
  const startedAt = now();
  let r;
  let wait = waitMinutes;
  for (let attempt = 0; attempt < 2; attempt++) {
    let watcher = null;
    if (typeof watch === 'function') {
      try { watcher = watch({ scriptPath, workFile: work.file || WORK_FILE, parentPid: pid, parentStart: ownStart, startedAt, waitMinutes: wait }); } catch { watcher = null; }
    }
    try {
      try { r = run(['-Acquire', '-Owner', owner, '-WaitMinutes', String(wait)], { timeoutMs: (wait + 1) * 60000 }); } catch (err) { r = { status: null, stdout: err && err.message }; }
    } finally {
      // Stopped BEFORE the slot is read again below, so its own reclaim can't race that read (#237 Dexter 1).
      if (watcher && typeof watcher.stop === 'function') { try { watcher.stop(); } catch { /* gone */ } }
    }
    // Busy because of a holder (not "n ahead in the queue"): the question is "is the slot still held?", not "did I free
    // it?" (#237 Dexter 1). The holder may have died and been freed by this call's own watcher, another lane's, or its own
    // release, between the script's give-up and now. A slot that's free now, or whose holder is provably dead (freed here),
    // gets the acquire once more, with only what is left of the wait budget (at least 1 minute): the whole stays bounded.
    if (attempt === 0 && r && r.status === 2 && /^busy: (?!\d+ ahead)/.test(r.stdout || '') && slotOpenNow({ run, startsOf, log, work })) {
      wait = Math.max(1, Math.min(waitMinutes, Math.floor((waitMinutes * 60000 - (now() - startedAt)) / 60000)));
      continue;
    }
    break;
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
    if (r && r.status === null && /ETIMEDOUT/.test(said)) {
      // Killed by its own wait + 1 timer (#237 Dexter 6): on a loaded machine the script's load check plus its 20 s sleep can
      // run past the deadline. The wait ran out all the same, so the slot is read again to say which give-up it was.
      let text = '';
      try { const st = run([], { timeoutMs: STATUS_TIMEOUT_MS }); text = (st && st.stdout) || ''; } catch { text = ''; }
      const held = /^held: (.*)$/m.exec(text);
      if (/^free$/m.test(text) && !held) {
        throw new HeavyLockError('loaded', `heavy-lock.ps1 ran past its wait and was stopped; the slot is free. ${HINT}`, { waitedMs, timedOut: true });
      }
      const holder = held ? held[1].trim() || null : null;
      throw new HeavyLockError('busy', `heavy-lock.ps1 ran past its wait and was stopped${holder ? `; held by ${holder}` : ''}. ${HINT}`, { holder, waitedMs, timedOut: true });
    }
    throw new HeavyLockError('error', `heavy-lock.ps1 failed (exit ${r && r.status}): ${said}`, { waitedMs });
  }
  env[ENV_VAR] = owner;   // its own identity, so only what it starts is re-entrant under it (#237 Dexter 2)
  let done = false;
  return {
    state: 'held', owner, flag: owner,
    // Record a heavy child (the suite's node, a probe's Electron root) so a dead asker with a live child isn't "dead".
    // No start given: it's read here, SYNCHRONOUSLY (one powershell query, 0.5-1.5 s). The caller still holds the child's
    // handle, so a query that answers without its pid means it HAS exited (Windows doesn't reuse a pid while a handle is
    // open): its entry is dropped, not kept with an unknown start, which a stranger reusing the pid later would keep alive
    // (#113 Dexter 1). A query that fails is "can't tell": the entry stays, start unknown.
    addWork(childPid, childStart) {
      if (done || !Number.isInteger(childPid) || childPid <= 0) return false;
      let start = childStart;
      if (start === undefined) {
        let starts = null;
        try { starts = startsOf([childPid]); } catch { starts = null; }
        if (starts instanceof Map && !starts.has(childPid)) {
          try { work.remove(owner, childPid); } catch (err) { log(`[heavy-lock] could not drop exited pid ${childPid} from the work record: ${err && err.message}`); }
          return false;
        }
        const v = starts instanceof Map ? starts.get(childPid) : null;
        start = typeof v === 'string' ? v : null;
      }
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
  ENV_VAR, WAIT_VAR, SCRIPT_VAR, HINT, DEFAULT_SCRIPT, DEFAULT_WAIT_MINUTES, STATUS_TIMEOUT_MS, WATCH_EVERY_MS, NOT_RUN_EXIT, WATCH_SCRIPT,
  HeavyLockError, notRunLine, ownerFor, parseOwner, queryStarts, defaultRun, createWorkStore, WORK_FILE, isGone, reclaimDead,
  startWatcher, acquire, release, createProcessLock,
};
