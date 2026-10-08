'use strict';
/**
 * Big Claude Code task-output files, for the Leftovers readout (BACKLOG #74 item F(3)). Pure: no OS, no clock of its own.
 *
 * Claude Code writes a background task's output to `%TEMP%\claude\<project>\<session>\tasks\<id>.output`. A runaway task (a
 * console-less Python REPL looping on tracebacks) once grew one to 5.1 GB and filled C:. MEASURED 2026-10-08: the same task
 * file is often HARD-LINKED into several session folders (nlink 3, one inode), so a row is one inode, not one path.
 *
 * WHEN A FILE MAY BE DELETED (every one of these, otherwise it is shown only; doubt keeps):
 *   - it is at least MIN_BYTES and was last written at least IDLE_MS ago (a future or unreadable mtime keeps it);
 *   - the registry of live sessions (`<config>/sessions/<pid>.json`, host/session-registry.js) was read completely, holds at
 *     least one entry, and NONE of the sessions that own the file (the folder names of every link) has a registry entry
 *     whose pid is still in the process table, whatever that pid's start (a reused pid reads as alive: doubt keeps);
 *   - every hard link was found (links seen == nlink), so a link in a session we did not scan keeps the file.
 */

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
 * classify({ files, registry, listedPids, now, minBytes, idleMs }) -> rows, biggest first
 * files: [{ path, project, session, name, bytes, mtimeMs, dev, ino, nlink }]  (a stat of each task file; never its contents)
 * registry: { ok, entries: [{ pid, sessionId }] } | null     listedPids: Set of the pids in the process table
 * row: { key, name, project, sessions, paths, bytes, mtimeMs, ageMs (null: unknown), deletable, why, dev, ino }
 */
function classify({ files, registry, listedPids, now = Date.now(), minBytes = MIN_BYTES, idleMs = IDLE_MS }) {
  const listed = listedPids instanceof Set ? listedPids : new Set();
  const regOk = !!registry && registry.ok === true && Array.isArray(registry.entries) && registry.entries.length > 0;
  const alive = (sid) => !regOk || registry.entries.some(e => e && e.sessionId === sid && listed.has(e.pid));
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
    const live = regOk && sessions.some(alive);
    // WHY it is shown: 'delete' (every condition holds), 'alive' (a session of it is running), 'young' (written within idleMs),
    // 'unknown' (the registry, the time or a link could not be settled: doubt keeps).
    const why = !regOk || ageMs === null || ageMs < 0 || members.length !== m.nlink ? 'unknown' : live ? 'alive' : ageMs < idleMs ? 'young' : 'delete';
    const deletable = why === 'delete';
    rows.push({ key, name: m.name, project: m.project, sessions, paths: members.map(x => x.path), bytes: m.bytes, mtimeMs: m.mtimeMs, ageMs: ageMs === null ? null : Math.max(0, ageMs), deletable, why, dev: m.dev, ino: m.ino });
  }
  return rows.sort((a, b) => (b.bytes - a.bytes) || (a.key < b.key ? -1 : 1));
}

module.exports = { classify, parseTaskPath, MIN_BYTES, IDLE_MS };
