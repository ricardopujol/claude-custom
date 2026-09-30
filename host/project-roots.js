'use strict';
/**
 * Where a host's PROJECT-level state lives, as opposed to its worktree.
 *
 * A tab is a git worktree, but theme, look and background belong to the
 * project: the container `<root>\` and its `dev\` checkout (host/project-layout.js).
 * The window that spawns a tab's host tells it so (CLAUDE_CUSTOM_PROJECT_ROOT /
 * _PROJECT_STATE, host/tab-env.js); a host started any other way works it out
 * from its own folder. A flat repo, and a folder in no project at all, are
 * their own root and state, so nothing changes for them.
 *
 * Empty strings count as unset: `env.X || ...` is deliberate.
 */

const layout = require('./project-layout');

function projectRoots(env, cwd, { projectOf = layout.projectOf, stateRoot = layout.stateRoot } = {}) {
  const e = env || {};
  // Lazy: an env that names both never touches the filesystem.
  let project;
  const proj = () => (project === undefined ? (project = projectOf(cwd)) : project);
  return {
    projectRoot: e.CLAUDE_CUSTOM_PROJECT_ROOT || (proj() && proj().root) || cwd,
    stateRoot: e.CLAUDE_CUSTOM_PROJECT_STATE || stateRoot(proj()) || cwd,
  };
}

module.exports = { projectRoots };
