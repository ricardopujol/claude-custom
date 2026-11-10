'use strict';
/* Each window gets its own Chromium cache (BACKLOG #215).
 *
 * Every window shares `%APPDATA%\claude-custom` as its user-data folder, so a window started while another runs found the
 * first one's cache folders locked and printed `Unable to move the cache: Access is denied`, `Unable to create cache` and
 * `Gpu Cache Creation failed: -2`. userData itself must stay shared (localStorage and the single-instance measurement of
 * PR #247 depend on it), so only the caches move: the HTTP/disk cache goes to a folder named for this process, and the GPU
 * shader disk cache (which Chromium keeps inside the user-data folder with no switch to move it) is switched off.
 * The folder is removed on exit, and a folder left by a crash is swept at the next start when its pid is gone. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'claude-custom-cache-';

function cacheDirFor(pid, tmp = os.tmpdir()) { return path.join(tmp, `${PREFIX}${pid}`); }

/** The command-line switches that give this process its own caches: [[name, value], ...]. */
function cacheSwitches(pid, tmp) {
  return [['disk-cache-dir', cacheDirFor(pid, tmp)], ['disable-gpu-shader-disk-cache', '']];
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

/** Remove cache folders whose process is gone. Best effort; returns the names removed. */
function sweepStale(tmp = os.tmpdir(), alive = pidAlive) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const pid = Number(name.slice(PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); removed.push(name); } catch { /* in use: next start */ }
  }
  return removed;
}

/** Apply the switches to `app` (before `ready`) and remove this process's folder when the app quits. */
function useOwnCaches(app, pid = process.pid, tmp = os.tmpdir()) {
  sweepStale(tmp);
  for (const [name, value] of cacheSwitches(pid, tmp)) app.commandLine.appendSwitch(name, value);
  app.once('will-quit', () => { try { fs.rmSync(cacheDirFor(pid, tmp), { recursive: true, force: true }); } catch { /* the sweep gets it */ } });
}

module.exports = { cacheDirFor, cacheSwitches, sweepStale, useOwnCaches, PREFIX };
