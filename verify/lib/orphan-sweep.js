'use strict';
/**
 * Stop the hosts a dead probe left behind, and nothing else (BACKLOG #169).
 *
 * WHAT IS PROVEN BEFORE A HOST IS STOPPED. All six, or it is left alone and the reason is said:
 *   1. MARKED. Its identity file (<dir>/hosts/<port>.json, host/host-identity.js) carries a well-formed probeMark (host/probe-mark.js).
 *      A host without one is a person's or an older build's, and is never considered, however dead its parent looks.
 *   2. THE HOST IS THE ONE THE FILE NAMES. The process table has the file's pid, started at the file's processStartedAt (within 2 ms:
 *      the table's creation time has microsecond precision). A reused pid is a different process.
 *   3. ITS PARENT IS DEAD. No process has its parent pid, or the one that does started AFTER the host did (a pid handed out again
 *      cannot be the host's parent).
 *   4. ITS LAUNCHER IS DEAD, the same way: the pid in the mark. A probe closes a window on purpose and expects its detached host to
 *      still be there when it reopens it (verify/probe-side-session.js), so a dead parent alone is not an orphan.
 *   5. NOBODY IS USING IT. No window is attached to it (host/window-count.js, the OS's established connections on its port): a probe's
 *      second run on the same explicit port, or a person's ▾ Open, ADOPTS an orphan, and parent and launcher being dead only say who
 *      started it. A count that could not be read keeps the host and is reported as unproven, never as "no orphans".
 *   6. THE KILL RE-PROVES THE START TIME on a held process handle, in the same step (host/kill-tree.js killProven), within the same
 *      2 ms the table proof allowed, then ends the tree by pid. No process is ever named, and a start time that cannot be read means
 *      nothing is stopped.
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

/** The window-count source for a real run: the OS's own established connections on the host's port (host/window-count.js). */
const realWindowCounts = (targets) => require('../../host/window-count').windowCounts(targets);

/**
 * The kill, with the SAME start-time tolerance the table-read proof in judge() used (PR #232 Miguel G3): the table's creation time and
 * the identity file's start differ by a few ticks of precision, so an exact compare at the kill would turn every real orphan into
 * "mismatch". One rule for both proofs.
 */
const makeKill = (killProven = realKillProven) => (pid, start) => killProven(pid, start, { toleranceTicks: Number(START_TOLERANCE) });

/**
 * The verdict for one marked identity against one table. Pure. { action: 'stop' | 'leave', why, unproven? }.
 * `self`: pids this sweep must never stop (itself and its parent).
 * `windows`: Map<pid, count> from host/window-count.js windowCounts, or null/absent when it could not be asked. A host is stopped only
 *   when its count is exactly 0: a window attached to it (a probe's second run on the same port, or a person's ▾ Open) keeps it, and so
 *   does an answer that is missing (PR #232 Dexter 1: who STARTED a host is not who is USING it).
 * `unproven` is true for a host that is RUNNING and was left only because it could not be proven either way, so a report never
 * says "no orphans" about it.
 */
function judge(entry, table, { self = [], windows = null } = {}) {
  if (!entry.pid) return { action: 'leave', why: 'its identity file has no usable pid' };
  if (self.includes(entry.pid)) return { action: 'leave', why: 'this is the sweep\'s own process' };
  if (!entry.start) return { action: 'leave', why: 'the host never published its start time, so it cannot be proven', unproven: table.has(entry.pid) };
  const host = table.get(entry.pid);
  if (!host) return { action: 'leave', why: 'not running (a stale identity file)' };
  if (abs(host.created, BigInt(entry.start)) > START_TOLERANCE) return { action: 'leave', why: 'the pid belongs to another process now (its start time differs)' };
  const alive = (pid) => {
    const p = pid > 0 ? table.get(pid) : undefined;
    return !!p && p.created <= host.created;       // one that started later is a reused pid, not the original
  };
  if (alive(host.ppid)) return { action: 'leave', why: `its parent ${host.ppid} is still running` };
  if (alive(entry.launcherPid)) return { action: 'leave', why: `its probe ${entry.launcherPid} is still running` };
  const attached = windows ? windows.get(entry.pid) : undefined;
  if (!Number.isInteger(attached) || attached < 0) return { action: 'leave', why: 'it could not be asked whether a window is attached, so it is kept', unproven: true };
  if (attached > 0) return { action: 'leave', why: `${attached} window${attached === 1 ? ' is' : 's are'} attached to it (a probe re-run or a person's Open), so it is in use` };
  return { action: 'stop', why: `marked ${entry.mark}; parent ${host.ppid} and probe ${entry.launcherPid} are gone, no window attached` };
}

/**
 * Judge every marked identity in `dir`; stop the ones judged 'stop' unless `dryRun` (the default: a sweep reports until it is told to stop).
 * Returns { files, marked, unmarked, unreadable, wouldStop, stopped, failed, left, unproven, unknown } -- `unknown` true when nothing could be
 * judged. `unproven`: running marked hosts that were left because they could not be proven either way (also listed in `left`).
 * ASYNC: the window count is one PowerShell query, asked only for hosts that passed every other proof.
 */
async function sweep({
  dir, dryRun = true, table, kill = makeKill(), self = [process.pid, process.ppid], windowCountsFn = realWindowCounts,
} = {}) {
  const ids = readIdentities(dir);
  const result = {
    files: ids.marked.length + ids.unmarked + ids.unreadable, marked: ids.marked.length, unmarked: ids.unmarked, unreadable: ids.unreadable,
    wouldStop: [], stopped: [], failed: [], left: [], unproven: [], unknown: false,
  };
  if (ids.marked.length === 0) return result;
  const procs = table === undefined ? readProcessTable() : table;   // read only when there is something to judge
  if (!procs) { result.unknown = true; return result; }
  // Pass 1 finds the hosts that pass every proof but the window count (a stand-in that says "0 attached" for all), so the query is asked once, and only if needed.
  const candidates = ids.marked.filter(e => judge(e, procs, { self, windows: { get: () => 0 } }).action === 'stop');
  let windows = null;
  if (candidates.length > 0) {
    try { windows = await windowCountsFn(candidates.map(e => ({ pid: e.pid, port: e.port }))); } catch { windows = null; }
    if (!(windows instanceof Map)) windows = null;
  }
  for (const e of ids.marked) {
    const v = judge(e, procs, { self, windows });
    if (v.action === 'leave') {
      result.left.push({ pid: e.pid, port: e.port, why: v.why });
      if (v.unproven) result.unproven.push({ pid: e.pid, port: e.port, why: v.why });
      continue;
    }
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

module.exports = { readIdentities, readProcessTable, judge, sweep, makeKill, START_TOLERANCE };
