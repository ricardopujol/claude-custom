'use strict';
/**
 * What the host answers to `{type:'git-tree'}` (documentation/PLAN_GIT_TREE.md Task 8): git history
 * + the branch ledger brought up to date + open PRs -> host/git-tree.js's model.
 *
 *   - Requests while one is running SHARE it: the panel re-asks every 30s and on every reconnect,
 *     and two reads of 500MB of transcripts at once would both be wasted.
 *   - The ledger is loaded from disk once per host, updated on every request (only new bytes are
 *     read), and saved only when something new was read. It is given the history's worktrees, so a
 *     subagent's spend goes to the worktree its tool calls point at. One that can't be read right now is NOT
 *     replaced: it's asked for again next time (PR #84 Dexter F6).
 *   - gh is asked at most once a minute (it's the network), alongside the ledger, not after it.
 *   - The drawer's data (Enhancement #46) rides along: the GitHub repo of `origin` (and each branch's PR
 *     page), and each branch's review verdicts. Both are optional extras: a remote or a review
 *     reader that fails is "none", never a failed tree.
 *   - Nothing here throws to the caller: a failure is `{ ok: false, error }`, so the panel never
 *     waits forever (the `fog` lesson, host/host.js). A ledger failure still draws the tree from
 *     what was saved before, with `ledgerOk: false`.
 */

const fs = require('fs');
const path = require('path');
const { buildTree } = require('./git-tree');
const { totals, emptyLedger } = require('./branch-ledger');
const { lookDirState, ensureLookDir } = require('./style');
const { repoUrl, prUrl, remoteHost } = require('./pr-url');

const PR_TTL_MS = 60 * 1000;
const LEDGER_FILE = 'branch-ledger.json';

/**
 * <project>\.claude-custom\branch-ledger.json, beside the look and behind the same `*` .gitignore --
 * or null when .claude-custom is a link or junction to somewhere else: style.js refuses to write
 * through one (its Dexter F7), and so does the ledger (PR #84 Miguel B3). With no file, the tree
 * still counts every transcript; it just keeps the ledger in memory.
 */
function ledgerFileFor(stateRoot, fsImpl = fs) {
  if (lookDirState(stateRoot, fsImpl) === 'foreign') return null;
  return path.join(ensureLookDir(stateRoot, fsImpl), LEDGER_FILE);
}

/**
 * The worktrees of a history as the ledger wants them, `[{ root, branch }]` -- or null when the history
 * names none. A repo always has one, so "none" is a list that couldn't be had, and the ledger then leaves
 * subagent transcripts unread rather than credit them to the wrong branch for good (host/branch-ledger.js).
 */
function ledgerWorktrees(history) {
  const list = (Array.isArray(history && history.worktrees) ? history.worktrees : [])
    .filter(w => w && typeof w.path === 'string' && w.path !== '')
    .map(w => ({ root: path.resolve(w.path), branch: typeof w.branch === 'string' && w.branch !== '' ? w.branch : null }));
  return list.length > 0 ? list : null;
}

function createGitTreeService(d) {
  let ledger = null;
  let inFlight = null;
  let prs = { at: -Infinity, value: null };

  async function openPrs() {
    if (d.now() - prs.at < PR_TTL_MS) return prs.value;
    prs = { at: d.now(), value: await d.readOpenPrs(d.cwd) };
    return prs.value;
  }

  async function refreshLedger(worktrees) {
    const file = d.ledgerFile();
    if (!ledger) {
      if (file) {
        const loaded = await d.loadLedger(file);
        if (loaded.state === 'unreadable') throw new Error(`branch ledger ${file} can't be read right now`);
        ledger = loaded.ledger;
      } else {
        ledger = emptyLedger();
      }
    }
    const r = await d.updateLedger(ledger, { projectsDir: d.projectsDir, projectRoot: d.projectRoot, worktrees });
    ledger = r.ledger;
    if (file && r.read > 0) ledger = await d.saveLedger(file, ledger);
    return r.errors === 0;
  }

  // origin's GitHub repo, and its host whatever it is (PR #93 Dexter F9: present but unreadable is not absent)
  async function origin() {
    try {
      const raw = d.readRemote ? await d.readRemote(d.cwd) : null;
      return { repo: repoUrl(raw), host: remoteHost(raw) };
    } catch {
      return { repo: null, host: null };
    }
  }

  function reviewsOf(name) {
    try { return d.readReviews ? d.readReviews(name) || [] : []; } catch { return []; }
  }

  async function compute() {
    const history = await d.readHistory(d.cwd);
    if (!history.ok) return { ok: false, error: history.error };
    const [ledgerOk, openPrList, o] = await Promise.all([refreshLedger(ledgerWorktrees(history)).catch(() => false), openPrs(), origin()]);
    const repo = o.repo;
    const tree = buildTree({ history, totals: ledger ? totals(ledger) : {}, openPrs: openPrList,
      projectRoot: d.projectRoot, current: d.currentBranch(d.cwd) });
    try { if (d.readReviews && d.readReviews.refresh) d.readReviews.refresh(); } catch { /* the reader lists again next time */ }
    const branches = tree.branches.map(b => ({ ...b, prUrl: prUrl(repo, b.pr), reviews: reviewsOf(b.name) }));
    return { ...tree, branches, repoUrl: repo, originHost: o.host, ledgerOk, project: d.projectRoot };
  }

  function get() {
    if (!inFlight) {
      inFlight = compute()
        .catch(err => ({ ok: false, error: (err && err.message) || String(err) }))
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return { get };
}

module.exports = { createGitTreeService, ledgerFileFor, PR_TTL_MS };
