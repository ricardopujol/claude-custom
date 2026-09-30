'use strict';
/**
 * The environment a worktree's `claude` runs with, so it -- and every tool it
 * starts -- can tell which worktree it is in (Extension X3,
 * documentation/PLAN_WORKTREE_TABS.md):
 *
 *   WORKTREE_NAME         the worktree's folder (`dev`, `feat-sound`)
 *   COMPOSE_PROJECT_NAME  `<project>` for dev, `<project>-<folder>` for a
 *                         sibling, the folder for a flat repo
 *   WORKTREE_PORT_BASE    its block of ports, when host/port-blocks.js gave one
 *
 * WHY dev GETS THE BARE PROJECT NAME. Compose names a project after the
 * directory by default. Before the container layout, a project's containers
 * and volumes were created from `<project>\`, so they carry `<project>`; its
 * main checkout is now `<project>\dev\`, whose default would be `dev`. Setting
 * dev's name to the project's keeps them attached. For that to hold the value
 * must be normalised EXACTLY as Compose normalises a directory name (compose-go
 * NormalizeProjectName: lowercase, keep only [a-z0-9_-], trim leading `_`/`-`),
 * or `My Project` would become a new project beside the old `myproject`.
 */

const path = require('path');
const { projectOf } = require('./project-layout');

function composeName(s) {
  if (typeof s !== 'string') return '';
  return (s.toLowerCase().match(/[a-z0-9_-]/g) || []).join('').replace(/^[_-]+/, '');
}

// The worktree folder `cwd` sits in, or null: for a container, the child of
// the container that holds it (never the container itself); for a flat repo,
// the repo.
// (path.win32.relative compares case-insensitively and answers in `cwd`'s own
// spelling.)
function worktreeFolder(cwd, project) {
  if (project.kind === 'flat') return path.basename(project.root);
  const first = path.relative(project.root, path.resolve(cwd)).split(path.sep)[0];
  return first && first !== '..' ? first : null;
}

/**
 * The worktree folder `cwd` belongs to, or null (a plain folder, or the
 * container itself). What a port block is keyed by: a subfolder shares its
 * worktree's block, and a folder that isn't a worktree never takes one.
 */
function worktreeRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const project = projectOf(cwd);
  if (!project) return null;
  if (project.kind === 'flat') return project.root;
  const folder = worktreeFolder(cwd, project);
  return folder ? path.join(project.root, folder) : null;
}

function worktreeEnv(cwd, { portBase } = {}) {
  if (typeof cwd !== 'string' || !cwd) return {};
  const project = projectOf(cwd);
  if (!project) return {};
  const folder = worktreeFolder(cwd, project);
  if (!folder) return {};

  const env = { WORKTREE_NAME: folder };
  let name;
  if (project.kind === 'flat') name = composeName(folder);
  else {
    const projectName = path.basename(project.root);
    name = folder.toLowerCase() === 'dev' ? composeName(projectName) : composeName(`${projectName}-${folder}`);
  }
  if (name) env.COMPOSE_PROJECT_NAME = name;
  if (Number.isInteger(portBase)) env.WORKTREE_PORT_BASE = String(portBase);
  return env;
}

module.exports = { composeName, worktreeEnv, worktreeRoot };
