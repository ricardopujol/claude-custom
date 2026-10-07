'use strict';
/**
 * The PID ledger (BACKLOG #74 B). A PURE, host-requirable module: the verify/ launcher and reaper are its first
 * users, and the app's Resources panel ("Leftovers") and an automatic reap of leftovers older than 15 minutes read
 * it later. Every Electron a probe launches (kind 'probe-window'), and later every agent shell (kind 'agent-shell'),
 * is written here with its launcher, each proven by START TIME (a FILETIME string from host/proc-start.js).
 *
 * THE PROOF (host/background-hosts.js's rule): a pid alone proves nothing on Windows, it is reused (measured
 * 2026-10-06: a root this work had launched was a different node.exe an hour later). A process is the recorded one
 * only if its CURRENT start time equals the recorded one. Three answers stay apart, as in proc-start.js: absent from
 * the map (not running), null in the map (running, start unreadable), null for the whole map (the query failed).
 * Doubt always KEEPS a process: an unreadable start never selects a kill, and an unreadable launcher counts as alive.
 *
 * One JSON object per line, appended; a half-written or junk line is skipped, never fatal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const KINDS = ['probe-window', 'agent-shell'];
const validPid = pid => Number.isInteger(pid) && pid > 0;
const validStart = s => typeof s === 'string' && /^\d+$/.test(s);

function defaultLedgerFile() {
  return path.join(os.tmpdir(), 'claude-custom-probe-ledger.jsonl');
}

function serializeEntry(e) {
  return JSON.stringify({
    pid: e.pid, start: e.start, launcher: e.launcher || null,
    kind: e.kind || 'probe-window', label: e.label || '',
    createdAt: Number.isFinite(e.createdAt) ? e.createdAt : Date.now(),
  });
}

function parseLedger(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (!o || typeof o !== 'object' || !validPid(o.pid) || !validStart(o.start)) continue;
    const l = o.launcher;
    out.push({
      pid: o.pid, start: o.start,
      launcher: l && validPid(l.pid) && validStart(l.start) ? { pid: l.pid, start: l.start } : null,
      kind: KINDS.includes(o.kind) ? o.kind : 'probe-window',
      label: typeof o.label === 'string' ? o.label : '',
      createdAt: Number.isFinite(o.createdAt) ? o.createdAt : null,
    });
  }
  return out;
}

function readLedger(file = defaultLedgerFile()) {
  try { return parseLedger(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function appendEntry(file, e) {
  fs.appendFileSync(file, serializeEntry(e) + '\n');
}

function removePids(file, pids) {
  const drop = new Set(pids);
  const keep = readLedger(file).filter(e => !drop.has(e.pid));
  // Temp file then rename (CLAUDE.md: never open with 'w' before the write is sure).
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, keep.map(serializeEntry).join('\n') + (keep.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}

// starts: Map<pid, FILETIME string | null> from host/proc-start.js startTimes(), or null when the query failed.
function isRecordedProcess(e, starts) {
  return starts.has(e.pid) && starts.get(e.pid) === e.start;
}

function launcherAlive(e, starts) {
  if (!e.launcher) return false;
  if (!starts.has(e.launcher.pid)) return false;
  const s = starts.get(e.launcher.pid);
  return s === null || s === e.launcher.start;     // unreadable: doubt keeps the process
}

// The reapable set: the recorded process is running (start proven), its launcher is gone, and, with minAgeMs > 0,
// it was created at least that long before `now` (an entry with no createdAt is never old enough).
function selectReapable(entries, starts, { now = Date.now(), minAgeMs = 0 } = {}) {
  if (!starts) return [];
  const oldEnough = e => minAgeMs <= 0 || (Number.isFinite(e.createdAt) && now - e.createdAt >= minAgeMs);
  return entries.filter(e => isRecordedProcess(e, starts) && !launcherAlive(e, starts) && oldEnough(e));
}

// Entries that can never be reaped again: the process is gone, or the pid now belongs to another process.
function staleEntries(entries, starts) {
  if (!starts) return [];
  return entries.filter(e => {
    if (!starts.has(e.pid)) return true;
    const s = starts.get(e.pid);
    return s !== null && s !== e.start;
  });
}

module.exports = { KINDS, defaultLedgerFile, serializeEntry, parseLedger, readLedger, appendEntry, removePids, selectReapable, staleEntries, launcherAlive, isRecordedProcess };
