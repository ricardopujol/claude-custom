'use strict';
/**
 * Is a tab safe to close with no confirm? (Backlog #77: Ctrl+click on a tab.)
 *
 * Safe means ALL of: the branch is merged (the `claude-merged.json` marker), the folder has nothing
 * uncommitted, nothing unpushed, and no agent is working there. Anything unknown (a git error, a
 * missing number) is NOT safe: "couldn't tell" drawn as "0" would close a tab with work in it.
 *
 * The decision and its wording are pure; `readCloseFacts` is the only part that touches git, and it
 * takes its runner so a test never spawns one. NEVER fetches: it reads what the remote-tracking refs
 * already say, as host/branch-health.js does.
 */

const { execFile } = require('child_process');

const known = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Why a tab isn't safe to close without asking: an array of short phrases, [] when it is safe. */
function closeReasons(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const out = [];
  if (f.merged !== true) out.push('not merged');
  if (!known(f.dirtyCount)) out.push("couldn't check for uncommitted files");
  else if (f.dirtyCount > 0) out.push(plural(f.dirtyCount, 'uncommitted file', 'uncommitted files'));
  if (!known(f.unpushedCount)) out.push("couldn't check for unpushed commits");
  else if (f.unpushedCount > 0) out.push(plural(f.unpushedCount, 'unpushed commit', 'unpushed commits'));
  if (!known(f.agentsHere)) out.push("couldn't check for agents");
  else if (f.agentsHere === 1) out.push('an agent is working here');
  else if (f.agentsHere > 1) out.push(`${f.agentsHere} agents are working here`);
  return out;
}

/** True only when nothing is wrong and nothing is unknown. */
function isSafeToClose(facts) {
  return closeReasons(facts).length === 0;
}

/** The reasons as one line for the confirm's detail, or '' when safe. */
function closeReason(facts) {
  return closeReasons(facts).join('; ');
}

function defaultRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function countCommits(run, range, cwd) {
  let out;
  try { out = await run(['rev-list', '--count', range], cwd); } catch { return null; }
  const s = typeof out === 'string' ? out.trim() : '';
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * { dirtyCount, unpushedCount } for a worktree folder; null for a fact git couldn't give.
 * Unpushed = commits not on the branch's upstream, or, with no upstream, not on `origin/develop`.
 */
async function readCloseFacts(cwd, { run = defaultRun } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { dirtyCount: null, unpushedCount: null };
  let dirtyCount = null;
  try {
    const out = await run(['status', '--porcelain'], cwd);
    if (typeof out === 'string') dirtyCount = out.split(/\r?\n/).filter(l => l.length > 0).length;
  } catch { dirtyCount = null; }
  let unpushedCount = await countCommits(run, '@{upstream}..HEAD', cwd);
  if (unpushedCount === null) unpushedCount = await countCommits(run, 'origin/develop..HEAD', cwd);
  return { dirtyCount, unpushedCount };
}

module.exports = { isSafeToClose, closeReasons, closeReason, readCloseFacts };
