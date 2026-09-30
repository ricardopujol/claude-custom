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
 * the CLI writes as `procStart`, for one ~250 ms powershell.exe call however
 * many pids it covers. `Date.now() - process.uptime()` was 12 ms off, so this
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
 */

const { execFile } = require('child_process');

const QUERY_TIMEOUT_MS = 5000;

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

function defaultExec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS },
      (err, stdout) => {
        // A non-zero exit with output still carries the answer; the END
        // sentinel, not the exit code, says whether the query ran to the end.
        if (err && !stdout) reject(err);
        else resolve(String(stdout || ''));
      });
  });
}

/**
 * Start times as FILETIME strings (100 ns ticks since 1601, UTC), keyed by pid.
 * Resolves to a Map, or null when the query could not be run.
 */
async function startTimes(pids, { exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const wanted = [...new Set((Array.isArray(pids) ? pids : []).filter(validPid))];
  if (wanted.length === 0) return new Map();

  const script = "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-Process -Id ${wanted.join(',')} | ForEach-Object { ` +
    'if ($_.StartTime) { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } else { "$($_.Id) ?" } }; ' +
    "'END'";

  let out;
  try {
    out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  } catch {
    return null;
  }

  const lines = String(out).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim());
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
 * This process's own start time, asked once and cached. A failed query is not
 * cached, so the next caller asks again.
 */
function createSelfStartTime(opts = {}) {
  let cached = null;
  return async function selfStartTime() {
    if (cached !== null) return cached;
    const m = await startTimes([process.pid], opts);
    const own = m ? m.get(process.pid) : null;
    if (typeof own === 'string') cached = own;
    return own === undefined ? null : own;
  };
}

module.exports = { isAlive, startTimes, createSelfStartTime, QUERY_TIMEOUT_MS };
