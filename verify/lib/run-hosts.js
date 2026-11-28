'use strict';
/**
 * The hosts a probe's scratch projects started: every `<install>\.harness\hosts\<port>.json` whose `cwd` is inside the probe's temp
 * folder, with the pid AND the OS start time the host wrote (`processStartedAt`, host/proc-start.js FILETIME), so the probe can end
 * each one through seen-pids' add(pid, start) -> killProven.
 *
 * Why not host/host-identity.js readIdentity: it is the app's reader and returns no `processStartedAt`, so a probe that took the
 * start from it recorded nothing and its hosts were "skipped: no proven start, so it is left running" (measured 2026-11-28:
 * verify/probe-single-instance.js --cases=1-5 left seven hosts running). And the folder is compared by REAL path: the temp folder
 * comes back as an 8.3 short name (C:\Users\RICARD~1\...) while a host launched from a worktree may write the long one
 * (C:\Users\Ricardo Pujol\...); a plain string prefix missed the long ones.
 */
const fs = require('fs');
const path = require('path');

// The real path; a folder that is gone (or not made yet) is the real path of its nearest existing parent plus the rest, so a short and a
// long spelling still agree (app/probe-driver.js realPath does the same).
function realLower(p) {
  let existing = path.resolve(p);
  const rest = [];
  let r;
  for (;;) {
    try { r = path.join(fs.realpathSync.native(existing), ...rest); break; } catch {
      const parent = path.dirname(existing);
      if (parent === existing) { r = path.resolve(p); break; }
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// `isInside(folder)(p)`: p is the folder or under it, by real path.
function isInsideOf(folder, real = realLower) {
  const base = real(folder);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  return (p) => { const r = real(p); return r === base || r.startsWith(withSep); };
}

/** [{ port, pid, cwd, processStartedAt }] for every host file under `<harnessDir>\hosts` whose cwd is inside `folder`. */
function hostsUnder(harnessDir, folder, { readDir = fs.readdirSync, readFile = fs.readFileSync, real = realLower } = {}) {
  let files = [];
  try { files = readDir(path.join(harnessDir, 'hosts')).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const inside = isInsideOf(folder, real);
  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(readFile(path.join(harnessDir, 'hosts', f), 'utf8')); } catch { continue; }
    if (!j || typeof j.cwd !== 'string' || !Number.isInteger(j.pid) || j.pid <= 0) continue;
    if (!inside(j.cwd)) continue;
    out.push({ port: Number(f.replace(/\.json$/, '')), pid: j.pid, cwd: j.cwd,
      processStartedAt: typeof j.processStartedAt === 'string' && /^\d+$/.test(j.processStartedAt) ? j.processStartedAt : null });
  }
  return out;
}

module.exports = { hostsUnder, isInsideOf };
