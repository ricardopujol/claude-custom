'use strict';
/**
 * How Claude Code names a project's transcript folder.
 *
 *   C:\Users\ricar\VibeCode\claude-custom
 *     -> C--Users-ricar-VibeCode-claude-custom
 *
 * EVERY non-alphanumeric character becomes a dash -- not just the separators.
 * `/.claude` is two of them in a row and yields `--claude`, which is why the
 * real directory for a worktree reads
 * `...-music-tagging--claude-worktrees-frosty-banzai-0d7073`.
 *
 * This lived, wrong, in two modules at once. Both replaced only `/` and `:`, so
 * any project path containing a space, a dot or an underscore resolved to a
 * directory that does not exist. Two reviewers found it independently -- the
 * signal that it had been guessed rather than measured -- and it matters
 * because CLAUDE.md mandates git worktrees for parallel agents, so `.claude` is
 * in the path of the exact workflow the project requires.
 *
 * Shared here so the encoding is stated once. A copy in each consumer is a copy
 * of the bug.
 */

function projectDirName(cwd) {
  return String(cwd == null ? '' : cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

module.exports = { projectDirName };
