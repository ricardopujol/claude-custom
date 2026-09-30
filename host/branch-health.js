'use strict';
/**
 * Branch health (Extension X4, documentation/PLAN_WORKTREE_TABS.md): how far a
 * worktree's branch has fallen behind develop, and -- for the dev tab -- how
 * far develop has run ahead of main (what the next release would carry).
 *
 * Counted against the remote-tracking refs `origin/develop` and `origin/main`,
 * not local branches: in this layout local `main` is almost never updated,
 * while any fetch (the CLI's, a `git pull`, `/merged`) moves the remote ones.
 * NEVER fetches itself -- a marker must not reach the network on a timer.
 *
 * Needs the `git` binary (as host/worktree-list.js does); counting commits
 * isn't something git's files answer. Anything short of a clean count is null,
 * never 0: "unknown" drawn as "up to date" is the absence-as-zero bug.
 */

const path = require('path');
const { execFile } = require('child_process');
const { projectOf, samePath, isInside } = require('./project-layout');
const { currentBranch } = require('./git-branch');

function defaultRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function count(run, range, cwd) {
  let out;
  try {
    out = await run(['rev-list', '--count', range], cwd);
  } catch {
    return null;
  }
  const s = typeof out === 'string' ? out.trim() : '';
  return /^\d+$/.test(s) ? Number(s) : null;
}

// dev-style: the container's `dev` (or anything inside it), or a flat repo
// sitting on develop.
function isDevStyle(cwd, project) {
  if (project.kind === 'container') return samePath(cwd, project.dev) || isInside(cwd, project.dev);
  return currentBranch(cwd) === 'develop';
}

/**
 * { kind: 'dev', developAheadOfMain } | { kind: 'tab', behindDevelop } | null
 * (null: not a repo). opts: { run } -- (args, cwd) => Promise<stdout>.
 */
async function branchHealth(cwd, { run = defaultRun } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const dir = path.resolve(cwd);
  const project = projectOf(dir);
  // The container itself is no worktree -- git would have nowhere to run.
  if (!project || (project.kind === 'container' && samePath(dir, project.root))) return null;
  if (isDevStyle(dir, project)) {
    return { kind: 'dev', developAheadOfMain: await count(run, 'origin/main..origin/develop', cwd) };
  }
  return { kind: 'tab', behindDevelop: await count(run, 'HEAD..origin/develop', cwd) };
}

module.exports = { branchHealth };
