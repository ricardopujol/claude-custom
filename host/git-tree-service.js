'use strict';
/**
 * What the host answers to `{type:'gitTree'}` (documentation/PLAN_GIT_TREE.md Task 8): git history
 * + the branch ledger brought up to date + open PRs -> host/git-tree.js's model.
 *
 *   - Requests while one is running SHARE it: the panel re-asks every 30s and on every reconnect,
 *     and two reads of 500MB of transcripts at once would both be wasted.
 *   - The ledger is loaded from disk once per host, updated on every request (only new bytes are
 *     read), and saved only when something new was read.
 *   - gh is asked at most once a minute (it's the network).
 *   - Nothing here throws to the caller: a failure is `{ ok: false, error }`, so the panel never
 *     waits forever (the `fog` lesson, host/host.js). A ledger failure still draws the tree from
 *     what was saved before, with `ledgerOk: false`.
 */

const { buildTree } = require('./git-tree');
const { totals } = require('./branch-ledger');

const PR_TTL_MS = 60 * 1000;

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
    if (!ledger) ledger = (await d.loadLedger(d.ledgerFile())).ledger;
    const r = await d.updateLedger(ledger, { projectsDir: d.projectsDir, projectRoot: d.projectRoot });
    ledger = r.ledger;
    if (r.read > 0) ledger = await d.saveLedger(d.ledgerFile(), ledger);
    return r.errors === 0;
  }

  async function compute() {
    const history = await d.readHistory(d.cwd);
    if (!history.ok) return { ok: false, error: history.error };
    let ledgerOk;
    try {
      ledgerOk = await refreshLedger();
    } catch {
      ledgerOk = false;
    }
    const tree = buildTree({ history, totals: ledger ? totals(ledger) : {}, openPrs: await openPrs(),
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

module.exports = { createGitTreeService, PR_TTL_MS };
