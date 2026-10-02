'use strict';
/**
 * PROBE: the git tree's data for THIS repo, end to end (documentation/PLAN_GIT_TREE.md Task 8).
 *
 * Runs host/git-tree-service.js exactly as the host wires it -- real git, real gh, every real
 * claude-custom transcript -- but with the ledger in a temp file, so the project's own ledger is
 * never touched. Then checks facts known from the repo's history.
 *
 *   node verify/probe-git-tree-data.js            (from a worktree of claude-custom)
 *
 * Facts it checks were true on 2026-10-01; if the repo moves on, a check names what it saw.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readHistory } = require('../host/git-history');
const { loadLedger, updateLedger, saveLedger } = require('../host/branch-ledger');
const { readOpenPrs } = require('../host/open-prs');
const { currentBranch } = require('../host/git-branch');
const { projectOf } = require('../host/project-layout');
const { createGitTreeService } = require('../host/git-tree-service');

const cwd = path.resolve(__dirname, '..');
const project = projectOf(cwd);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-git-tree-'));
const ledgerFile = path.join(tmp, 'branch-ledger.json');

const checks = [];
const check = (ok, what, saw) => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  (saw: ${saw})`}`); };

(async () => {
  try {
    const service = createGitTreeService({
      cwd, projectRoot: project.root, projectsDir: path.join(os.homedir(), '.claude', 'projects'),
      ledgerFile: () => ledgerFile,
      readHistory, loadLedger, updateLedger, saveLedger, readOpenPrs, currentBranch, now: Date.now,
    });
    let t = Date.now();
    const tree = await service.get();
    const cold = Date.now() - t;
    t = Date.now();
    const again = await service.get();
    const warm = Date.now() - t;

    const by = n => tree.branches.find(b => b.name === n);
    const count = s => tree.branches.filter(b => b.state === s).length;
    console.log(`project ${project.root} · integration ${tree.integration} · current ${tree.current}`);
    console.log(`${tree.branches.length} branches: ${count('merged')} merged, ${count('open')} open, ${count('unmerged')} unmerged, ${count('deleted')} deleted`);
    console.log(`total ${tree.totalSpend.toLocaleString()} tokens · hub ${tree.hub.spend && tree.hub.spend.toLocaleString()} · cold ${cold}ms · warm ${warm}ms`);

    check(tree.ok === true, 'the tree is ok', tree.error);
    check(tree.ledgerOk === true, 'every transcript was read', tree.ledgerOk);
    check(count('merged') >= 74, 'at least 74 merged branches', count('merged'));
    check(new Set(tree.branches.map(b => b.name)).size === tree.branches.length, 'no branch twice');
    check(!tree.branches.some(b => /^(develop|main|HEAD)$|^worktree-agent-/.test(b.name)), 'no hub, HEAD or scratch spokes');
    const dnd = by('try/drag-drop');
    check(dnd && dnd.state === 'deleted' && dnd.spend > 1e6, 'try/drag-drop is deleted with ~2M tokens', dnd && `${dnd.state} ${dnd.spend}`);
    const ptf = by('feat/process-tracker-failure');
    check(ptf && ptf.spend >= 1053635, "process-tracker-failure counts its old worktree's loose spend", ptf && ptf.spend);
    const ldz = by('feat/layout-dock-zones');
    // its worktree outlived the merge while an old test window held it, so either is the truth
    check(ldz && ['worktree', 'had-worktree'].includes(ldz.place) && ldz.pr === 82,
      'layout-dock-zones: PR 82, worked on in its own worktree', ldz && `${ldz.place} ${ldz.pr}`);
    check(ldz && ldz.why === 'Dock zones, panels that fill, focus mode (layout pass L1)', "layout-dock-zones' why is its PR title", ldz && ldz.why);
    const me = by('feat/git-tree');
    check(me && me.place === 'worktree' && me.state !== 'merged', 'feat/git-tree is a live worktree', me && `${me.state} ${me.place}`);
    const unknown = tree.branches.filter(b => b.state === 'merged' && b.spend === null).length;
    check(unknown > 0 && unknown < 25, 'some merged branches have no token record (null, not 0)', unknown);
    check(!tree.branches.some(b => b.spend === 0 && b.state === 'merged' && b.pr), 'no merged PR shows a spend of exactly 0');
    check(tree.branches.every(b => b.why === null || b.why.replace(/…$/, '').split(/\s+/).length <= 15), 'every why is 15 words or fewer');
    check(warm < 1500, 'a warm read is quick', `${warm}ms`);
    check(JSON.stringify(again.branches.map(b => [b.name, b.spend])) === JSON.stringify(tree.branches.map(b => [b.name, b.spend]))
      || again.branches.length === tree.branches.length, 'a second read gives the same tree (live sessions may add spend)');
    const saved = await loadLedger(ledgerFile);
    check(!saved.corrupt && Object.keys(saved.ledger.files).length > 300, 'the ledger was saved', Object.keys(saved.ledger.files).length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = checks.filter(c => !c).length;
  console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
})();
