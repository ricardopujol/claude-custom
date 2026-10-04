'use strict';
/**
 * `claude-custom <folder> --stop` (Windowless sessions PR 3): stop every
 * session serving a folder, so the folder can be removed. Its first caller is
 * the worktree scripts' removal (`/merged`, the sweep, the SessionEnd reaper);
 * the ▾ menu's *Stop all in this project* shares the loop (`stopRows`).
 *
 *   serves(row, folder)    -> the session uses the folder: it works there (or
 *                             inside it), or its build lives there (Dexter F2)
 *   inFolder(p, folder)    -> p is the folder or inside it, also through a
 *                             junction, symlink or short name (Dexter F4)
 *   stopRows(rows, stopHost)            -> [{ row, outcome, text, how, reason }]
 *   stopFolder({ folder }, { list, stopHost }) -> { folder, results, verified, kept, late }
 *   stopExitCode(report)   -> 0 nothing is left serving it | 3 something may be
 *   stopReportLines(report) -> lines for the console
 *
 * Every stop is host/stop-holder.js stopHost on a host/background-hosts.js row,
 * so PR 1's rules hold unchanged: never a session with a window open, never a
 * pid that isn't proven, and "stopped" means its claude ended too (Dexter F1).
 * Sessions are stopped ONE AT A TIME: each waits for its claude to end, and two
 * powershell.exe at once only slow each other down.
 *
 * Exit 0 is a promise that nothing claude-custom knows of still serves the
 * folder. So the list is read again after stopping, until a pass finds nothing
 * new (Dexter F5: one can start meanwhile), and a doubt that could be about this
 * folder -- an identity it couldn't read, a start time it couldn't -- is never
 * waved through. A doubt about another folder is: one stale file elsewhere must
 * not block every removal on the machine (found by the real-host probe).
 */

const fs = require('fs');
const { samePath, isInside } = require('./project-layout');

const ENDED = new Set(['stopped', 'gone']);
const MAX_PASSES = 3;

const under = (p, folder) => samePath(p, folder) || isInside(p, folder);
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

function inFolder(p, folder) {
  if (typeof p !== 'string' || !p || typeof folder !== 'string' || !folder) return false;
  return under(p, folder) || under(real(p), real(folder));
}

function serves(row, folder) {
  return Boolean(row) && (inFolder(row.cwd, folder) || inFolder(row.install, folder));
}

const failedText = err => `Couldn't stop that session: ${String((err && err.message) || err).replace(/\.+$/, '')}.`;

async function stopRows(rows, stopHost) {
  const results = [];
  for (const row of rows) {
    let r;
    try { r = await stopHost(row); } catch (err) { r = { outcome: 'failed', text: failedText(err) }; }
    results.push({ row, outcome: r.outcome, text: r.text, how: r.how || null, reason: r.reason || null });
  }
  return results;
}

// The doubts that could be about this folder (null: "could be anything", when
// the list didn't say). A doubt with no folder (a file or an install it
// couldn't read) could be about any.
function doubtsAbout(list, folder) {
  if (!list) return null;
  if (list.verified === true) return [];
  if (!Array.isArray(list.doubts)) return null;
  return list.doubts.filter(d => !(d && typeof d.cwd === 'string' && typeof d.install === 'string' && !serves(d, folder)));
}

const keyOf = r => `${r.pid}:${r.processStartedAt}`;

async function stopFolder({ folder }, deps) {
  const attempted = new Set();
  const results = [];
  let list = null;
  let late = 0;
  for (let pass = 0; ; pass += 1) {
    try { list = await deps.list(); } catch { list = null; }
    const rows = list && Array.isArray(list.rows) ? list.rows : [];
    const fresh = rows.filter(r => serves(r, folder) && !attempted.has(keyOf(r)));
    if (fresh.length === 0) break;
    if (pass === MAX_PASSES) { late = fresh.length; break; }
    for (const r of fresh) attempted.add(keyOf(r));
    results.push(...await stopRows(fresh, deps.stopHost));
  }
  const kept = results.filter(r => !ENDED.has(r.outcome)).length;
  const doubts = doubtsAbout(list, folder);
  // The files to look at, so "couldn't check" can be cleared (Dexter R2-2).
  const unsureFiles = (doubts || []).map(d => d && d.file).filter(f => typeof f === 'string');
  return { folder, results, verified: doubts !== null && doubts.length === 0, kept, late, unsureFiles };
}

const stopExitCode = rep => (rep.kept > 0 || rep.late > 0 || !rep.verified ? 3 : 0);

function stopReportLines(rep) {
  const lines = rep.results.map(({ row, outcome, text }) =>
    `${ENDED.has(outcome) ? outcome : 'kept'}: ${row.cwd} (build ${row.build}, pid ${row.pid}) -- ${text}`);
  const files = Array.isArray(rep.unsureFiles) && rep.unsureFiles.length ? ` Couldn't use: ${rep.unsureFiles.join(', ')}.` : '';
  const unsure = `Not every session could be checked (an identity or a start time could not be read), so the folder may still be in use.${files}`;
  if (lines.length === 0) {
    lines.push(rep.verified ? `no claude-custom session is serving ${rep.folder}`
      : `No claude-custom session was found serving ${rep.folder}, but ${unsure.charAt(0).toLowerCase()}${unsure.slice(1)}`);
    return lines;
  }
  if (rep.late > 0) lines.push(`Sessions kept starting for ${rep.folder} while others were being stopped (${rep.late} not stopped); run it again.`);
  if (!rep.verified) lines.push(unsure);
  return lines;
}

module.exports = { serves, inFolder, stopRows, stopFolder, stopExitCode, stopReportLines, ENDED };
