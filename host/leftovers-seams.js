'use strict';
/**
 * The OS side of the Leftovers stop (BACKLOG #74 item 6), kept apart from host/leftovers.js so that file stays pure.
 * Both questions are asked of Get-Process (host/proc-start.js startTimes), the source the ledger's own start times came
 * from, so the comparison is exact (PR #132 Dexter F1: never CIM against Get-Process).
 *
 *   launcherGone(entry)   true ONLY when the launcher's pid is not running at all. Anything else keeps the row: a pid that is
 *                         listed (even with another start: it may be a reused pid, or a start read through another path), a
 *                         start that could not be read, no launcher recorded, a query that failed.
 *   isRunning(pid, start) true when that pid still has that exact start; false when the pid is absent or now has another start
 *                         (the process is gone); null when it cannot be told (a failed query, an unreadable start).
 *
 * startTimes(pids) -> Promise<Map<pid, FILETIME | null> | null> (null: the query failed).
 */

function createSeams({ startTimes, kill, removeEntries }) {
  return {
    kill,
    removeEntries,
    async launcherGone(entry) {
      const l = entry && entry.launcher;
      if (!l || !Number.isInteger(l.pid) || l.pid <= 0) return false;
      const starts = await startTimes([l.pid]);
      if (!starts || typeof starts.has !== 'function') return false;
      return starts.has(l.pid) === false;
    },
    async isRunning(pid, start) {
      const starts = await startTimes([pid]);
      if (!starts || typeof starts.has !== 'function') return null;
      if (!starts.has(pid)) return false;
      const s = starts.get(pid);
      if (typeof s !== 'string') return null;
      return s === start;
    },
  };
}

module.exports = { createSeams };
