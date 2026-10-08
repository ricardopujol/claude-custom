'use strict';
/**
 * Reading the process table for BACKLOG #74 A (verify/probe-electron-zombies.js): which processes belong to the
 * Electron a probe launched, what type each is (read from the command line BEFORE a close: it is unreadable after),
 * and how long each lingered.
 *
 * THE TREE RULE: a row's parent pid is only a parent if that parent STARTED BEFORE the child. Windows keeps the old
 * parent pid on an orphan, and pids are recycled: measured 2026-10-07, a freshly launched root got a pid that
 * ~100 orphaned Electrons from dead parents still named, and "every process whose ppid is in the set" took all of
 * them for the app's tree. Compared as numbers (FILETIMEs differ in digit count across the year-2000 boundary).
 */
const { spawnSync } = require('child_process');
const path = require('path');

function typeOf(cmd) {
  if (!cmd) return 'unreadable';
  const m = /--type=([^\s"]+)/.exec(cmd);
  return m ? m[1] : 'main';
}

// pid|ppid|threads|handles|privateMB|startFILETIME|commandLine  (the command line may itself hold a "|")
function parseRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = line.split('|');
    if (p.length < 6) continue;
    const [pid, ppid, thr, hnd, priv] = p.slice(0, 5).map(Number);
    if (![pid, ppid, thr, hnd, priv].every(Number.isFinite) || !/^\d+$/.test(p[5])) continue;
    rows.push({ pid, ppid, thr, hnd, privMB: priv, start: p[5], type: typeOf(p.slice(6).join('|')) });
  }
  return rows;
}

const zombieShaped = (r) => r.thr <= 1 && r.hnd === 0;

function descendantsOf(rows, rootPid, rootStart) {
  const root = rows.find(r => r.pid === rootPid);
  if (!root || (rootStart !== undefined && root.start !== String(rootStart))) return [];
  const inTree = new Map([[root.pid, root]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (inTree.has(r.pid)) continue;
      const parent = inTree.get(r.ppid);
      if (parent && BigInt(r.start) >= BigInt(parent.start)) { inTree.set(r.pid, r); grew = true; }
    }
  }
  return [...inTree.values()];
}

/**
 * tracked: rows taken before the close. polls: [{ t (seconds since the close), rows }] in time order.
 * Per tracked process: its type and private MB before, when it was first missing (goneAfterS, null = still listed
 * at the last poll), how long it was seen zombie-shaped (1 thread, 0 handles) up to that moment, and its last
 * private MB. A pid listed with another start time is a new process: the tracked one is gone.
 */
function summarize(tracked, polls) {
  return tracked.map((t0) => {
    let goneAfterS = null;
    let zombieSince = null;
    let lastPrivMB = t0.privMB;
    for (const poll of polls) {
      const r = poll.rows.find(x => x.pid === t0.pid && x.start === t0.start);
      if (!r) { goneAfterS = poll.t; break; }
      lastPrivMB = r.privMB;
      if (zombieShaped(r)) { if (zombieSince === null) zombieSince = poll.t; } else zombieSince = null;
    }
    const end = goneAfterS !== null ? goneAfterS : (polls.length ? polls[polls.length - 1].t : 0);
    return { pid: t0.pid, type: t0.type, privMBBefore: t0.privMB, goneAfterS, zombieSeenS: zombieSince === null ? 0 : end - zombieSince, lastPrivMB };
  });
}

/**
 * The cross-cycle report: summarize() results of every cycle, grouped by process type. `lingered` counts the ones
 * still listed more than lingerS seconds after the close (or never seen to leave: `stillThere`). maxGoneAfterS is
 * over the ones that did leave (null if none did).
 */
function byType(cycles, { lingerS }) {
  const out = {};
  for (const r of cycles.flat()) {
    const v = out[r.type] || (out[r.type] = { count: 0, lingered: 0, stillThere: 0, maxGoneAfterS: null, maxZombieSeenS: 0 });
    v.count++;
    if (r.goneAfterS === null) v.stillThere++;
    if (r.goneAfterS === null || r.goneAfterS > lingerS) v.lingered++;
    if (r.goneAfterS !== null && (v.maxGoneAfterS === null || r.goneAfterS > v.maxGoneAfterS)) v.maxGoneAfterS = r.goneAfterS;
    if (r.zombieSeenS > v.maxZombieSeenS) v.maxZombieSeenS = r.zombieSeenS;
  }
  return Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
}

// One PowerShell call for the whole table of one image name. Rows, or null when the query failed.
function queryRows(imageName = 'electron.exe', { run = spawnSync, powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } = {}) {
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $_.ProcessId,$_.ParentProcessId,$_.ThreadCount,$_.HandleCount,[int]($_.PrivatePageCount/1MB),$_.CreationDate.ToFileTimeUtc(),$_.CommandLine }; 'END'`;
  const r = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (!r || r.error || typeof r.stdout !== 'string' || !/^END\s*$/m.test(r.stdout)) return null;
  return parseRows(r.stdout);
}

module.exports = { typeOf, parseRows, zombieShaped, descendantsOf, summarize, byType, queryRows };
