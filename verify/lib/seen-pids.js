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
 *                    probe's own earlier read. Strongest; preferred over a fresh read; several for one pid are all tried; never read fresh, so a start-less
 *                    identity entry is NOT killed on a read made at cleanup (that would prove only the suspect's own start).
 *   see(pid)         an early sighting (the app's state while the probe runs): the start is read now, so it is only as good
 *                    as that read, and only the FIRST sighting's read counts: a failed one is never refilled by a later read (the pid may be a
 *                    stranger's by then); only a recorded start can fill it.
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
  // pid -> { fresh: FILETIME | null (the FIRST sighting's read, made once), recorded: [FILETIME, ...] (every recorded start) }
  const seen = new Map();
  const candidates = (e) => (e.recorded.length ? e.recorded : (e.fresh === null ? [] : [e.fresh]));
  return {
    // A recorded start. Two different ones for one pid are both kept: a second host of this run may have reused the pid.
    add(pid, start) {
      if (!validPid(pid)) return;
      let e = seen.get(pid);
      if (!e) { e = { fresh: null, recorded: [] }; seen.set(pid, e); }
      if (validStart(start) && !e.recorded.includes(start)) e.recorded.push(start);
    },
    // A fresh read is trusted ONLY as the first sighting (PR #135 Dexter N2): if it failed it is never filled from a later
    // read, which could describe a stranger that took the freed pid. Only a recorded start can fill it.
    see(pid) {
      if (!validPid(pid) || seen.has(pid)) return;
      seen.set(pid, { fresh: startOf(pid), recorded: [] });
    },
    // One recorded pid. True when the entry is closed (killed, gone, or another process now).
    kill(pid) {
      const e = seen.get(pid);
      if (!e) return true;
      const starts = candidates(e);
      if (starts.length === 0) { log(`[seen-pids] pid ${pid} skipped: no proven start, so it is left running`); return false; }
      let mismatched = 0;
      for (const start of starts) {
        let r;
        try { r = prove(pid, start); } catch (err) { log(`[seen-pids] pid ${pid}: the proven kill threw (${err && err.message}); left running`); return false; }
        if (r === 'killed' || r === 'gone') { seen.delete(pid); return true; }
        if (r === 'mismatch') { mismatched++; continue; }
        log(`[seen-pids] pid ${pid}: the proven kill answered '${r}'; it may still be running`);
        return false;
      }
      log(`[seen-pids] pid ${pid} is another process now (start mismatch ${mismatched}x); nothing killed`);
      seen.delete(pid);
      return true;
    },
    endAll() {
      const left = [];
      for (const pid of [...seen.keys()]) if (!this.kill(pid)) left.push(pid);
      return { left };
    },
  };
}

module.exports = { createSeenPids };
