'use strict';
/**
 * What the host answers to `{type:'git-tree'}` (documentation/PLAN_GIT_TREE.md Task 8): git history
 * + the branch ledger brought up to date + open PRs -> host/git-tree.js's model.
 *
 *   - Requests while one is running SHARE it: the panel re-asks every 30s and on every reconnect,
 *     and two reads of 500MB of transcripts at once would both be wasted.
 *   - The ledger is loaded from disk once per host, updated on every request (only new bytes are
 *     read), and saved only when something new was read. One that can't be read right now is NOT
 *     replaced: it's asked for again next time (PR #84 Dexter F6).
 *   - gh is asked at most once a minute (it's the network), alongside the ledger, not after it.
 *   - Nothing here throws to the caller: a failure is `{ ok: false, error }`, so the panel never
 *     waits forever (the `fog` lesson, host/host.js). A ledger failure still draws the tree from
 *     what was saved before, with `ledgerOk: false`.
 */

const fs = require('fs');
const path = require('path');
const { buildTree } = require('./git-tree');
const { totals, emptyLedger } = require('./branch-ledger');
const { lookDirState, ensureLookDir } = require('./style');

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

function createGitTreeService(d) {
  let ledger = null;
  let inFlight = null;
  let prs = { at: -Infinity, value: null };

  async function openPrs() {
    if (d.now() - prs.at < PR_TTL_MS) return prs.value;
    prs = { at: d.now(), value: await d.readOpenPrs(d.cwd) };
    return prs.value;
  }

  async function refreshLedger() {
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
    const r = await d.updateLedger(ledger, { projectsDir: d.projectsDir, projectRoot: d.projectRoot });
    ledger = r.ledger;
    if (file && r.read > 0) ledger = await d.saveLedger(file, ledger);
    return r.errors === 0;
  }

  async function compute() {
    const history = await d.readHistory(d.cwd);
    if (!history.ok) return { ok: false, error: history.error };
    const [ledgerOk, openPrList] = await Promise.all([refreshLedger().catch(() => false), openPrs()]);
    const tree = buildTree({ history, totals: ledger ? totals(ledger) : {}, openPrs: openPrList,
      projectRoot: d.projectRoot, current: d.currentBranch(d.cwd) });
    return { ...tree, ledgerOk };
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
