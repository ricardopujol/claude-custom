'use strict';
/**
 * Every running claude-custom host, from every build, for the strip's ▾ menu
 * (Windowless sessions PR 2; the 2026-09-25 #19 design). A host is detached on
 * purpose, so it outlives its window; this is how a person finds one again.
 *
 *   listBackgroundHosts({ ownInstall }, deps) -> { rows, verified }
 *   rows: { install, build, own, port, pid, cwd, startedAt, processStartedAt, exact, windows }
 *
 * Read from each build's identity files (`<install>/.harness/hosts/<port>.json`,
 * host/host-identity.js). A file outlives its host, and Windows reuses pids, so
 * a file is only a claim. A row is shown only once it is PROVEN, two ways:
 *
 *   exact  the file carries the host's OS start time (`processStartedAt`,
 *          written since PR 2) and the live pid's OS start time is that one.
 *          No clock is involved, so nothing can fake it.
 *   wall   an older build's file has no start time: the pid is alive and the
 *          OS says it started no later than the file was written (`startedAt`,
 *          Date.now()). True while the clock never steps back -- and only then
 *          (Dexter, PR 2 F1: set it back an hour and a process that took a dead
 *          host's pid "started before the write"). So a wall-proven row is
 *          `exact: false`, and host/stop-holder.js stopHost never kills one by
 *          pid: it is stopped only by its own token-checked controls, which an
 *          impostor can't answer. The reverse clock step can drop a live old
 *          host from the list (F4); that only hides, never stops.
 *
 * An unproven file is never displayed (dead or reused), never deleted either.
 * `processStartedAt` is the OS start time read here: a later stop re-proves
 * the pid against exactly that, as PR 1 did with a lock's.
 *
 * ONE ROW PER PID (Miguel Y3, Dexter F3). A copied build folder carries the
 * live host's file too, and which build wrote it can't be told: shown once,
 * and `own` only when every file naming it is this build's -- Open is never
 * offered on a guess.
 *
 * `verified: false` means some host may be missing: the OS couldn't be asked,
 * a live pid's start time couldn't be read, or an install couldn't be listed.
 * `windows` is the OS's count (host/window-count.js), null when it couldn't
 * tell -- NEVER 0 for "unknown".
 *
 * deps: installs() -> [path], identities(install) -> [{ port, parsed }],
 *       startTimes(pids) -> Map|null, windowCounts([{pid, port}]) -> Map|null
 */

const fs = require('fs');
const path = require('path');
const { samePath } = require('./project-layout');

const validPid = n => Number.isInteger(n) && n > 0;
const validPort = n => Number.isInteger(n) && n > 0 && n < 65536;
const FILETIME_EPOCH_MS = 11644473600000n;   // 1601-01-01 to 1970-01-01

/** A FILETIME string (100 ns ticks since 1601, UTC) as epoch ms, or null. */
function filetimeToMs(ft) {
  if (typeof ft !== 'string' || !/^\d+$/.test(ft)) return null;
  return Number(BigInt(ft) / 10000n - FILETIME_EPOCH_MS);
}

// The identity's claim, or null when it can't even be a claim.
function claimOf(install, port, parsed) {
  if (!validPort(port)) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.cwd !== 'string' || !parsed.cwd.trim()) return null;
  if (!validPid(parsed.pid)) return null;
  if (parsed.port !== port) return null;               // moved or hand-edited
  if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt)) return null;
  // Present but not a FILETIME is no proof of anything: dropped, not downgraded.
  const exactStart = parsed.processStartedAt;
  if (exactStart !== undefined && filetimeToMs(exactStart) === null) return null;
  return { install, port, pid: parsed.pid, cwd: parsed.cwd, startedAt: parsed.startedAt, exactStart };
}

async function listBackgroundHosts({ ownInstall } = {}, deps = {}) {
  let verified = true;
  const claims = [];
  for (const install of deps.installs()) {
    let entries;
    try { entries = deps.identities(install); } catch { verified = false; continue; }
    for (const { port, parsed } of entries) {
      const c = claimOf(install, port, parsed);
      if (c) claims.push(c);
    }
  }
  if (claims.length === 0) return { rows: [], verified };

  const starts = await deps.startTimes([...new Set(claims.map(c => c.pid))]);
  if (starts === null) return { rows: [], verified: false };

  const byPid = new Map();
  for (const c of claims) {
    if (!starts.has(c.pid)) continue;                  // not running
    const os = starts.get(c.pid);
    const osMs = filetimeToMs(os);
    if (osMs === null) { verified = false; continue; } // running, start unreadable
    const exact = c.exactStart !== undefined;
    if (exact ? os !== c.exactStart : osMs > c.startedAt) continue;   // a reused pid
    const own = samePath(c.install, ownInstall);
    const seen = byPid.get(c.pid);
    if (!seen) { byPid.set(c.pid, { ...c, processStartedAt: os, exact, own }); continue; }
    // The newest file speaks for it; own only if every file is this build's.
    const keep = c.startedAt > seen.startedAt ? { ...c, processStartedAt: os, exact } : seen;
    byPid.set(c.pid, { ...keep, own: seen.own && own });
  }
  const proven = [...byPid.values()];
  if (proven.length === 0) return { rows: [], verified };

  const counts = await deps.windowCounts(proven.map(c => ({ pid: c.pid, port: c.port })));
  const windowsOf = (pid) => {
    const n = counts ? counts.get(pid) : null;
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const rows = proven.map(c => ({
    install: c.install,
    build: path.basename(c.install),
    own: c.own,
    port: c.port,
    pid: c.pid,
    cwd: c.cwd,
    startedAt: c.startedAt,
    processStartedAt: c.processStartedAt,
    exact: c.exact,
    windows: windowsOf(c.pid),
  }));
  // This build's own first (they can be opened), then newest first.
  rows.sort((a, b) => (b.own - a.own) || (b.startedAt - a.startedAt));
  return { rows, verified };
}

const hostsDir = install => path.join(install, '.harness', 'hosts');
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * This build and every sibling build (the worktree layout puts each branch's
 * checkout beside `dev\`) that has ever run a host. A sibling counts only with
 * `host/host.js` too: a `.harness\hosts` dir alone is not a claude-custom build.
 */
function installsBeside(ownInstall) {
  const parent = path.dirname(ownInstall);
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return [ownInstall]; }
  const found = names
    .map(n => path.join(parent, n))
    .filter(dir => !samePath(dir, ownInstall) && isDir(hostsDir(dir)) && isFile(path.join(dir, 'host', 'host.js')));
  return [ownInstall, ...found];
}

/**
 * `<install>/.harness/hosts/<port>.json`, each parsed (null when half-written
 * or unreadable). Only `<digits>.json` is opened: never a token, never a tmp.
 * No dir is no hosts (a build that never ran one). Any other failure to list
 * it throws, which the list reads as unverified.
 */
function identitiesIn(install) {
  const dir = hostsDir(install);
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter(n => /^\d+\.json$/.test(n))
    .map((n) => {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { parsed = null; }
      return { port: Number(n.slice(0, -'.json'.length)), parsed };
    });
}

module.exports = { listBackgroundHosts, filetimeToMs, installsBeside, identitiesIn };
