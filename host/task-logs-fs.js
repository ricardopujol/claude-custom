'use strict';
/**
 * The OS side of the task-output readout (BACKLOG #74 F(3)); the decision is host/task-logs.js. Three things, all injectable:
 *   scanTaskFiles(root)         lstat of every `root/<project>/<session>/tasks/<id>.output`. STAT ONLY: no file is ever
 *                               opened or read, a symlink is skipped, a folder that cannot be listed is skipped.
 *   readRegistry(dir)           the CLI's live-session registry, `<pid>.json` only (a `.key` beside it holds a peer token and
 *                               is never opened). `ok` only when the directory and EVERY json read and carried a pid and
 *                               a sessionId: one thing it could not read means a session it cannot see, and doubt keeps.
 *   deleteTaskLog(root, row)    the ONLY thing that removes a file. It re-proves, per link, at the moment of unlinking: the
 *                               path has the exact shape (host/task-logs.js parseTaskPath), is a plain file (not a link, not a
 *                               directory), is the SAME inode the scan saw with the SAME mtime, is still idle, and its folder
 *                               resolves to where the path says (a junction or symlink swapped in leads nowhere).
 */

const fs = require('fs');
const path = require('path');
const { parseTaskPath, IDLE_MS } = require('./task-logs');

const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const num = v => Number(v);

async function listDir(fsp, dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function scanTaskFiles(root, fsp = fs.promises) {
  const out = [];
  for (const proj of await listDir(fsp, root)) {
    if (!proj.isDirectory()) continue;
    for (const sess of await listDir(fsp, path.join(root, proj.name))) {
      if (!sess.isDirectory()) continue;
      const dir = path.join(root, proj.name, sess.name, 'tasks');
      for (const ent of await listDir(fsp, dir)) {
        if (!ent.isFile() || !ent.name.endsWith('.output')) continue;
        const p = path.join(dir, ent.name);
        if (!parseTaskPath(root, p)) continue;
        let st;
        try { st = await fsp.lstat(p, { bigint: true }); } catch { continue; }
        if (!st.isFile()) continue;
        out.push({ path: p, project: proj.name, session: sess.name, name: ent.name, bytes: num(st.size), mtimeMs: num(st.mtimeMs), dev: String(st.dev), ino: String(st.ino), nlink: num(st.nlink) });
      }
      await yieldTurn();
    }
  }
  return out;
}

async function readRegistry(dir, fsp = fs.promises) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return { ok: false, entries: [] }; }
  const entries = [];
  let ok = true;
  for (const n of names.filter(x => /^\d+\.json$/.test(x))) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
      if (j && Number.isInteger(j.pid) && j.pid > 0 && typeof j.sessionId === 'string' && j.sessionId !== '') entries.push({ pid: j.pid, sessionId: j.sessionId });
      else ok = false;
    } catch { ok = false; }
  }
  return { ok, entries };
}

/**
 * The `sessions` dir of every config dir a session of this app may be registered in: main's own, plus one per open tab (a
 * tab's `claude` runs in its folder, and a RELATIVE CLAUDE_CONFIG_DIR resolves against that folder, not main's cwd).
 * `configDir({ cwd })` is host/claude-config-dir.js. Unique, in order.
 */
function registryDirs(tabCwds, configDir) {
  const dirs = [configDir()];
  for (const cwd of Array.isArray(tabCwds) ? tabCwds : []) if (typeof cwd === 'string' && cwd !== '') dirs.push(configDir({ cwd }));
  return [...new Set(dirs.map(d => path.join(d, 'sessions')))];
}

// Every config dir a session of this machine may be registered in: merged, and not ok if any one is not.
async function readRegistries(dirs, fsp = fs.promises) {
  const list = [...new Set(dirs)];
  const all = await Promise.all(list.map(d => readRegistry(d, fsp)));
  return { ok: list.length > 0 && all.every(r => r.ok), entries: all.flatMap(r => r.entries) };
}

const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function deleteTaskLog(root, row, { fsp = fs.promises, now = Date.now, idleMs = IDLE_MS } = {}) {
  const res = { deleted: 0, failed: 0, kept: 0, freed: 0 };
  if (!row || (row.deletable !== true && row.manualDelete !== true) || !Array.isArray(row.paths) || !Number.isFinite(row.mtimeMs)) return { ...res, kept: Array.isArray(row && row.paths) ? row.paths.length : 0 };
  let realRoot;
  try { realRoot = await fsp.realpath(root); } catch { return { ...res, kept: row.paths.length }; }
  for (const p of row.paths) {
    try {
      if (!parseTaskPath(root, p)) { res.kept++; continue; }
      const dir = path.dirname(p);
      const realDir = await fsp.realpath(dir);
      if (!within(realRoot, realDir) || !same(realDir, path.join(realRoot, path.relative(root, dir)))) { res.kept++; continue; }
      const st = await fsp.lstat(p, { bigint: true });
      const idle = now() - num(st.mtimeMs);
      if (!st.isFile() || String(st.dev) !== String(row.dev) || String(st.ino) !== String(row.ino)
        || num(st.mtimeMs) !== row.mtimeMs || !(idle >= idleMs)) { res.kept++; continue; }
      await fsp.unlink(p);
      res.deleted++;
    } catch { res.failed++; }
  }
  if (res.deleted > 0 && res.failed === 0 && res.kept === 0) res.freed = Number.isFinite(row.bytes) ? row.bytes : 0;
  return res;
}

module.exports = { scanTaskFiles, readRegistry, readRegistries, registryDirs, deleteTaskLog };
