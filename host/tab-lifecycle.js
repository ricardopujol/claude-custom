'use strict';
/**
 * The tab lifecycle, as a pure reducer: (state, observation) -> { state,
 * actions }. The window's poller builds each observation and executes the
 * actions; nothing here touches a process or the disk. Design:
 * documentation/PLAN_WORKTREE_TABS.md (W3 live pickup, W4 merged tabs).
 *
 *   state       = { tabs: [{ path, branch, isDev, phase, hostSeen, error? }], dismissed: [normPath] }
 *   phase       = 'live' | 'finishing' | 'removing' | 'remove-failed'
 *   observation = { worktrees: tabWorktrees(...)  -- every listed worktree, `openable` or not,
 *                   merged: { [normPath]: true }, listening: { [normPath]: bool } }
 *   action      = open | stop | close | mark-merged | remove | error, each with `path`
 *
 * A worktree's folder is removed only when, in the same observation, its
 * marker still reads as merged AND its host is not listening (strictly
 * `false`: missing is not "stopped") AND that host was seen listening since
 * the tab was marked merged. The last condition is what tells "the session
 * ended" from "a session hasn't started yet": opening a window on an
 * already-merged worktree, or pressing Restart after an exit, must not delete
 * the folder while a host is coming up. A session that had already ended
 * before the merge is never removed automatically; closing the tab by hand
 * keeps the folder for `/merged --sweep`.
 */

const { normPath, samePath } = require('./project-layout');

function initial() {
  return { tabs: [], dismissed: [] };
}

function unchanged(state) {
  return { state, actions: [] };
}

function dismiss(dismissed, p) {
  const k = normPath(p);
  return dismissed.includes(k) ? dismissed : [...dismissed, k];
}

function reconcile(state, observation) {
  const o = observation || {};
  const worktrees = Array.isArray(o.worktrees)
    ? o.worktrees.filter(w => w && normPath(w.path) !== null)
    : [];
  // No dev means git failed or the list is unusable: never read that as
  // "every worktree vanished" and stop every session.
  if (!worktrees.some(w => w.isDev)) return unchanged(state);
  const merged = o.merged || {};
  const listening = o.listening || {};
  const isMerged = (t) => merged[normPath(t.path)] === true;
  const actions = [];

  let tabs = state.tabs.map(t => ({ ...t }));

  // 1. Every openable worktree that isn't a tab yet, and wasn't closed by hand.
  for (const w of worktrees) {
    if (!w.isDev && !w.openable) continue;
    if (tabs.some(t => samePath(t.path, w.path)) || state.dismissed.includes(normPath(w.path))) continue;
    tabs.push({ path: w.path, branch: w.branch, isDev: Boolean(w.isDev), phase: 'live', hostSeen: false });
    actions.push({ type: 'open', path: w.path, branch: w.branch });
  }

  // 2. A worktree git no longer lists AT ALL: stop its host, close its tab.
  //    Listed-but-not-openable (detached mid-rebase, prunable) is still here.
  //    Not while we are removing it ourselves -- removeResult closes that one.
  tabs = tabs.filter(t => {
    const gone = !t.isDev && t.phase !== 'removing' && !worktrees.some(w => samePath(w.path, t.path));
    if (gone) actions.push({ type: 'stop', path: t.path }, { type: 'close', path: t.path });
    return !gone;
  });

  // 2b. The branch follows the worktree (git switch, branch -m). Mid-rebase
  //     there is no branch, so the tab keeps its last one. A finishing tab
  //     that moved to another branch goes back to live: its marker was for
  //     the old branch.
  for (const t of tabs) {
    if (t.phase !== 'live' && t.phase !== 'finishing') continue;
    const w = worktrees.find(x => samePath(x.path, t.path));
    if (!w || typeof w.branch !== 'string' || !w.branch || w.branch === t.branch) continue;
    t.branch = w.branch;
    t.phase = 'live';
  }

  // 3. Merged: the tab shows it; the session keeps running until Ricardo ends
  //    it. hostSeen starts over here: only a host seen running AFTER the
  //    merge can end "the session that was open when it merged".
  for (const t of tabs) {
    if (!t.isDev && t.phase === 'live' && isMerged(t)) {
      t.phase = 'finishing';
      t.hostSeen = false;
      actions.push({ type: 'mark-merged', path: t.path, branch: t.branch });
    }
  }

  for (const t of tabs) {
    if (listening[normPath(t.path)] === true) t.hostSeen = true;
  }

  // 4. Merged and its host seen running, then stopped: remove the folder.
  for (const t of tabs) {
    if (t.phase === 'finishing' && t.hostSeen && isMerged(t) && listening[normPath(t.path)] === false) {
      t.phase = 'removing';
      actions.push({ type: 'remove', path: t.path });
    }
  }

  // 5. Dismissing is about THAT worktree: once git stops listing the path, a
  //    worktree created there again is a new tab.
  const dismissed = state.dismissed.filter(k => worktrees.some(w => normPath(w.path) === k));

  // 6. dev first.
  tabs = [...tabs.filter(t => t.isDev), ...tabs.filter(t => !t.isDev)];
  return { state: { tabs, dismissed }, actions };
}

// Closing by hand keeps the folder, merged or not (`/merged --sweep` cleans
// it), and keeps the tab closed while this window lives and git still lists
// that worktree.
function closeByHand(state, p) {
  const tab = state.tabs.find(t => samePath(t.path, p));
  if (!tab || tab.isDev) return unchanged(state);
  return {
    state: { tabs: state.tabs.filter(t => t !== tab), dismissed: dismiss(state.dismissed, tab.path) },
    actions: [{ type: 'stop', path: tab.path }, { type: 'close', path: tab.path }],
  };
}

// The outcome of a `remove` action. Success closes the tab and dismisses the
// path (git's prune can lag a poll). Anything but `ok: true` is a failure: the
// tab stays with git's error and is never retried automatically.
function removeResult(state, p, result) {
  const tab = state.tabs.find(t => samePath(t.path, p) && t.phase === 'removing');
  if (!tab) return unchanged(state);
  if (result && result.ok === true) {
    return {
      state: { tabs: state.tabs.filter(t => t !== tab), dismissed: dismiss(state.dismissed, tab.path) },
      actions: [{ type: 'close', path: tab.path }],
    };
  }
  const error = result && result.error != null ? String(result.error) : 'git worktree remove failed';
  return {
    state: {
      tabs: state.tabs.map(t => (t === tab ? { ...t, phase: 'remove-failed', error } : t)),
      dismissed: state.dismissed,
    },
    actions: [{ type: 'error', path: tab.path, error }],
  };
}

module.exports = { initial, reconcile, closeByHand, removeResult };
