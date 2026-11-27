'use strict';
/**
 * Test hygiene for the shutdown watchdog (BACKLOG #228 step 4): every host/bounded-watchdog.js a test starts is ended by the test
 * file, and a watchdog that would have been left behind fails it.
 *
 * WHY: on 2026-11-23, 11 watchdog processes from the bounded-shutdown tests lived for over an hour. A watchdog is DETACHED and waits
 * for its host to die or its bound to run out, so one whose exit is broken (a mutant under Stryker, a hung proof, a host that never
 * dies) outlives the test run with nothing to end it, and keeps a CPU slice and a pid while the next run measures the machine.
 *
 * HOW IT PROVES A PROCESS IS OURS (never a kill by name, never a bare pid; PR #259 Miguel R1). A row of the process table is reaped
 * only when its command line names bounded-watchdog.js AND one of these holds at reap time:
 *   - `track(disarm)`: armWatchdog's handle names that pid AND `disarm.running()` is still true. The handle is the product's own
 *     proof (host/bounded-shutdown.js): once the watchdog has exited, its pid is free for Windows to hand to a stranger (another
 *     test's watchdog, or the real app's), so a dead handle never makes a candidate.
 *   - `trackParent(child)`: the row's parent pid is a process this file spawned, and the row was CREATED while that process was
 *     alive (between its spawn, less SPAWN_SLACK_MS, and its 'exit' event). Windows keeps a ParentProcessId after the parent exits,
 *     so a pid reused after the exit could otherwise pass; a process created while ours was alive can't have been parented by a
 *     stranger holding the same pid. Where the creation time is unknown (POSIX: a dead parent's children are re-parented there),
 *     only a parent still alive counts.
 * What is left: the few milliseconds between the list and the kill, and between a parent's real exit and its 'exit' event.
 *
 * A listing that fails (spawn error, timeout, a non-zero exit) THROWS: an empty answer from a broken listing must never read as
 * "no leak" (PR #259 Miguel Y1; the absence-reported-as-zero trap in CLAUDE.md).
 *
 * `reap({ graceMs })` first gives the tracked watchdogs `graceMs` to leave on their own (a healthy one leaves on its next 100 ms
 * tick once its host is gone), then kills each one still alive by its pid, tree included (it may be mid-way through a killProven
 * PowerShell), and returns the pids it had to kill. A non-empty answer is a leak; the caller asserts on it.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MARK = 'bounded-watchdog.js';
// How long before trackParent() was called the tracked child may have been created (spawn() returns after the process exists).
const SPAWN_SLACK_MS = 1000;

function createReaper({ list = listWatchdogs, kill = killTreeByPid, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const handles = [];
  const parents = [];
  const byHandle = (row) => handles.some((h) => h.pid === row.pid && h.running() === true);
  const byParent = (row) => parents.some((e) => {
    if (e.pid !== row.ppid) return false;
    if (!Number.isFinite(row.created)) return e.exitedAt === null;
    return row.created >= e.spawnedAt - SPAWN_SLACK_MS && (e.exitedAt === null || row.created <= e.exitedAt);
  });
  const ours = () => list().filter((row) => byHandle(row) || byParent(row));
  return {
    /** `disarm`: armWatchdog's handle ({ pid, running() }). */
    track(disarm) {
      if (disarm && Number.isInteger(disarm.pid) && disarm.pid > 0 && typeof disarm.running === 'function') handles.push(disarm);
    },
    /** `child`: a ChildProcess this file spawned, tracked right after spawn(). */
    trackParent(child) {
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || typeof child.once !== 'function') return;
      const exited = child.exitCode !== null || child.signalCode !== null;
      // Already gone: when it exited is unknown, so nothing is proven to be its child.
      const e = { pid: child.pid, spawnedAt: now(), exitedAt: exited ? -Infinity : null };
      if (!exited) child.once('exit', () => { e.exitedAt = now(); });
      parents.push(e);
    },
    async reap({ graceMs = 3000, stepMs = 100 } = {}) {
      if (handles.length === 0 && parents.length === 0) return [];
      try {
        const until = now() + graceMs;
        let left = ours();
        while (left.length > 0 && now() < until) { await sleep(stepMs); left = ours(); }
        for (const row of left) kill(row.pid);
        return left.map((row) => row.pid);
      } finally { handles.length = 0; parents.length = 0; }
    },
  };
}

function run(cmd, args, spawnSyncImpl) {
  const r = spawnSyncImpl(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error) throw new Error(`watchdog listing failed: ${r.error.code || r.error.message}`);
  if (r.status !== 0) throw new Error(`watchdog listing failed: ${cmd} exited ${r.status === null ? `on ${r.signal}` : r.status}: ${String(r.stderr || '').trim().slice(0, 300)}`);
  return String(r.stdout || '');
}

/** Every live process whose command line names bounded-watchdog.js: [{ pid, ppid, created }] (created: epoch ms, NaN if unknown). */
function listWatchdogs({ spawnSyncImpl = spawnSync } = {}) {
  if (process.platform === 'win32') {
    const exe = path.basename(process.execPath).replace(/'/g, "''");
    const ps = "$ErrorActionPreference = 'Stop'; " +
      `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -like '*${MARK}*' } | ` +
      'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';
    return parseRows(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], spawnSyncImpl));
  }
  return parseRows(run('ps', ['-eo', 'pid=,ppid=,args='], spawnSyncImpl).split('\n').filter((l) => l.includes(MARK)).map((l) => l.replace(/^(\s*\d+\s+\d+).*$/, '$1')).join('\n'));
}

function parseRows(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3] === undefined ? NaN : Number(m[3]) });
  }
  return out;
}

// Only a pid listWatchdogs just named as a live bounded-watchdog.js that this file proved it started (see the header).
function killTreeByPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30000 });   // kill-ok(table-row): a bounded-watchdog.js row read from the process table this reap, proven ours by a live handle or its creation inside our child's life
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }   // kill-ok(table-row): the same row, POSIX
}

module.exports = { createReaper, listWatchdogs, parseRows, MARK, SPAWN_SLACK_MS };
