'use strict';
/* Each window gets its own Chromium cache (BACKLOG #215).
 *
 * Every window shares `%APPDATA%\claude-custom` as its user-data folder, so a window started while another runs found the
 * first one's cache folders locked and printed `Unable to move the cache: Access is denied`, `Unable to create cache` and
 * `Gpu Cache Creation failed: -2`. userData itself must stay shared (localStorage and the single-instance measurement of
 * PR #247 depend on it), so only the caches move: the HTTP/disk cache goes to a folder named for this process.
 * The GPU shader disk cache has no folder switch (Chromium keeps it inside the user-data folder), so it is switched off ONLY
 * for a window that has a live peer, the one whose cache the peer holds (PR #251 Miguel Y4): the first or only window keeps its
 * shader cache and its first-paint speed.
 * The folder is removed at will-quit when it can be (Chromium may still hold files then, and app.exit() skips will-quit), and
 * otherwise by the next start, which sweeps every folder whose pid is gone. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'claude-custom-cache-';

function cacheDirFor(pid, tmp = os.tmpdir()) { return path.join(tmp, `${PREFIX}${pid}`); }

/** The pid a cache folder's name carries, or null when the name isn't ours or isn't a plain number. */
function pidOfName(name) {
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return null;
  const digits = name.slice(PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const pid = Number(digits);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return !!err && err.code === 'EPERM'; }
}

/** Remove cache folders whose process is gone. Best effort; returns the names removed. */
function sweepStale(tmp = os.tmpdir(), alive = pidAlive) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return removed; }
  for (const name of names) {
    const pid = pidOfName(name);
    if (pid === null || alive(pid)) continue;
    try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); removed.push(name); } catch { /* in use: next start */ }
  }
  return removed;
}

/** The pids of OTHER live windows: their cache folders are in `tmp` and their processes are running. */
function livePeers(pid, tmp = os.tmpdir(), alive = pidAlive) {
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return []; }
  return names.map(pidOfName).filter(p => p !== null && p !== pid && alive(p));
}

/** The command-line switches for this process: [[name, value], ...]. `peers`: another window is running. */
function cacheSwitches(pid, tmp, peers = false) {
  const out = [['disk-cache-dir', cacheDirFor(pid, tmp)]];
  if (peers) out.push(['disable-gpu-shader-disk-cache', '']);
  return out;
}

/** Apply the switches to `app` (before `ready`) and remove this process's folder when the app quits. */
function useOwnCaches(app, pid = process.pid, tmp = os.tmpdir(), env = process.env) {
  // CLAUDE_CUSTOM_SHARED_CACHE=1: Chromium's own shared cache, as before #215. Only verify/probe-cache-errors.js --baseline sets it,
  // to prove the probe can see the lines this module removes.
  if (env.CLAUDE_CUSTOM_SHARED_CACHE === '1') return;
  sweepStale(tmp);
  // Make the folder first, then look for peers: a window that starts at the same moment sees this one, and both are the "second".
  try { fs.mkdirSync(cacheDirFor(pid, tmp), { recursive: true }); } catch { /* Chromium makes it */ }
  for (const [name, value] of cacheSwitches(pid, tmp, livePeers(pid, tmp).length > 0)) app.commandLine.appendSwitch(name, value);
  app.once('will-quit', () => { try { fs.rmSync(cacheDirFor(pid, tmp), { recursive: true, force: true }); } catch { /* the sweep gets it */ } });
}

module.exports = { cacheDirFor, cacheSwitches, sweepStale, livePeers, pidOfName, pidAlive, useOwnCaches, PREFIX };
