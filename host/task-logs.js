'use strict';
/**
 * Big Claude Code task-output files, for the Leftovers readout (BACKLOG #74 item F(3)). Pure: no OS, no clock of its own.
 *
 * Claude Code writes a background task's output to `%TEMP%\claude\<project>\<session>\tasks\<id>.output`. A runaway task (a
 * console-less Python REPL looping on tracebacks) once grew one to 5.1 GB and filled C:. MEASURED 2026-10-08: the same task
 * file is often HARD-LINKED into several session folders (nlink 3, one inode), so a row is one inode, not one path.
 *
 * WHEN A FILE MAY BE DELETED BY THE APP (every one of these, otherwise it is shown only; doubt keeps):
 *   - it is at least MIN_BYTES and was last written at least IDLE_MS ago (a future or unreadable mtime keeps it);
 *   - the registries of live sessions (`<config>/sessions/<pid>.json`, host/session-registry.js) were read completely and hold
 *     at least one entry, and the process table is not empty;
 *   - NONE of the sessions that own the file (the folder names of every link) has an entry naming a running pid, AND every one
 *     of them was SEEN alive earlier in this run (so "ended" is observed, not inferred from absence);
 *   - every hard link was found (links seen == nlink), so a link in a session we did not scan keeps the file.
 * A file that is idle with nobody alive but a session never seen is "unknown": the person may Delete it by hand.
 */

// "100 MB" in the panel's own unit: every figure the Resources panel shows as "MB" is 1 048 576 bytes (app/resources-display.js
// fmtBytes), so a listed file always reads as 100 MB or more there. (Ricardo, PR #133 review: the label and the code agree.)
const { sameStart } = require('./resource-tree');
const MIN_BYTES = 100 * 1024 * 1024;
const IDLE_MS = 15 * 60_000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';

/**
 * `root/<project>/<session>/tasks/<id>.output` exactly -> { project, session, name }, else null. Separators of either kind;
 * no `.`/`..` segment, no empty name, nothing deeper or shallower. The shape is the only thing a delete may be aimed at.
 */
