'use strict';
/**
 * Test hygiene for the shutdown watchdog (BACKLOG #228 step 4): every host/bounded-watchdog.js a test starts is ended by the test
 * file, and a watchdog that would have been left behind fails it.
 *
 * WHY: on 2026-11-23, 11 watchdog processes from the bounded-shutdown tests lived for over an hour. A watchdog is DETACHED and waits
 * for its host to die or its bound to run out, so one whose exit is broken (a mutant under Stryker, a hung proof, a host that never
 * dies) outlives the test run with nothing to end it, and keeps a CPU slice and a pid while the next run measures the machine.
 *
 * HOW IT PROVES A PROCESS IS OURS (never a kill by name): a pid is reaped only when, at reap time, it is a live process whose
 * command line names bounded-watchdog.js AND it is either a watchdog pid this file was handed (`track(pid)`, from armWatchdog's
 * `disarm.pid`) or the child of a process this file spawned (`trackParent(pid)`, for a watchdog armed inside that child).
 *
 * `reap({ graceMs })` first gives the tracked watchdogs `graceMs` to leave on their own (a healthy one leaves on its next 100 ms
 * tick once its host is gone), then kills each one still alive by its pid, tree included (it may be mid-way through a killProven
 * PowerShell), and returns the pids it had to kill. A non-empty answer is a leak; the caller asserts on it.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MARK = 'bounded-watchdog.js';

function createReaper({ list = listWatchdogs, kill = killTreeByPid, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const pids = new Set();
  const parents = new Set();
  const ours = () => list().filter((p) => pids.has(p.pid) || parents.has(p.ppid));
  return {
    track(pid) { if (Number.isInteger(pid) && pid > 0) pids.add(pid); },
    trackParent(pid) { if (Number.isInteger(pid) && pid > 0) parents.add(pid); },
    async reap({ graceMs = 3000, stepMs = 100 } = {}) {
      if (pids.size === 0 && parents.size === 0) return [];
      const until = Date.now() + graceMs;
      let left = ours();
      while (left.length > 0 && Date.now() < until) { await sleep(stepMs); left = ours(); }
      for (const p of left) kill(p.pid);
      pids.clear(); parents.clear();
      return left.map((p) => p.pid);
    },
  };
}

/** Every live process whose command line names bounded-watchdog.js: [{ pid, ppid }]. */
function listWatchdogs() {
  if (process.platform === 'win32') {
    const exe = path.basename(process.execPath).replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -like '*${MARK}*' } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return parsePairs(r.stdout);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30000 });
  return parsePairs(String(r.stdout || '').split('\n').filter((l) => l.includes(MARK)).join('\n'));
}

function parsePairs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return out;
}

// Only a pid listWatchdogs just named as a live bounded-watchdog.js that this file started (see the header).
function killTreeByPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30000 });   // kill-ok(table-row): a bounded-watchdog.js row read from the process table this reap, tracked by this file
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }   // kill-ok(table-row): the same row, POSIX
}

module.exports = { createReaper, listWatchdogs, parsePairs, MARK };
