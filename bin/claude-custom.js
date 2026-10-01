#!/usr/bin/env node
'use strict';
/**
 * claude-custom <folder>
 *
 * Opens the harness on any project. The folder is passed through as given:
 * app/main.js folds it with projectOf (host/project-layout.js), so a folder
 * inside a container project opens that project's tab window with the
 * folder's own tab selected. Deliberately thin: every decision it makes
 * is already tested elsewhere, so what is left here is argument handling and a
 * spawn. The PORT is not chosen here -- app/main.js resolves it, because only
 * main can probe for an occupant and it must do so at the moment it attaches,
 * not whenever the launcher happened to look.
 */

const { spawn } = require('child_process');
const path = require('path');
const { resolveLaunchTarget, launchEnv } = require('../host/launch-target');
const { portForCwd } = require('../host/port-for-project');

const INSTALL_DIR = path.join(__dirname, '..');

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`claude-custom [folder]

  Opens the claude-custom harness on a project folder.
  With no folder, opens the one you are standing in.

  A project laid out as a container (<root>/dev plus a sibling folder per git
  worktree) opens ONE window with a tab per worktree, whichever of those folders
  you name: launching from dev/ or from a sibling opens the project window with
  THAT worktree's tab selected. Any other folder opens as a single-tab window.

  The port is derived from each worktree's path, so two projects can be open at
  once and reopening a window finds the hosts it left running. Set
  CLAUDE_CUSTOM_PORT to override it for one launch (that launch is single-tab).`);
  process.exit(0);
}

let target;
try {
  target = resolveLaunchTarget(argv[0], { cwd: process.cwd() });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`claude-custom: ${target}  (port ~${portForCwd(target)})`);

// electron is resolved from the install's own node_modules rather than the
// PATH: the launcher can be run from anywhere, and "anywhere" rarely has the
// right electron on it.
const electron = require(path.join(INSTALL_DIR, 'node_modules', 'electron'));

const child = spawn(electron, [INSTALL_DIR], {
  stdio: 'inherit',
  env: launchEnv(process.env, target),
});
child.on('exit', code => process.exit(code == null ? 1 : code));
