'use strict';
/**
 * The git reads behind "docs drift" (BACKLOG #39 job 2). Read-only: rev-parse, merge-base, log and diff, nothing that writes.
 *
 *   createDriftGit({ cwd, branch, run, execFileImpl, timeoutMs }) ->
 *     head()                          -> sha of the branch tip | null (no such branch, or not a repository)
 *     merges(from, to, { limit })     -> [{ sha, subject }] first-parent merges INTO the branch in from..to, oldest first, the newest
 *                                        `limit`; null when `from` is not an ancestor of `to` (the branch was rewound)
 *     diff(sha)                       -> what the merge brought in, against its first parent (text, cut at MAX_DIFF_BYTES)
 *
 * `run(args, { truncateOk })` is the seam: a promise of git's stdout, rejecting with an Error that carries what the process
 * said (`code`: the exit status, or a string like 'ENOENT'; `killed`; `signal`; `stdout`).
 *
 * AN ANSWER IS NOT AN ERROR (PR #153 Miguel B1, Dexter 9). Only git's own exit status answers a question: `rev-parse --verify
 * --quiet` exits 1 for "no such branch", `merge-base --is-ancestor` exits 1 for "no". A timeout (killed, signal SIGTERM, a
 * message that is just "Command failed"), a missing git, a full buffer or any other exit is an INFRASTRUCTURE failure and is
 * thrown: the caller keeps its mark and tries again later. The old code read the message text, and a timeout's message names
 * nothing, so it became "no develop branch" or "develop was rewound" and skipped merges for good.
 *
 * ONLY MERGES INTO THE BRANCH. A merge whose second parent is already in the history the mark covers ("Merge origin/develop
 * into feat/x", fast-forwarded into develop) did not bring a change in: it is skipped. (The change a fast-forwarded branch
 * brought is therefore not read as a unit: a known limit, a PR merged with `--merge` is read.)
 *
 * A commit id is checked to be hex before it reaches git, so nothing from outside can become an option.
 */

const { execFile } = require('child_process');
const { EXCLUDE_PATHSPECS } = require('./drift-text');

const SHA = /^[0-9a-f]{7,40}$/i;
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;
// A diff is only ever read for its first ~9 KB, so a merge that adds a 9 MB fixture is cut here, not failed.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 3;

function defaultRun(cwd, { execFileImpl = execFile, timeoutMs = TIMEOUT_MS } = {}) {
  return (args, { truncateOk = false } = {}) => new Promise((resolve, reject) => {
    const maxBuffer = truncateOk ? MAX_DIFF_BYTES : MAX_BUFFER;
    execFileImpl('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer },
      (err, out, errOut) => {
        if (!err) return resolve(out);
        if (truncateOk && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof out === 'string' && out !== '') return resolve(out);
        const e = new Error((errOut && String(errOut).trim()) || err.message);
        e.code = err.code;
        e.killed = err.killed === true;
        e.signal = err.signal || null;
        e.stdout = out;
        reject(e);
      });
  });
}

/** Did the process not get to answer (killed, signalled, could not start, buffer full)? Anything but a plain exit status. */
function isInfraError(err) {
  return !err || err.killed === true || (typeof err.signal === 'string' && err.signal !== '') || typeof err.code !== 'number';
}

const exitedWith = (err, code) => !isInfraError(err) && err.code === code;

function checked(sha) {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('not a commit id');
  return sha;
}

function createDriftGit({ cwd, branch = 'develop', execFileImpl, timeoutMs, run = defaultRun(cwd, { execFileImpl, timeoutMs }) } = {}) {
  async function head() {
    let out;
    try {
      out = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch (err) {
      if (exitedWith(err, 1)) return null;                                                   // no such branch
      if (exitedWith(err, 128) && /not a git repository/i.test(String(err.message))) return null;   // nothing to watch here
      throw err;
    }
    const sha = out.trim();
    return SHA.test(sha) ? sha : null;
  }

  /** Is `a` an ancestor of `b`? true | false; anything else throws. */
  async function isAncestor(a, b) {
    try {
      await run(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch (err) {
      if (exitedWith(err, 1)) return false;
      throw err;
    }
  }

  /** Is this commit absent from the repository? true | false; a failure to ask throws. */
  async function isMissing(sha) {
    try {
      await run(['cat-file', '-e', `${sha}^{commit}`]);
      return false;
    } catch (err) {
      if (isInfraError(err)) throw err;
      return true;
    }
  }

  async function merges(from, to, { limit = DEFAULT_LIMIT } = {}) {
    checked(from);
    checked(to);
    if (from === to) return [];
    try {
      if (!(await isAncestor(from, to))) return null;
    } catch (err) {
      // exit 128 for a mark git no longer has (pruned, a re-clone) is an answer about the MARK: follow develop, as for a rewind
      if (exitedWith(err, 128) && await isMissing(from)) return null;
      throw err;
    }
    const out = await run(['log', '--first-parent', '--merges', '--format=%H%x09%P%x09%s', `${from}..${to}`]);   // newest first
    const kept = [];
    for (const l of out.split('\n')) {
      if (kept.length >= Math.max(0, limit)) break;
      const [sha, parents, ...rest] = l.split('\t');
      if (!sha || !SHA.test(sha)) continue;
      const second = (parents || '').split(' ')[1];
      if (!second || !SHA.test(second)) continue;
      if (await isAncestor(second, from)) continue;                      // develop merged into a branch: not a change brought in
      kept.push({ sha, subject: rest.join('\t') });
    }
    return kept.reverse();
  }

  async function diff(sha) {
    checked(sha);
    return run(['diff', '--no-color', '--no-ext-diff', '-U2', `${sha}^1`, sha, '--', '.', ...EXCLUDE_PATHSPECS], { truncateOk: true });
  }

  return { head, merges, diff };
}

module.exports = { createDriftGit, isInfraError, MAX_DIFF_BYTES, TIMEOUT_MS };
