'use strict';
/**
 * Is a tab safe to close with no confirm? (Backlog #77: Ctrl+click on a tab.)
 *
 * Safe means ALL of: the branch is merged (the `claude-merged.json` marker AND the checked-out commit is on
 * `origin/develop`), nothing uncommitted, nothing unpushed, no agent working in the folder, and the tab's own
 * session is at rest. Anything unknown (a git error, a timeout, an occupancy reader that couldn't say) is NOT
 * safe: "couldn't tell" drawn as "0" would end a session with work in it.
 *
 * The decision and its wording are pure; `readCloseFacts` is the only part that touches git, and it takes its
 * runner so a test never spawns one. It NEVER fetches (it reads what the remote-tracking refs already say, as
 * host/branch-health.js does) and never takes an optional lock (GIT_OPTIONAL_LOCKS=0), so reading can't make a
 * commit in that worktree fail.
 */

const { execFile } = require('child_process');

// Ctrl+click must feel instant, and a slow answer is "unknown", which asks. Three of these run side by side.
const GIT_TIMEOUT_MS = 3000;

const known = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Why a tab isn't safe to close without asking: an array of short phrases, [] when it is safe. */
function closeReasons(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const out = [];
  if (f.merged === false) out.push('not merged');
  else if (f.merged !== true) out.push("couldn't check whether it's merged");
  if (!known(f.dirtyCount)) out.push("couldn't check for uncommitted files");
  else if (f.dirtyCount > 0) out.push(plural(f.dirtyCount, 'uncommitted file', 'uncommitted files'));
  if (!known(f.unpushedCount)) out.push("couldn't check for unpushed commits");
  else if (f.unpushedCount > 0) out.push(plural(f.unpushedCount, 'unpushed commit', 'unpushed commits'));
  if (!known(f.agentsHere)) out.push("couldn't check for agents");
  else if (f.agentsHere === 1) out.push('an agent is working here');
  else if (f.agentsHere > 1) out.push(`${f.agentsHere} agents are working here`);
  // The tab's OWN session (and the agents it launched, which its `working` covers) is what a stop actually ends.
  if (f.session === 'busy') out.push('Claude is still working in this tab');
  else if (f.session === 'waiting') out.push('Claude is waiting for you in this tab');
  else if (f.session !== 'idle') out.push("couldn't check what Claude is doing in this tab");
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

/** The git runner: argv in a folder, stdout out; rejects on failure or timeout (the error keeps git's exit `code`). */
function makeRun({ exec = execFile, timeout = GIT_TIMEOUT_MS } = {}) {
  return (args, cwd) => new Promise((resolve, reject) => {
    exec('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, timeout,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
const defaultRun = makeRun();

async function countCommits(run, range, cwd) {
  let out;
  try { out = await run(['rev-list', '--count', range], cwd); } catch { return null; }
  const s = typeof out === 'string' ? out.trim() : '';
  return /^\d+$/.test(s) ? Number(s) : null;
}

// Config can narrow what `status` shows (status.showUntrackedFiles=no, submodule ignore): ask for everything.
const STATUS_ARGS = ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'];

async function dirtyOf(run, cwd) {
  try {
    const out = await run(STATUS_ARGS, cwd);
    return typeof out === 'string' ? out.split(/\r?\n/).filter(l => l.length > 0).length : null;
  } catch { return null; }
}

/** The branch HEAD is on, or null (detached, or git can't say). */
async function branchOf(run, cwd) {
  try {
    const out = await run(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
    const b = typeof out === 'string' ? out.trim() : '';
    return b === '' ? null : b;
  } catch { return null; }
}

// Unpushed = the BRANCH's commits not on its upstream, or, with no upstream, not on `origin/develop`. (That
// fallback is sound only because the merged marker is also required: a merged branch's commits are on develop.)
async function unpushedOf(run, branch, cwd) {
  if (branch === null) return null;
  const ref = `refs/heads/${branch}`;
  const viaUpstream = await countCommits(run, `${branch}@{upstream}..${ref}`, cwd);
  return viaUpstream !== null ? viaUpstream : countCommits(run, `origin/develop..${ref}`, cwd);
}

/** true / false when HEAD is / isn't on origin/develop; null when git can't say (exit 1 is the only "no"). */
async function headInDevelop(run, cwd) {
  try {
    await run(['merge-base', '--is-ancestor', 'HEAD', 'origin/develop'], cwd);
    return true;
  } catch (err) {
    return err && err.code === 1 ? false : null;
  }
}

/**
 * { branch, dirtyCount, unpushedCount, headInDevelop } for a worktree folder; null for a fact git couldn't give.
 * The reads run side by side, each bounded by GIT_TIMEOUT_MS.
 */
async function readCloseFacts(cwd, { run = defaultRun } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { branch: null, dirtyCount: null, unpushedCount: null, headInDevelop: null };
  const [dirtyCount, branchAndPushed, inDevelop] = await Promise.all([
    dirtyOf(run, cwd),
    branchOf(run, cwd).then(async branch => ({ branch, unpushedCount: await unpushedOf(run, branch, cwd) })),
    headInDevelop(run, cwd),
  ]);
  return { branch: branchAndPushed.branch, dirtyCount, unpushedCount: branchAndPushed.unpushedCount, headInDevelop: inDevelop };
}

module.exports = { isSafeToClose, closeReasons, closeReason, readCloseFacts, makeRun, GIT_TIMEOUT_MS, STATUS_ARGS };
