'use strict';
/**
 * The git reads behind "docs drift" (BACKLOG #39 job 2). Read-only: rev-parse, rev-list, show and diff, nothing that writes.
 *
 *   createDriftGit({ cwd, branch, run }) ->
 *     head()                          -> sha of the branch tip | null (no such branch)
 *     merges(from, to, { limit })     -> [{ sha, subject }] first-parent merge commits in from..to, oldest first, the newest
 *                                        `limit`; null when `from` is not an ancestor of `to` (the branch was rewound)
 *     diff(sha)                       -> what the merge brought in, against its first parent (text)
 *
 * `run(args)` is the seam: a promise of git's stdout, rejecting with git's message. A commit id is checked to be hex before
 * it reaches git, so nothing from outside can become an option.
 */

const { execFile } = require('child_process');

const SHA = /^[0-9a-f]{7,40}$/i;
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 3;

function defaultRun(cwd) {
  return (args) => new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, out, errOut) => (err ? reject(new Error((errOut && String(errOut).trim()) || err.message)) : resolve(out)));
  });
}

function checked(sha) {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('not a commit id');
  return sha;
}

function createDriftGit({ cwd, branch = 'develop', run = defaultRun(cwd) } = {}) {
  async function head() {
    let out;
    try {
      out = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch (err) {
      // `--quiet --verify` exits 1 with no message when the ref is simply not there; anything with a message is a real failure
      // (a folder that is not a repository has no develop branch to watch either)
      if (/not installed|ENOENT|spawn|timed out/i.test(String((err && err.message) || err))) throw err;
      return null;
    }
    const sha = out.trim();
    return SHA.test(sha) ? sha : null;
  }

  async function merges(from, to, { limit = DEFAULT_LIMIT } = {}) {
    checked(from);
    checked(to);
    if (from === to) return [];
    try {
      await run(['merge-base', '--is-ancestor', from, to]);
    } catch (err) {
      if (/not installed|ENOENT|spawn|timed out/i.test(String((err && err.message) || err))) throw err;
      return null;
    }
    const out = await run(['log', '--first-parent', '--merges', '--reverse', '--format=%H%x09%s', `${from}..${to}`]);
    const rows = out.split('\n').filter(Boolean).map((l) => {
      const tab = l.indexOf('\t');
      return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    }).filter(r => SHA.test(r.sha));
    return rows.slice(Math.max(0, rows.length - Math.max(0, limit)));
  }

  async function diff(sha) {
    checked(sha);
    return run(['diff', '--no-color', '--no-ext-diff', '-U2', `${sha}^1`, sha]);
  }

  return { head, merges, diff };
}

module.exports = { createDriftGit };
