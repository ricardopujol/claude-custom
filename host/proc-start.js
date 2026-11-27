'use strict';
/**
 * "Is pid P still the process that started at T?" -- the question both the
 * session lock (host/session-lock.js) and the terminal-session warning ask.
 * Extension X1, documentation/PLAN_WORKTREE_TABS.md.
 *
 * A pid alone can't answer it: Windows reuses pids, so a dead host's lock can
 * name a pid that some unrelated process now owns. The start time can.
 * verify/probe-session-registry.js measured that
 * `(Get-Process -Id P).StartTime.ToFileTimeUtc()` returns exactly the FILETIME
 * the CLI writes as `procStart`, for one powershell.exe call however many pids
 * it covers (~250 ms then; 1.3-1.7 s on Raider on 2026-11-27, more under load:
 * see RETRY_QUERY_TIMEOUT_MS). `Date.now() - process.uptime()` was 12 ms off, so this
 * process's own start time comes from the same query, never from a clock.
 *
 * THREE ANSWERS THAT MUST STAY APART:
 *   absent from the map   the pid is not running
 *   null in the map       it is running, and its start time couldn't be read
 *                         (a process of another user or an elevated one)
 *   null for the result   the query itself failed -- nothing is known
 * Collapsing "couldn't ask" into "not running" would let a lock be broken
 * because powershell.exe was slow, which is the lost-lock failure this exists
 * to prevent.
 *
 * MEASURED "null in the map" (Dexter, PR #71 F4, doubted it could fire):
 * `startTimes([4])` -- System, whose StartTime getter throws access denied --
 * returns Map{4 => null} on this machine: under SilentlyContinue the throwing
 * getter reads as $null and the `?` branch runs. verify/probe-session-
 * registry.js asserts it on every run.
 *
 * OFF WINDOWS (Miguel G2) there is no query: every start time is null, so the
 * session lock judges a holder on its pid alone. A dead holder is still taken
 * over; a holder whose pid was REUSED reads as live, and the person gets the
 * blocked view with *Open anyway* rather than a silent second session.
 */

const path = require('path');
const { execFile } = require('child_process');

const QUERY_TIMEOUT_MS = 5000;
// fix/owner-proof: the budget of the ONE retry a caller may ask for (`retryExec`). MEASURED 2026-11-27 (Raider, scratch measure): one query
// takes 1.3-1.7 s on a calm machine (not the ~250 ms of 2026), 2.3-4.5 s at an Electron start under CPU load, and on a busy machine it
// passed 5 s: a launch then could not prove the running Jiandu, nor learn its own start. 5 + 15 s stays far below a launch's ~190 s wait.
const RETRY_QUERY_TIMEOUT_MS = 15_000;
// By absolute path (Miguel, PR #71 G1): a bare `powershell.exe` is looked up
// in the parent's cwd first, and this host's cwd is a project folder.
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Built, not typed: a literal U+FEFF in source is invisible (and
// test/renderer-scope.test.js rejects it).
const BOM_AT_START = new RegExp('^' + String.fromCharCode(0xfeff));

// Only positive integers are ever put anywhere near an OS call. The pid comes
// from a file on disk, and `kill(0, 0)` addresses the caller's process group
// while `kill(-1, 0)` addresses every process the user can signal (the same
// input class host/file-lock.js's isStale refuses).
const validPid = pid => Number.isInteger(pid) && pid > 0;

/**
 * true (running), false (not running), or null (can't tell -- never "dead").
 */
function isAlive(pid, kill = process.kill) {
  if (!validPid(pid)) return null;
  try {
    kill(pid, 0);                        // signal 0 tests existence only
    return true;
  } catch (err) {
    // EPERM: it exists and belongs to someone else, so it is very much alive.
    if (err && err.code === 'EPERM') return true;
    if (err && err.code === 'ESRCH') return false;
    return null;
  }
}

// An exec with its own timeout. The default is the product's budget for a query
// it must never wait long on; a caller measuring the REAL powershell.exe (a
// test under full-suite load) passes a budget of its own instead.
function createExec(timeoutMs = QUERY_TIMEOUT_MS) {
  return function exec(file, args) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
        (err, stdout) => {
          // A non-zero exit with output still carries the answer; the END
          // sentinel, not the exit code, says whether the query ran to the end.
          if (err && !stdout) reject(err);
          else resolve(String(stdout || ''));
        });
    });
  };
}
const defaultExec = createExec();
const retryExecDefault = createExec(RETRY_QUERY_TIMEOUT_MS);

