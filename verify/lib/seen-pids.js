'use strict';
/**
 * The pids a probe saw (host identity files, the app's state) and must end when it finishes (BACKLOG #74 H).
 *
 * A probe holds no handle on those: Windows reuses pids fast, and a bare `killPidTree(pid)` minutes later can end a
 * stranger and its whole tree. So each pid is recorded WITH a start time and ended only through host/kill-tree.js
 * killProven(pid, start), which proves the start again on a held handle in the same call as the kill.
 *
 * What the proof is worth depends on WHEN the start was recorded (PR #135 Dexter 2/3, Miguel 3):
 *   add(pid, start)  a start recorded while the pid was known to be ours -- an identity file's `processStartedAt`, the
 *                    probe's own earlier read. Strongest; replaces a fresh read; never read fresh, so a start-less
 *                    identity entry is NOT killed on a read made at cleanup (that would prove only the suspect's own start).
 *   see(pid)         an early sighting (the app's state while the probe runs): the start is read now, so it is only as good
 *                    as that read; a failed read is retried on the next sighting.
 * A pid with no proven start is never killed, and is LOGGED as skipped. killProven's answer is used: 'failed' and
 * 'unknown' keep the entry (a later endAll retries) and are logged; endAll returns { left } for what it did not end.
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

const validPid = (pid) => Number.isInteger(pid) && pid > 0;
const validStart = (s) => typeof s === 'string' && /^\d+$/.test(s);

function createSeenPids({ startOf = readStart, prove = killProven, log = (m) => console.log(m) } = {}) {
  const seen = new Map();   // pid -> { start: FILETIME string | null, recorded: boolean }
  return {
    add(pid, start) {
      if (!validPid(pid)) return;
      const cur = seen.get(pid);
      if (validStart(start)) {
        if (!cur || !cur.recorded) seen.set(pid, { start, recorded: true });
      } else if (!cur) seen.set(pid, { start: null, recorded: false });
    },
    see(pid) {
      if (!validPid(pid)) return;
      const cur = seen.get(pid);
      if (cur && cur.start !== null) return;
      seen.set(pid, { start: startOf(pid), recorded: false });
    },
    // One recorded pid. True when the entry is closed (killed, gone, or another process now).
    kill(pid) {
      const e = seen.get(pid);
      if (!e) return true;
      if (e.start === null) { log(`[seen-pids] pid ${pid} skipped: no proven start, so it is left running`); return false; }
      let r;
      try { r = prove(pid, e.start); } catch (err) { log(`[seen-pids] pid ${pid}: the proven kill threw (${err && err.message}); left running`); return false; }
      if (r === 'killed' || r === 'gone') { seen.delete(pid); return true; }
      if (r === 'mismatch') { log(`[seen-pids] pid ${pid} is another process now (start mismatch); nothing killed`); seen.delete(pid); return true; }
      log(`[seen-pids] pid ${pid}: the proven kill answered '${r}'; it may still be running`);
      return false;
    },
    endAll() {
      const left = [];
      for (const pid of [...seen.keys()]) if (!this.kill(pid)) left.push(pid);
      return { left };
    },
  };
}

module.exports = { createSeenPids };
