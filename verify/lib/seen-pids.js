'use strict';
/**
 * The pids a probe saw (host identity files, the app's state) and must end when it finishes (BACKLOG #74 H).
 *
 * A probe holds no handle on those: Windows reuses pids fast, and a bare `killPidTree(pid)` minutes later can end a
 * stranger and its whole tree. So each pid is recorded WITH its start time the first time it is seen (the identity
 * file's own `processStartedAt` when given, else a read right then), and ended only through host/kill-tree.js
 * killProven(pid, start), which proves the start again on a held handle in the same call as the kill. A pid whose
 * start could not be read is left alone: nothing proves it is ours.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { killProven } = require('../../host/kill-tree');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function readStart(pid) {
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    return /^\d+$/.test(out) ? out : null;
  } catch { return null; }
}

function createSeenPids({ startOf = readStart, prove = killProven } = {}) {
  const seen = new Map();   // pid -> start (FILETIME string) or null
  return {
    add(pid, start) {
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) return;
      seen.set(pid, typeof start === 'string' && /^\d+$/.test(start) ? start : startOf(pid));
    },
    // One recorded pid, once.
    kill(pid) {
      const start = seen.get(pid);
      if (typeof start !== 'string') return;
      seen.delete(pid);
      try { prove(pid, start); } catch { /* gone */ }
    },
    killAll() {
      for (const pid of [...seen.keys()]) this.kill(pid);
    },
  };
}

module.exports = { createSeenPids };
