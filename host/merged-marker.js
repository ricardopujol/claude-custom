'use strict';
/**
 * The merged marker (contract B): `<git-dir>/claude-merged.json` =
 * `{"branch","pr","mergedAt"}`, written into a worktree's own git-dir when its
 * PR merges. Design: documentation/PLAN_WORKTREE_TABS.md (W4).
 *
 * Seeing the marker starts the path that ends in REMOVING THE WORKTREE'S
 * FOLDER, so the reading is one-sided: anything short of a fully valid marker
 * for the branch the tab expects -- missing, unreadable, empty, bad JSON, a
 * field of the wrong type, another branch -- is "not merged". Never remove a
 * folder on a guess.
 */

const fs = require('fs');
const path = require('path');
const { resolveWorktreeGitDir } = require('./git-branch');

const MARKER = 'claude-merged.json';

function readMergedMarker(worktreePath, expectedBranch) {
  if (typeof worktreePath !== 'string' || !worktreePath) return null;
  if (typeof expectedBranch !== 'string' || !expectedBranch) return null;

  // Only a worktree's `.git` FILE leads to a marker: resolveWorktreeGitDir
  // reads it as a `gitdir:` pointer and gives null when it is missing or a
  // directory. So `dev`, the main checkout, is never merged away.
  const gitDir = resolveWorktreeGitDir(path.join(worktreePath, '.git'));
  if (!gitDir) return null;

  let m;
  try {
    // PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse rejects.
    m = JSON.parse(fs.readFileSync(path.join(gitDir, MARKER), 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;

  const { branch, pr, mergedAt } = m;
  if (branch !== expectedBranch) return null;
  // Strict: Number(null) is 0 and Number('12') is 12.
  if (!Number.isInteger(pr) || pr <= 0) return null;
  if (typeof mergedAt !== 'string' || Number.isNaN(Date.parse(mergedAt))) return null;
  return { branch, pr, mergedAt };
}

module.exports = { readMergedMarker };
