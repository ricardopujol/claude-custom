'use strict';
/**
 * The current branch of a working tree, read off git's own files -- no `git`
 * binary required, matching the read-state-not-shell-out convention already in
 * project-path.js and project-dir.js.
 *
 * Things a naive "read .git/HEAD in cwd, trust whatever follows refs/heads/"
 * gets wrong, each exercised by test/git-branch.test.js. Dexter, review
 * 2026-09-26, Findings 1-3:
 *
 *   1. git itself searches UPWARD from cwd for `.git` -- a subdirectory of the
 *      project has no `.git` of its own. Skipping that search would silently
 *      report "no branch" for anything but the exact repo root.
 *   2. An existing `.git` DIRECTORY is not necessarily a real one -- an empty
 *      directory that happens to be named `.git` (Finding 3) has no HEAD to
 *      read, and git keeps climbing past it rather than stopping there. Only a
 *      `.git` directory that actually CONTAINS a HEAD file is accepted.
 *   3. A WORKTREE's `.git` is a FILE, not a directory: `gitdir: <path>` pointing
 *      at `<main>/.git/worktrees/<name>`, where that worktree's own HEAD
 *      actually lives. CLAUDE.md mandates worktrees for parallel agents, so
 *      this is the ordinary case for exactly the workflow this project needs,
 *      not an edge case -- reading `<worktree>/.git/HEAD` as a directory would
 *      throw, and reading the main tree's HEAD instead would report every
 *      worktree as being on whichever branch the main checkout happens to be on.
 *   4. WHATEVER FOLLOWS `refs/heads/` ON HEAD's FIRST LINE IS NOT VALIDATED BY
 *      READING IT (Finding 1, Dexter). This is not hypothetical: a reftable
 *      repo (`git init --ref-format=reftable`, the format git 3.0 plans to
 *      default to) writes the compatibility stub `ref: refs/heads/.invalid` to
 *      HEAD -- the real branch lives in the reftable binary tables, which this
 *      module does not parse. Reading that stub as a literal branch name shows
 *      "project/.invalid" in the header FOREVER, never self-correcting. Fixed
 *      by validating the parsed name against git's own ref-name grammar
 *      (`git check-ref-format`) rather than trusting it -- `.invalid`'s
 *      leading dot is invalid under that grammar for the same reason a real
 *      branch could never be named that, so it is rejected the same way any
 *      other malformed value would be.
 */

const fs = require('fs');
const path = require('path');

// A conservative subset of `git check-ref-format`'s rules for a single ref
// name (not the more permissive `--refspec-pattern` variant): no component
// may start with '.' or end with '.lock', no '..', no ASCII control chars or
// the characters space ~ ^ : ? * [ \, no leading/trailing/doubled '/', not a
// bare '@', no '@{', and the whole name may not end in '.'. Good enough to
// catch reftable's `.invalid` placeholder and any other value this module did
// not itself construct -- it is a filter against untrusted file content, not a
// full reimplementation of git's validator.
function isValidBranchName(name) {
  if (!name || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name === '@' || name.includes('@{') || name.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(name)) return false;
  for (const part of name.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

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

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function resolveGitDir(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, '.git');
    const stat = statOrNull(candidate);
    if (stat && stat.isFile()) return resolveWorktreeGitDir(candidate);
    // A `.git` directory only counts if it actually holds a HEAD -- an empty
    // or half-created directory of that name is not a repo boundary, and git
    // keeps climbing past it rather than stopping and reporting nothing.
    if (stat && stat.isDirectory() && statOrNull(path.join(candidate, 'HEAD'))) {
      return candidate;
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
  if (ref) {
    const name = ref[1].trim();
    return isValidBranchName(name) ? name : null;
  }

  // Detached HEAD: HEAD holds a raw object id rather than a symbolic ref --
  // SHA-1 (40 hex) or SHA-256 (64 hex, git's newer, opt-in hash algorithm).
  // Prefixed with `~`, a character `check-ref-format` forbids in any real
  // branch name, so this can never be confused with an actual branch called
  // e.g. "a1b2c3d" (Dexter, Finding 4) -- the ambiguity is closed by
  // construction rather than by a comment asserting it away.
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) return '~' + head.slice(0, 7);

  return null;
}

module.exports = { currentBranch, isValidBranchName, resolveWorktreeGitDir };
