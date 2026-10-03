'use strict';
/**
 * The Git drawer's actions (documentation/DESIGN_GIT_TREE.md, "Enhancement #46"). Pure:
 *
 *   actionsFor(branch, { prsKnown, repoUrl, tab }) -> [{ id, label, enabled, why }]
 *
 * `branch` is a model entry (host/git-tree.js: state, pr, prUrl, place, folder). `tab` is what the shell
 * knows of the branch's worktree tab: `null` (not known), `{ open: false }`, `{ open: true, started }`,
 * `{ open: true, started: true, known: false }` (no report yet), or `{ ..., known: true, working,
 * needsInput, turn, lock }`. `turn` is the host's measure of the MAIN session from the CLI's own hooks
 * (host/turn-state.js): 'idle', 'turn', 'prompt', or null. PR #93 Dexter F1 / F2: `working` is the
 * subagent roster (blind to a main-session turn) and `needsInput` clears on a glance, so neither alone
 * may say a session is at rest; only `turn === 'idle'` does. Every action is enabled or DISABLED WITH A REASON, and nothing is dropped from the list:
 * the drawer draws the reason beside it. Unknown is never "fine": a session that hasn't reported its
 * state, or one whose tab can't be read, is not idle, so *Run /merged* stays off.
 *
 *   open-pr         the PR's GitHub page (origin's URL)
 *   jump            select the branch's open worktree tab
 *   open-worktree   an existing branch gets a worktree: DISABLED until agent-creator can attach one
 *   run-merged      type /merged and Enter into that tab's session: an open PR, a tab that is open and idle
 *   copy            the branch name, to the clipboard
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitActions`.
 */
(function (root) {

const OPEN_WORKTREE_WHY = 'needs agent-creator to attach an existing branch';

const yes = (id, label) => ({ id, label, enabled: true, why: null });
const no = (id, label, why) => ({ id, label, enabled: false, why });

function openPr(b, c) {
  const hasPr = Number.isInteger(b.pr);
  const label = hasPr ? `Open PR #${b.pr}` : 'Open PR';
  if (!hasPr) {
    return no('open-pr', label, c.prsKnown === false && b.state === 'unmerged'
      ? "PR status is unknown: gh didn't answer"
      : 'no PR for this branch');
  }
  if (typeof b.prUrl === 'string' && b.prUrl) return yes('open-pr', label);
  return no('open-pr', label, c.repoUrl ? "couldn't work out this PR's page" : 'no GitHub remote ("origin") to open it on');
}

function jump(b, c) {
  const label = 'Jump to its tab';
  if (b.place !== 'worktree' || typeof b.folder !== 'string' || !b.folder) {
    return no('jump', label, b.place === 'had-worktree' ? 'its worktree was removed' : 'no open worktree for this branch');
  }
  if (c.tab && c.tab.open === false) return no('jump', label, 'its worktree has no tab in this window');
  return yes('jump', label);   // an unknown tab is still tried: the shell says if it can't
}

function openWorktree(b) {
  const label = 'Open a worktree';
  if (b.place === 'worktree') return no('open-worktree', label, 'its worktree is already open: use Jump to its tab');
  if (b.state === 'merged') return no('open-worktree', label, "it's merged: nothing is left to work on");
  if (b.state === 'deleted') return no('open-worktree', label, 'the branch is gone from git');
  return no('open-worktree', label, OPEN_WORKTREE_WHY);
}

/**
 * Why a session can't be typed into, or null when it is at rest (shared with app/tab-shell.js, whose
 * re-check must agree). Working first: that is the first thing to wait for.
 */
function sessionBusyWhy(t) {
  if (t.working !== false || t.turn === 'turn') return 'is working: wait for it to finish';
  if (t.needsInput !== false || t.turn === 'prompt') return 'is waiting for you: answer it first';
  if (t.turn !== 'idle') return "hasn't said whether a turn is running: can't tell whether it's at rest";
  return null;
}

function runMerged(b, c) {
  const label = 'Run /merged';
  if (b.state === 'merged') return no('run-merged', label, 'this branch is already merged');
  if (b.state === 'deleted') return no('run-merged', label, 'the branch is gone from git');
  if (b.state !== 'open') {
    return no('run-merged', label, c.prsKnown === false ? "PR status is unknown: gh didn't answer" : 'no open PR for this branch');
  }
  if (b.place !== 'worktree' || typeof b.folder !== 'string' || !b.folder) return no('run-merged', label, 'no open worktree for this branch');
  const t = c.tab;
  if (!t) return no('run-merged', label, "can't tell what its session is doing");
  if (t.open !== true) return no('run-merged', label, 'its worktree has no tab in this window');
  if (t.started !== true) return no('run-merged', label, "its tab hasn't started a session yet");
  if (t.known !== true) return no('run-merged', label, "its session hasn't reported what it's doing yet");
  const busy = sessionBusyWhy(t);
  if (busy) return no('run-merged', label, `its session ${busy}`);
  return yes('run-merged', label);
}

function actionsFor(branch, ctx) {
  const b = branch || {};
  const c = ctx || {};
  return [openPr(b, c), jump(b, c), openWorktree(b, c), runMerged(b, c), yes('copy', 'Copy name')];
}

/** The action the keyboard lands on when the drawer opens: Jump if it works, else the first that does. */
function firstFocus(actions) {
  const on = (Array.isArray(actions) ? actions : []).filter(a => a.enabled);
  const j = on.find(a => a.id === 'jump');
  return (j || on[0] || {}).id || null;
}

const api = { actionsFor, firstFocus, sessionBusyWhy, OPEN_WORKTREE_WHY };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.gitActions = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
