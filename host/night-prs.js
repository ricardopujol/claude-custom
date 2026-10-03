'use strict';
/**
 * "PRs so far" for the bedtime chip (backlog #52, documentation/DESIGN_TERMINAL_BAR.md): how many PRs the
 * person opened since the night started, from `gh pr list --author @me --search created:>=<start>`, asked in
 * the project folder and refreshed on each wake by the host.
 *
 * OPTIONAL, like host/open-prs.js. gh may be missing, logged out, offline or slow; every failure is null,
 * meaning UNKNOWN, drawn "PRs: ?". Never 0: "I couldn't ask" and "none yet" are different facts, and a zero
 * for the first would say a night produced nothing.
 */

const { execFile } = require('child_process');

// How many PRs one query returns at most. A count that reaches it is a FLOOR, not the number (PR #99 Miguel G2).
const PR_LIMIT = 200;

function defaultRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000 },
      (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** gh's JSON list -> how many PRs it names, or null when it isn't a list. */
function parseCount(text) {
  if (typeof text !== 'string') return null;
  let list;
  try { list = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(list)) return null;
  return list.filter(p => p && typeof p === 'object' && Number.isInteger(p.number)).length;
}

/** The gh arguments for "mine, created at or after `sinceMs`", or null when there is no real start time. */
function nightPrArgs(sinceMs) {
  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || sinceMs <= 0) return null;
  const iso = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return ['pr', 'list', '--author', '@me', '--state', 'all', '--search', `created:>=${iso}`, '--json', 'number', '--limit', String(PR_LIMIT)];
}

async function countNightPrs(cwd, sinceMs, { run = defaultRun } = {}) {
  const args = nightPrArgs(sinceMs);
  if (args === null) return null;
  try {
    return parseCount(await run(args, cwd));
  } catch {
    return null;
  }
}

module.exports = { countNightPrs, parseCount, nightPrArgs, PR_LIMIT };
