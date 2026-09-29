'use strict';
/**
 * Where a folder sits in the worktree model: window = project, tab = git
 * worktree. Design: documentation/PLAN_WORKTREE_TABS.md.
 *
 * Paths reach this module from three sources that spell the same folder
 * differently -- git prints `C:/a/b`, Node gives `C:\a\b`, users type either
 * case, with or without a trailing separator. Every comparison in the worktree
 * model goes through normPath so a folder is never two tabs, or zero, because
 * of how it was spelled.
 *
 * Two layouts:
 *   - container: `<root>\dev\` is the main checkout, every other worktree is a
 *     sibling `<root>\<name>\`. The container itself is not a repo.
 *   - flat: the repo is the folder itself (and old-style worktrees anywhere).
 *     Opens as today: one tab.
 *
 * Read off the filesystem, no `git` binary, like host/git-branch.js -- and
 * with its rule that an empty `.git` directory (no HEAD) is not a repo.
 */

const fs = require('fs');
const path = require('path');

function normPath(p) {
  if (typeof p !== 'string' || !p) return null;
  let r = path.resolve(p);
  // Strip trailing separators, but not a drive root's own: `C:\` stays `C:\`.
  if (r.length > 3) r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function samePath(a, b) {
  const x = normPath(a);
  return x !== null && x === normPath(b);
}

// Strictly inside, never equal. The trailing separator on the prefix is what
// keeps `C:\a\dev2` from counting as inside `C:\a\dev`; a drive root already
// ends in one, so it isn't doubled.
function isInside(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  if (c === null || p === null || c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// A real repo's own `.git` directory: one that holds a HEAD.
function hasGitDir(dir) {
  const stat = statOrNull(path.join(dir, '.git'));
  return Boolean(stat && stat.isDirectory() && statOrNull(path.join(dir, '.git', 'HEAD')));
}

// Where git would stop climbing: a real `.git` directory, or a worktree's
// `.git` FILE.
function isRepoBoundary(dir) {
  const stat = statOrNull(path.join(dir, '.git'));
  return Boolean(stat && (stat.isFile() || hasGitDir(dir)));
}

// A folder that is itself a repo boundary is never a container, even with a
// `dev` repo inside: otherwise that folder and its own subfolders would fold
// to different projects.
function layoutOf(dir) {
  if (typeof dir !== 'string' || !dir) return 'none';
  const d = path.resolve(dir);
  if (hasGitDir(d)) return 'flat';
  if (!isRepoBoundary(d) && hasGitDir(path.join(d, 'dev'))) return 'container';
  return 'none';
}

function container(root) {
  return { kind: 'container', root, dev: path.join(root, 'dev') };
}

function projectOf(p) {
  if (typeof p !== 'string' || !p) return null;
  const start = path.resolve(p);
  if (layoutOf(start) === 'container') return container(start);

  let repo = start;
  while (!isRepoBoundary(repo)) {
    const parent = path.dirname(repo);
    if (parent === repo) return null;   // reached the filesystem root
    repo = parent;
  }
  // `dev` and every sibling worktree sit directly inside their container.
  // (A repo at a drive root is its own dirname, which layoutOf never calls a
  // container because it is a repo boundary.)
  const parent = path.dirname(repo);
  if (layoutOf(parent) === 'container') return container(parent);
  return { kind: 'flat', root: repo, dev: repo };
}

// Theme, look and secrets live in `<dev>\.claude-custom\`, one set per project.
function stateRoot(project) {
  return project ? project.dev : null;
}

module.exports = { normPath, samePath, isInside, layoutOf, projectOf, stateRoot };
