'use strict';
/**
 * `claude-custom <folder> --stop` (Windowless sessions PR 3): stop every
 * session serving a folder, so the folder can be removed. Its first caller is
 * the worktree scripts' removal (`/merged`, the sweep, the SessionEnd reaper);
 * the ▾ menu's *Stop all in this project* uses `serves` too.
 *
 *   serves(row, folder)                     -> the row's session works in folder, or inside it
 *   stopFolder({ folder }, { list, stopHost }) -> { folder, results, verified, kept }
 *   stopExitCode(report)                    -> 0 nothing is left serving it | 3 something may be
 *   stopReportLines(report)                 -> one line per session, for the console
 *
 * Every stop is host/stop-holder.js stopHost on a host/background-hosts.js row,
 * so PR 1's rules hold unchanged: never a session with a window open, never a
 * pid that isn't proven. Sessions are stopped ONE AT A TIME: each waits for its
 * claude to end, and two powershell.exe at once only slow each other down.
 *
 * Exit 0 is a promise that nothing claude-custom knows of still serves the
 * folder, so it is never given on a list that couldn't check every session.
 */

const { samePath, isInside } = require('./project-layout');

const ENDED = new Set(['stopped', 'gone']);

function serves(row, folder) {
  return Boolean(row) && (samePath(row.cwd, folder) || isInside(row.cwd, folder));
}

async function stopFolder({ folder }, deps) {
  let list;
  try { list = await deps.list(); } catch { list = null; }
  // Only a doubt that could be about THIS folder makes it unsure: one stale
  // identity elsewhere, whose pid Windows reused for a process with an
  // unreadable start time, must not block every removal on the machine (found
  // by the real-host probe). A doubt with no folder could be about any.
  const doubtsHere = list && Array.isArray(list.doubts)
    ? list.doubts.filter(d => !d || typeof d.cwd !== 'string' || serves({ cwd: d.cwd }, folder))
    : null;
  const verified = Boolean(list && (list.verified === true || (doubtsHere !== null && doubtsHere.length === 0)));
  const rows = list && Array.isArray(list.rows) ? list.rows : [];
  const results = [];
  for (const row of rows.filter(r => serves(r, folder))) {
    let r;
    try {
      r = await deps.stopHost(row);
    } catch (err) {
      r = { outcome: 'failed', text: `Couldn't stop that session: ${err && err.message}.` };
    }
    results.push({ row, outcome: r.outcome, text: r.text });
  }
  const kept = results.filter(r => !ENDED.has(r.outcome)).length;
  return { folder, results, verified, kept };
}

const stopExitCode = rep => (rep.kept > 0 || !rep.verified ? 3 : 0);

function stopReportLines(rep) {
  const lines = rep.results.map(({ row, outcome, text }) =>
    `${ENDED.has(outcome) ? outcome : 'kept'}: ${row.cwd} (build ${row.build}, pid ${row.pid}) -- ${text}`);
  if (lines.length === 0) lines.push(`no claude-custom session is serving ${rep.folder}`);
  if (!rep.verified) lines.push("Couldn't check every session (the OS couldn't be asked), so the folder may still be in use.");
  return lines;
}

module.exports = { serves, stopFolder, stopExitCode, stopReportLines, ENDED };
