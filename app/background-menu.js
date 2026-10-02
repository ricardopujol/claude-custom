'use strict';
/**
 * What the strip's ▾ menu shows for host/background-hosts.js's list
 * (Windowless sessions PR 2). Pure: main builds the native menu from it.
 *
 *   menuModel({ rows, verified }, { now, tabsByPort, projectRoot }) -> { items, footer, stopAll }
 *   items: { label, open, stop, row }
 *     open  { kind: 'select-tab', key }   the host is a tab in this window
 *           { kind: 'window', port, cwd } a window of its own, on its exact port
 *           null                          another build's host (Ricardo, 2026-09-30:
 *                                         Open only for this build's own sessions)
 *     stop  offered unless the host has a window (host/stop-holder.js stopHost
 *           refuses one anyway; a count it couldn't take is left to it to ask)
 *   stopAll { rows, enabled } with a `projectRoot`, else null: the rows offered
 *           Stop that serve that project (PR 3, *Stop all in this project*)
 *
 * Main-process only (required, never a page <script>).
 */

const path = require('path');
const { inFolder } = require('../host/stop-folder');

const UNVERIFIED = "Couldn't check every session; some may be missing.";

function ageText(startedAt, now) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 'age unknown';
  const min = Math.floor((now - startedAt) / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

function windowsText(n) {
  if (n === null || n === undefined) return 'windows unknown';
  if (n === 0) return 'no window';
  return n === 1 ? '1 window' : `${n} windows`;
}

// The last two parts of the folder: enough to tell `dev` of one project from another's.
function folderText(cwd) {
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return path.win32.normalize(String(cwd));
  return parts.slice(1).slice(-2).join('\\');
}

// *Stop all in this project* (Windowless sessions PR 3): every session the menu
// offers Stop on whose folder is this window's project root or inside it. Read
// from the row's cwd, never the disk: a merged worktree's folder may be gone.
function stopAllOf(items, projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) return null;
  // Its folder, not its build: a claude-custom window's root holds every build,
  // and a build's sessions work in other projects.
  const rows = items.filter(it => it.stop && inFolder(it.row.cwd, projectRoot)).map(it => it.row);
  return { rows, enabled: rows.length > 0 };
}

function menuModel(list, { now, tabsByPort = new Map(), projectRoot = null } = {}) {
  const rows = list && Array.isArray(list.rows) ? list.rows : [];
  const verified = Boolean(list && list.verified === true);
  const items = rows.map((row) => {
    const tabKey = row.own ? tabsByPort.get(row.port) : undefined;
    const here = tabKey !== undefined;
    const where = here ? 'open here' : windowsText(row.windows);
    let open = null;
    if (here) open = { kind: 'select-tab', key: tabKey };
    else if (row.own) open = { kind: 'window', port: row.port, cwd: row.cwd };
    return {
      label: [folderText(row.cwd), row.build, ageText(row.startedAt, now), where].join('  ·  '),
      open,
      stop: !here && !(Number.isInteger(row.windows) && row.windows > 0),
      row,
    };
  });
  let footer = null;
  if (!verified) footer = UNVERIFIED;
  // Scoped as the list is (Miguel Y4): this build and the builds beside it.
  else if (items.length === 0) footer = 'No sessions running in this build or the ones beside it.';
  return { items, footer, stopAll: stopAllOf(items, projectRoot) };
}

module.exports = { menuModel, ageText, windowsText, folderText };