/**
 * Start times as FILETIME strings (100 ns ticks since 1601, UTC), keyed by pid.
 * Resolves to a Map, or null when the query could not be run.
 * `retryExec` (fix/owner-proof): a query that could not be run (timed out, failed, no END) is asked ONCE more with it. An answer -- a
 * listed pid, an absent one -- is never asked again; two failures are still null ("could not ask", never "not running").
 */
async function startTimes(pids, { exec = defaultExec, retryExec = null, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const wanted = [...new Set((Array.isArray(pids) ? pids : []).filter(validPid))];
  if (wanted.length === 0) return new Map();
  const first = await queryOnce(wanted, exec);
  if (first !== null || typeof retryExec !== 'function') return first;
  return queryOnce(wanted, retryExec);
}

// The options patientStartTimes runs with: the default retry unless a retry exec is GIVEN (an explicit undefined keeps the default:
// PR #261 Miguel S2).
function patientOptions(opts = {}) {
  return { ...opts, retryExec: typeof opts.retryExec === 'function' ? opts.retryExec : retryExecDefault };
}

/** startTimes with the one retry on the longer budget: for a decision a launch must not get wrong because powershell.exe was slow. */
function patientStartTimes(pids, opts = {}) {
  return startTimes(pids, patientOptions(opts));
}

// One powershell.exe run for the (already validated) pids: a Map, or null when it did not run to the END sentinel.
async function queryOnce(wanted, exec) {
  const script = "$ErrorActionPreference='SilentlyContinue'; " +
    // `Where-Object { -not $_.HasExited }`: Windows keeps an EXITED process in the table while anyone holds a
    // handle to it, and Get-Process still returns it with its StartTime. MEASURED (verify/probe-worktree-
    // occupancy.js): a killed host was listed, start time and all, 45 s later -- a dead host read as alive.
    // An exited process is simply not running. A getter that throws (access denied: pid 4) reads as $null,
    // which `-not` keeps, so "running, start unreadable" (`?`) stays its own answer.
    `Get-Process -Id ${wanted.join(',')} | Where-Object { -not $_.HasExited } | ForEach-Object { ` +
    'if ($_.StartTime) { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } else { "$($_.Id) ?" } }; ' +
    "'END'";

  let out;
  try {
    out = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script]);
  } catch {
    return null;
  }

  const lines = String(out).replace(BOM_AT_START, '').split(/\r?\n/).map(l => l.trim());
  if (!lines.includes('END')) return null;

  const result = new Map();
  for (const line of lines) {
    const m = /^(\d+) (\d+|\?)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!wanted.includes(pid)) continue;
    result.set(pid, m[2] === '?' ? null : m[2]);
  }
  return result;
}

/**
 * This process's own start time, asked once and cached. `opts.retryExec`
 * (fix/owner-proof) gives an ask its one retry on a longer budget (app/main.js
 * passes it).
 *
 * SINGLE-FLIGHT, AND A FAILURE IS HELD (PR #261 Dexter 1 / Miguel I1): with the
 * retry one failed ask costs up to 20 s, and a launch's callers (the app claim,
 * the shared poller, the Resources service, the restore decision, each window
 * claim) ask within seconds of each other. Concurrent callers share the ONE
 * query in flight; a failure is the answer (null) for `failHoldMs`, then the
 * next caller asks again. So a launch pays the own-start budget once.
 */
const FAILED_START_HOLD_MS = 60_000;
function createSelfStartTime(opts = {}) {
  const { now = Date.now, failHoldMs = FAILED_START_HOLD_MS, ...query } = opts;
  let cached = null;
  let inflight = null;
  let failedAt = null;
  return function selfStartTime() {
    if (cached !== null) return Promise.resolve(cached);
    if (inflight) return inflight;
    if (failedAt !== null && now() - failedAt < failHoldMs) return Promise.resolve(null);
    inflight = (async () => {
      try {
        const m = await startTimes([process.pid], query);
        const own = m ? m.get(process.pid) : null;
        if (typeof own === 'string') { cached = own; failedAt = null; return own; }
        failedAt = now();
        return null;
      } catch {
        failedAt = now();
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

module.exports = { isAlive, startTimes, patientStartTimes, patientOptions, createSelfStartTime, QUERY_TIMEOUT_MS, RETRY_QUERY_TIMEOUT_MS,
  FAILED_START_HOLD_MS, defaultExec,
  retryExec: retryExecDefault, createExec, POWERSHELL, BOM_AT_START };