function parseTaskPath(root, p) {
  if (!isStr(root) || !isStr(p) || root === '' || p === '') return null;
  const split = s => s.split(/[\\/]+/);
  const r = split(root).filter(Boolean);
  const parts = split(p);
  const segs = parts.filter(Boolean);
  if (p.endsWith('\\') || p.endsWith('/')) return null;
  if (segs.length !== r.length + 4) return null;
  for (let i = 0; i < r.length; i++) if (segs[i].toLowerCase() !== r[i].toLowerCase()) return null;
  const [project, session, tasks, name] = segs.slice(r.length);
  if (tasks !== 'tasks') return null;
  if ([project, session].some(s => s === '.' || s === '..') || !/\.output$/.test(name) || name === '.output' || name === '..output') return null;
  if (/[:*?"<>|]/.test(project + session + name)) return null;
  return { project, session, name };
}

/**
 * What a registry entry says about its session right now, against the process table (a Set of pids, or a Map pid -> start):
 *   'alive'   its pid is listed (and its procStart, when both sides have one, is the same process within the table's slack);
 *   'reused'  its pid is listed but with ANOTHER start: not this session's process, yet its end was not observed either, so nothing
 *             may be deleted on it by the clock (Dexter #6). The ledger's DST caveat (PR #132 F1) is why this is "unknown", not "ended";
 *   'absent'  its pid is not listed.
 */
function entryState(entry, listed) {
  if (!entry || !listed.has(entry.pid)) return 'absent';
  const table = listed instanceof Map ? listed.get(entry.pid) : null;
  if (isStr(entry.procStart) && isStr(table) && /^\d+$/.test(entry.procStart) && /^\d+$/.test(table) && !sameStart(entry.procStart, table)) return 'reused';
  return 'alive';
}
const isDigits = v => isStr(v) && /^\d+$/.test(v);
/**
 * What the app records when it SEES a session alive: [{ sessionId, pid, start }] for every 'alive' entry, `start` being the PROCESS
 * TABLE's start for that pid (null when unreadable). Later, "ended" is judged against exactly that process (see classify), taken
 * from the same source, so a clock-source skew cannot make a live process look like another.
 */
function aliveEntries(registry, listed) {
  const out = [];
  if (!registry || registry.ok !== true || !Array.isArray(registry.entries) || !(listed instanceof Set || listed instanceof Map)) return out;
  for (const e of registry.entries) {
    if (!e || !isStr(e.sessionId) || entryState(e, listed) !== 'alive') continue;
    const table = listed instanceof Map ? listed.get(e.pid) : null;
    out.push({ sessionId: e.sessionId, pid: e.pid, start: isDigits(table) ? table : null });
  }
  return out;
}
/** Is the process the app saw a session under gone? Its pid is not listed, or is listed with another readable start. Doubt: not gone. */
function processGone(rec, listed) {
  if (!listed.has(rec.pid)) return true;
  const table = listed instanceof Map ? listed.get(rec.pid) : null;
  return isDigits(rec.start) && isDigits(table) && !sameStart(rec.start, table);
}

/**
 * classify({ files, registry, listedPids, seen, now, minBytes, idleMs }) -> rows, biggest first
 * files: [{ path, project, session, name, bytes, mtimeMs, dev, ino, nlink }]  (a stat of each task file; never its contents)
 * registry: { ok, entries: [{ pid, sessionId }] } | null     listedPids: the pids in the process table (a non-empty Set or Map)
 * seen: Map session id -> [{ pid, start }]: the processes the app SAW the session alive under (aliveEntries) on an earlier read of this run
 * row: { key, name, project, sessions, paths, bytes, mtimeMs, ageMs (null: unknown), deletable (the app may delete it by
 *        itself), manualDelete (the person may choose to), why, dev, ino }
 *
 * "ENDED" is positive evidence about a PROCESS, never an absence from a registry (Ricardo, PR #133 review; Dexter #1, r2 #1): a session
 * is ended only when the app saw it alive under a pid and THAT pid is now gone from the process table (or runs with another readable
 * start), and no entry of the session names a running pid. A registry that no longer lists it (a tab's dir that is no longer read, a
 * removed file, a re-key) proves nothing. A session in no registry we read is UNKNOWN: it may run under another config dir, be a CLI
 * that does not register, or be re-keyed. Unknown files are kept; once idle they get the
 * manual Delete, so the person decides. An empty or missing process table or registry makes everything unknown.
 */
function classify({ files, registry, listedPids, seen, monoAge, now = Date.now(), minBytes = MIN_BYTES, idleMs = IDLE_MS }) {
  const listed = listedPids instanceof Set || listedPids instanceof Map ? listedPids : null;
  const everSeen = seen instanceof Map ? seen : new Map();
  const regOk = !!registry && registry.ok === true && Array.isArray(registry.entries) && registry.entries.length > 0;
  const ctxOk = regOk && listed !== null && listed.size > 0;
  const stateOf = (sid) => {
    const states = registry.entries.filter(e => e && e.sessionId === sid).map(e => entryState(e, listed));
    return states.includes('alive') ? 'alive' : states.includes('reused') ? 'reused' : 'absent';
  };
  const groups = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !isNum(f.bytes) || f.bytes < minBytes) continue;
    const k = `${f.dev}:${f.ino}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const rows = [];
  for (const [key, members] of groups) {
    const m = members[0];
    const ageMs = isNum(m.mtimeMs) ? now - m.mtimeMs : null;
    const sessions = [...new Set(members.map(x => x.session))];
    const settled = ctxOk && ageMs !== null && ageMs >= 0 && members.length === m.nlink;   // the time and every link are known
    const states = ctxOk ? sessions.map(stateOf) : [];
    const anyAlive = states.includes('alive');
    const idle = settled && ageMs >= idleMs;
    const manualDelete = idle && !anyAlive;
    const endedSeen = manualDelete && sessions.every((sid, i) => states[i] === 'absent' && (everSeen.get(sid) || []).length > 0 && everSeen.get(sid).every(rec => processGone(rec, listed)));
    // `monoAge(key)`, when given: how long the file has been idle by the MONOTONIC clock, which a wall-clock step cannot move forward
    // (Dexter #4). Not enough (or never observed): the app waits; the person's Delete is not held back.
    const monoOk = typeof monoAge !== 'function' || (isNum(monoAge(key)) && monoAge(key) >= idleMs);
    const deletable = endedSeen && monoOk;
    // WHY it is shown: 'delete' (the app will), 'alive' (a session of it is running), 'young' (written within idleMs),
    // 'settling' (idle by the wall clock, not yet confirmed by the monotonic one),
    // 'unknown' (the registry, the time, a link or the session's end could not be settled: doubt keeps).
    const why = !settled ? 'unknown' : anyAlive ? 'alive' : !idle ? 'young' : deletable ? 'delete' : endedSeen ? 'settling' : 'unknown';
    rows.push({ key, name: m.name, project: m.project, sessions, paths: members.map(x => x.path), bytes: m.bytes, mtimeMs: m.mtimeMs, ageMs: ageMs === null ? null : Math.max(0, ageMs), deletable, manualDelete, why, dev: m.dev, ino: m.ino });
  }
  return rows.sort((a, b) => (b.bytes - a.bytes) || (a.key < b.key ? -1 : 1));
}

module.exports = { classify, entryState, aliveEntries, parseTaskPath, MIN_BYTES, IDLE_MS };
