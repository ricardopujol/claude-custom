#!/usr/bin/env node
'use strict';
/**
 * claude-custom <folder>
 *
 * Opens the harness on any project. Deliberately thin: every decision it makes
 * is already tested elsewhere, so what is left here is argument handling and a
 * spawn. The PORT is not chosen here -- app/main.js resolves it, because only
 * main can probe for an occupant and it must do so at the moment it attaches,
 * not whenever the launcher happened to look.
 */

const { spawn } = require('child_process');
const path = require('path');
const { resolveLaunchTarget } = require('../host/launch-target');
const { portForCwd } = require('../host/port-for-project');

const INSTALL_DIR = path.join(__dirname, '..');

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`claude-custom [folder]

  Opens the claude-custom harness on a project folder.
  With no folder, opens the one you are standing in.

  The port is derived from the project path, so two projects can be open at
  once and reopening a window finds the host it left running. Set
  CLAUDE_CUSTOM_PORT to override it for one launch.`);
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
  env: { ...process.env, CLAUDE_CUSTOM_CWD: target },
});
child.on('exit', code => process.exit(code == null ? 1 : code));
