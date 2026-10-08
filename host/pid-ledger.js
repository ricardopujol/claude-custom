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
    if (o.removed === true) {
      // A tombstone: the process with this pid AND start is gone, so every earlier line for it goes (never a line with
      // the same pid and another start: that is another process).
      for (let i = out.length - 1; i >= 0; i--) if (out[i].pid === o.pid && out[i].start === o.start) out.splice(i, 1);
      continue;
    }
    const l = o.launcher;
    out.push({
      pid: o.pid, start: o.start,
      // { pid, start: null }: the launcher's pid is known but its start could not be read when the entry was written.
      launcher: l && validPid(l.pid) && (validStart(l.start) || l.start === null) ? { pid: l.pid, start: l.start } : null,
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

/*
 * WRITES (PR #130 review, Dexter #5 + Miguel M2). The ledger is shared by every probe, lane and the reaper at once, so:
 *   - adding and removing are both APPENDS, under host/file-lock.js's cross-process lock. A removal is a tombstone
 *     line { pid, start, removed: true } matched on pid AND start, so it can never take a newer entry that reused the
 *     pid, and there is no read-modify-write in which another process's new line could be lost;
 *   - only compact() rewrites the file, under the same lock (so no append can land between its read and its rename),
 *     and a rename Windows refuses (EPERM / EBUSY while another process has the file open) is retried, then reported
 *     as { ok: false, error }: never thrown after kills have happened, never swallowed.
 * The lock fails closed: appendEntry throws, removeEntries and compact return { ok: false }.
 */
const { withFileLock } = require('./file-lock');
const lockOf = file => `${file}.lock`;

function appendEntry(file, e, { deadlineMs } = {}) {
  withFileLock(lockOf(file), () => fs.appendFileSync(file, serializeEntry(e) + '\n'), { deadlineMs });
}

function removeEntries(file, entries, { deadlineMs } = {}) {
  const lines = entries.filter(e => e && validPid(e.pid) && validStart(e.start))
    .map(e => JSON.stringify({ pid: e.pid, start: e.start, removed: true }) + '\n').join('');
  if (!lines) return { ok: true };
  try {
    withFileLock(lockOf(file), () => fs.appendFileSync(file, lines), { deadlineMs });
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && (err.code || err.message)) || String(err) }; }
}

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function compact(file, { deadlineMs, renameFn = fs.renameSync, retries = 5, retryMs = 50 } = {}) {
  try {
    return withFileLock(lockOf(file), () => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return err.code === 'ENOENT' ? { ok: true } : { ok: false, error: err.code || err.message }; }
      const keep = parseLedger(text);
      // Temp file then rename (CLAUDE.md: never open with 'w' before the write is sure).
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, keep.map(serializeEntry).join('\n') + (keep.length ? '\n' : ''));
      let last = null;
      for (let i = 0; i <= retries; i++) {
        try { renameFn(tmp, file); return { ok: true }; } catch (err) {
          last = err;
          if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
          if (i < retries) sleepMs(retryMs);
        }
      }
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      return { ok: false, error: (last && (last.code || last.message)) || 'rename failed' };
    }, { deadlineMs });
  } catch (err) { return { ok: false, error: (err && (err.code || err.message)) || String(err) }; }
}

// starts: Map<pid, FILETIME string | null> from host/proc-start.js startTimes(), or null when the query failed.
function isRecordedProcess(e, starts) {
  return starts.has(e.pid) && starts.get(e.pid) === e.start;
}

// Doubt keeps (PR #130 review, Dexter #3 = Miguel M1): no launcher recorded at all is UNKNOWN, so alive; a launcher
// whose start could not be read when it was recorded is alive while its pid is listed (that pid may be it), and gone
// only once no process has it.
function launcherAlive(e, starts) {
  if (!e.launcher) return true;
  if (!starts.has(e.launcher.pid)) return false;
  const s = starts.get(e.launcher.pid);
  if (e.launcher.start === null) return true;
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

module.exports = { KINDS, defaultLedgerFile, serializeEntry, parseLedger, readLedger, appendEntry, removeEntries, compact, selectReapable, staleEntries, launcherAlive, isRecordedProcess };
