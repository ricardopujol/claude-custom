'use strict';
/**
 * `git -C <dev> worktree list --porcelain` into the worktrees that have, or
 * may get, a tab. Design: documentation/PLAN_WORKTREE_TABS.md (window =
 * project, tab = git worktree).
 *
 * Porcelain format (measured on this repo, 2026-09-28): records separated by a
 * blank line; `worktree <path>` (forward slashes), `HEAD <sha>`, then
 * `branch refs/heads/<name>` or `detached`, optionally `bare`,
 * `locked [reason]`, `prunable [reason]`. Lines this module doesn't know are
 * ignored, so a newer git adding attributes doesn't break the list. Without
 * `-z` git quotes only the lock / prunable REASONS, never the path, and a
 * Windows path can't hold the newline that would need `-z`.
 *
 * Pure: the caller runs git and passes the text in.
 */

const path = require('path');
const { isValidBranchName } = require('./git-branch');
const { normPath, samePath } = require('./project-layout');

function emptyRecord(p) {
  return {
    path: p, head: null, branch: null, bare: false, detached: false, locked: false, lockReason: null, prunable: false,
  };
}

// `locked` and `prunable` come with or without a reason.
function isFlag(line, name) {
  return line === name || line.startsWith(name + ' ');
}

function parsePorcelain(text) {
  if (typeof text !== 'string') return [];
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      // A new record even without the blank line before it.
      if (cur) entries.push(cur);
      cur = emptyRecord(line.slice('worktree '.length));
    } else if (line === '') {
      if (cur) entries.push(cur);
      cur = null;
    } else if (cur) {
      if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length);
      else if (line === 'bare') cur.bare = true;
      else if (line === 'detached') cur.detached = true;
      else if (isFlag(line, 'locked')) {
        cur.locked = true;
        cur.lockReason = line === 'locked' ? null : line.slice('locked '.length);
      }
      else if (isFlag(line, 'prunable')) cur.prunable = true;
    }
    // Lines before any `worktree` line belong to no record: dropped.
  }
  if (cur) entries.push(cur);
  return entries.filter(e => e.path);
}

// `refs/heads/<name>` to `<name>`, or null for a detached HEAD, a ref outside
// refs/heads, or a name git would never create (reftable's `.invalid` stub).
function branchName(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) return null;
  const name = ref.slice('refs/heads/'.length);
  return isValidBranchName(name) ? name : null;
}

// A tab's folder sits directly inside the container. That one rule also keeps
// out subagent worktrees (`dev\.claude\worktrees\*`), nested folders, and
// worktrees somewhere else on disk. Through normPath, so an empty path is
// nothing rather than path.resolve('') -- the cwd.
function isSibling(container, p) {
  const n = normPath(p);
  return n !== null && samePath(path.dirname(n), container);
}

// Every worktree git LISTS that could be a tab: dev, then each direct sibling
// in list order, whatever state it is in. `openable` says whether a NEW tab
// may open for it: a named branch, not bare, not prunable, and not still being
// created (`git worktree add` holds the lock `initializing` until its checkout
// is done). Listed-but-not-openable still counts as present: a worktree
// detached mid-rebase is still there, and so is the session in it.
function tabWorktrees(entries, container) {
  if (!Array.isArray(entries) || normPath(container) === null) return [];
  const dev = path.join(container, 'dev');
  const usable = entries.filter(e => e && normPath(e.path) !== null);

  // `dev` is the anchor: it gets the first tab even when detached.
  const devEntry = usable.find(e => samePath(e.path, dev));
  if (!devEntry) return [];
  const tabs = [{ path: path.resolve(devEntry.path), branch: branchName(devEntry.branch), isDev: true, openable: true }];

  for (const e of usable) {
    if (!isSibling(container, e.path)) continue;
    // Also what skips dev here: it is already tabs[0].
    if (tabs.some(t => samePath(t.path, e.path))) continue;
    const branch = branchName(e.branch);
    const openable = Boolean(branch) && !e.bare && !e.prunable && e.lockReason !== 'initializing';
    tabs.push({ path: path.resolve(e.path), branch, isDev: false, openable });
  }
  return tabs;
}

// Remove, then prune, run from dev. Never `--force`: git refuses to remove a
// worktree with changes, and that refusal is the point. Anything that isn't a
// sibling worktree -- dev itself above all -- gets no commands.
function removalCommands(container, worktreePath) {
  if (normPath(container) === null) return [];
  const dev = path.join(container, 'dev');
  if (samePath(worktreePath, dev) || !isSibling(container, worktreePath)) return [];
  // Absolute, so it can never be read as an option.
  const wt = path.resolve(worktreePath);
  return [
    ['git', ['-C', dev, 'worktree', 'remove', wt]],
    ['git', ['-C', dev, 'worktree', 'prune']],
  ];
}

module.exports = { parsePorcelain, tabWorktrees, removalCommands };
