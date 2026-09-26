'use strict';
/**
 * The current branch of a working tree, read off git's own files -- no `git`
 * binary required, matching the read-state-not-shell-out convention already in
 * project-path.js and project-dir.js.
 *
 * Two things a naive "read .git/HEAD in cwd" gets wrong, both exercised by
 * test/git-branch.test.js:
 *
 *   1. git itself searches UPWARD from cwd for `.git` -- a subdirectory of the
 *      project has no `.git` of its own. Skipping that search would silently
 *      report "no branch" for anything but the exact repo root.
 *   2. A WORKTREE's `.git` is a FILE, not a directory: `gitdir: <path>` pointing
 *      at `<main>/.git/worktrees/<name>`, where that worktree's own HEAD
 *      actually lives. CLAUDE.md mandates worktrees for parallel agents, so
 *      this is the ordinary case for exactly the workflow this project needs,
 *      not an edge case -- reading `<worktree>/.git/HEAD` as a directory would
 *      throw, and reading the main tree's HEAD instead would report every
 *      worktree as being on whichever branch the main checkout happens to be on.
 */

const fs = require('fs');
const path = require('path');

function resolveWorktreeGitDir(gitFilePath) {
  let contents;
  try {
    contents = fs.readFileSync(gitFilePath, 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(contents);
  if (!m) return null;
  const target = m[1].trim();
  // Relative pointers resolve against the directory HOLDING the `.git` file --
  // the worktree -- not against whatever cwd happened to call this function.
  const worktreeDir = path.dirname(gitFilePath);
  return path.isAbsolute(target) ? target : path.resolve(worktreeDir, target);
}

function resolveGitDir(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, '.git');
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stat = null;
    }
    if (stat) {
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) return resolveWorktreeGitDir(candidate);
      return null;                // neither a dir nor a file: nothing sane to read
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;   // reached the filesystem root
    dir = parent;
  }
}

function currentBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;

  const gitDir = resolveGitDir(path.resolve(cwd));
  if (!gitDir) return null;

  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }

  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1].trim();

  // Detached HEAD: HEAD holds a raw SHA rather than a symbolic ref. Short form,
  // the same length `git status` shows, so it reads as a commit and not a
  // branch someone could mistake for a real one.
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);

  return null;
}

module.exports = { currentBranch };
