'use strict';
/**
 * Stop the hosts a dead probe left behind, and nothing else (BACKLOG #169).
 *
 * WHAT IS PROVEN BEFORE A HOST IS STOPPED. All five, or it is left alone and the reason is said:
 *   1. MARKED. Its identity file (<dir>/hosts/<port>.json, host/host-identity.js) carries a well-formed probeMark (host/probe-mark.js).
 *      A host without one is a person's or an older build's, and is never considered, however dead its parent looks.
 *   2. THE HOST IS THE ONE THE FILE NAMES. The process table has the file's pid, started at the file's processStartedAt (within 2 ms:
 *      the table's creation time has microsecond precision). A reused pid is a different process.
 *   3. ITS PARENT IS DEAD. No process has its parent pid, or the one that does started AFTER the host did (a pid handed out again
 *      cannot be the host's parent).
 *   4. ITS LAUNCHER IS DEAD, the same way: the pid in the mark. A probe closes a window on purpose and expects its detached host to
 *      still be there when it reopens it (verify/probe-side-session.js), so a dead parent alone is not an orphan.
 *   5. THE KILL RE-PROVES THE START TIME on a held process handle, in the same step (host/kill-tree.js killProven), then ends the
 *      tree by pid. No process is ever named, and a start time that cannot be read means nothing is stopped.
 * A process table that cannot be read is "nothing is known", never "nothing is running": nothing is stopped.
 *
 * Only the identity files of ONE folder are read (the checkout's own .harness by default), so a sweep in one worktree never
 * touches another's hosts or a person's live window.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseMark } = require('../../host/probe-mark');
const { killProven: realKillProven } = require('../../host/kill-tree');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const START_TOLERANCE = 20000n;   // 2 ms in 100 ns ticks, as host/kill-tree.js's table-read proofs
const FILETIME = /^\d{1,19}$/;

/**
 * The identity files in <dir>/hosts. { marked: [entry], unmarked: n, unreadable: n }. An entry is
 * { file, port, pid, start, mark } with `start` the FILETIME string the host published (null when it never did).
 */
function readIdentities(dir) {
  const out = { marked: [], unmarked: 0, unreadable: 0 };
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'hosts')).filter(n => /^\d+\.json$/.test(n)); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, 'hosts', name);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out.unreadable++; continue; }
    if (!doc || typeof doc !== 'object') { out.unreadable++; continue; }
    const mark = parseMark(doc.probeMark);
    if (!mark) { out.unmarked++; continue; }
    out.marked.push({
      file, port: doc.port, pid: Number.isSafeInteger(doc.pid) && doc.pid > 0 ? doc.pid : null,
      start: typeof doc.processStartedAt === 'string' && FILETIME.test(doc.processStartedAt) ? doc.processStartedAt : null,
      mark: doc.probeMark, launcherPid: mark.pid,
    });
  }
  return out;
}

/**
 * The whole process table: Map<pid, { ppid, created: BigInt FILETIME }>, or null when it could not be read. One query, so
 * the judgements below are all about the same instant.
 */
function readProcessTable({ run = spawnSync, powershell = POWERSHELL } = {}) {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 20 | " +
    "ForEach-Object { if ($_.CreationDate) { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())\" } }; 'END'";
  let r;
  try { r = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch { return null; }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const lines = r.stdout.split(/\r?\n/).map(l => l.trim());
  if (!lines.includes('END')) return null;
  const table = new Map();
  for (const l of lines) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(l);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), created: BigInt(m[3]) });
  }
  // A table without a single row is a broken query, not an empty machine (this process is in it).
  return table.size > 0 ? table : null;
}

const abs = (a, b) => (a > b ? a - b : b - a);

/**
 * The verdict for one marked identity against one table. Pure. { action: 'stop' | 'leave', why }.
 * `self`: pids this sweep must never stop (itself and its parent).
 */
function judge(entry, table, { self = [] } = {}) {
  if (!entry.pid) return { action: 'leave', why: 'its identity file has no usable pid' };
  if (self.includes(entry.pid)) return { action: 'leave', why: 'this is the sweep\'s own process' };
  if (!entry.start) return { action: 'leave', why: 'the host never published its start time, so it cannot be proven' };
  const host = table.get(entry.pid);
  if (!host) return { action: 'leave', why: 'not running (a stale identity file)' };
  if (abs(host.created, BigInt(entry.start)) > START_TOLERANCE) return { action: 'leave', why: 'the pid belongs to another process now (its start time differs)' };
  const alive = (pid) => {
    const p = pid > 0 ? table.get(pid) : undefined;
    return !!p && p.created <= host.created;       // one that started later is a reused pid, not the original
  };
  if (alive(host.ppid)) return { action: 'leave', why: `its parent ${host.ppid} is still running` };
  if (alive(entry.launcherPid)) return { action: 'leave', why: `its probe ${entry.launcherPid} is still running` };
  return { action: 'stop', why: `marked ${entry.mark}; parent ${host.ppid} and probe ${entry.launcherPid} are gone` };
}

/**
 * Judge every marked identity in `dir`; stop the ones judged 'stop' unless `dryRun`.
 * Returns { read, stopped, wouldStop, left, failed, unknown, files } -- `unknown` true when nothing could be judged.
 */
function sweep({
  dir, dryRun = true, table, kill = realKillProven, self = [process.pid, process.ppid],
} = {}) {
  const ids = readIdentities(dir);
  const result = {
    files: ids.marked.length + ids.unmarked + ids.unreadable, marked: ids.marked.length, unmarked: ids.unmarked, unreadable: ids.unreadable,
    wouldStop: [], stopped: [], failed: [], left: [], unknown: false,
  };
  if (ids.marked.length === 0) return result;
  const procs = table === undefined ? readProcessTable() : table;   // read only when there is something to judge
  if (!procs) { result.unknown = true; return result; }
  for (const e of ids.marked) {
    const v = judge(e, procs, { self });
    if (v.action === 'leave') { result.left.push({ pid: e.pid, port: e.port, why: v.why }); continue; }
    result.wouldStop.push({ pid: e.pid, port: e.port, why: v.why });
    if (dryRun) continue;
    let outcome;
    try { outcome = kill(e.pid, e.start); } catch { outcome = 'failed'; }
    if (outcome === 'killed') result.stopped.push({ pid: e.pid, port: e.port });
    else if (outcome === 'gone' || outcome === 'mismatch') result.left.push({ pid: e.pid, port: e.port, why: `${outcome} at the moment of the kill, nothing stopped` });
    else result.failed.push({ pid: e.pid, port: e.port, outcome });
  }
  return result;
}

module.exports = { readIdentities, readProcessTable, judge, sweep, START_TOLERANCE };
