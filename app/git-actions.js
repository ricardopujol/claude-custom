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
 * state, or one whose tab can't be read, is not idle, so *Type /merged* stays off.
 *
 *   open-pr         the PR's GitHub page (origin's URL)
 *   jump            select the branch's open worktree tab
 *   open-worktree   an existing branch gets a worktree: DISABLED until agent-creator can attach one
 *   type-merged      "Run /merged" (BACKLOG #61): the tab's page types /merged and, once it reads back, presses
 *                   Enter (app/submit-gate.js; PR #93 R2-1 had left the Enter to the person). An open PR, a tab
 *                   that is open and at rest. The id keeps its old name: the drawer and the shell key on it.
 *   copy            the branch name, to the clipboard
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitActions`.
 */
(function (root) {

const OPEN_WORKTREE_WHY = 'needs agent-creator to attach an existing branch';
// The lock states whose host runs the session (host/session-gate.js): held, no lock to take, or opened anyway.
const RUNS_A_SESSION = ['held', 'unlocked', 'override'];

// `hint`: what an ENABLED action leaves to the person (none does now); `why`: why one is off
const yes = (id, label, hint = null) => ({ id, label, enabled: true, why: null, hint });
const no = (id, label, why) => ({ id, label, enabled: false, why, hint: null });

function openPr(b, c) {
  const hasPr = Number.isInteger(b.pr);
  const label = hasPr ? `Open PR #${b.pr}` : 'Open PR';
  if (!hasPr) {
    return no('open-pr', label, c.prsKnown === false && b.state === 'unmerged'
      ? "PR status is unknown: gh didn't answer"
      : 'no PR for this branch');
  }
  if (typeof b.prUrl === 'string' && b.prUrl) return yes('open-pr', label);
  if (c.repoUrl) return no('open-pr', label, "couldn't work out this PR's page");
  // PR #93 Dexter F9: origin is there but isn't a github.com URL (an ssh alias, GitLab, Enterprise): say so
  if (typeof c.originHost === 'string' && c.originHost) {
    return no('open-pr', label, `origin points at ${c.originHost}, not a github.com address it can open`);
  }
  return no('open-pr', label, 'no GitHub remote ("origin") to open it on');
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
  // PR #93 Dexter F5: a blocked tab's host has no terminal, so nothing typed would arrive; a pending one
  // hasn't started its session. Only a tab that runs its session takes keys.
  if (t.lock === 'blocked') return 'is blocked: another session holds this worktree';
  if (t.lock === 'pending') return "hasn't taken its worktree's lock yet";
  if (!RUNS_A_SESSION.includes(t.lock)) return "can't tell whether it holds its worktree's session";
  if (t.working !== false || t.turn === 'turn') return 'is working: wait for it to finish';
  if (t.needsInput !== false || t.turn === 'prompt') return 'is waiting for you: answer it first';
  if (t.turn !== 'idle') return "hasn't said whether a turn is running: can't tell whether it's at rest";
  return null;
}

function typeMerged(b, c) {
  const label = 'Run /merged';
  if (b.state === 'merged') return no('type-merged', label, 'this branch is already merged');
  if (b.state === 'deleted') return no('type-merged', label, 'the branch is gone from git');
  if (b.state !== 'open') {
    return no('type-merged', label, c.prsKnown === false ? "PR status is unknown: gh didn't answer" : 'no open PR for this branch');
  }
  if (b.place !== 'worktree' || typeof b.folder !== 'string' || !b.folder) return no('type-merged', label, 'no open worktree for this branch');
  const t = c.tab;
  if (!t) return no('type-merged', label, "can't tell what its session is doing");
  if (t.open !== true) return no('type-merged', label, 'its worktree has no tab in this window');
  if (t.started !== true) return no('type-merged', label, "its tab hasn't started a session yet");
  if (t.known !== true) return no('type-merged', label, "its session hasn't reported what it's doing yet");
  const busy = sessionBusyWhy(t);
  if (busy) return no('type-merged', label, `its session ${busy}`);
  return yes('type-merged', label);
}

function actionsFor(branch, ctx) {
  const b = branch || {};
  const c = ctx || {};
  return [openPr(b, c), jump(b, c), openWorktree(b, c), typeMerged(b, c), yes('copy', 'Copy name')];
}

/**
 * What the drawer says once Run /merged has answered (the shell's `typeMerged` answer): sent when the page's gate
 * pressed Enter, typed when it left the Enter to the person (a session that hadn't reported its state), the
 * shell's own explanation when there is one, else a plain failure. Only a literal `submitted: true` says "Sent".
 */
function mergedSaid(r, name) {
  if (r && r.kind === 'typed') {
    const where = typeof r.branch === 'string' && r.branch ? r.branch : name;
    const lead = r.submitted === true
      ? `Sent /merged to ${where}'s session.`
      : `Typed /merged in ${where}'s tab: press Enter there to run it.`;
    // A box that wasn't empty was cleared first (a draft, or the CLI's placeholder: the text can't tell)
    return lead + (r.cleared ? " Its input box wasn't empty: if that was a draft, Ctrl+Y in that tab brings it back." : '');
  }
  return (r && typeof r.text === 'string' && r.text) || "Couldn't run /merged.";
}

/** The action the keyboard lands on when the drawer opens: Jump if it works, else the first that does. */
function firstFocus(actions) {
  const on = (Array.isArray(actions) ? actions : []).filter(a => a.enabled);
  const j = on.find(a => a.id === 'jump');
  return (j || on[0] || {}).id || null;
}

const api = { actionsFor, firstFocus, sessionBusyWhy, mergedSaid, OPEN_WORKTREE_WHY };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.gitActions = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
