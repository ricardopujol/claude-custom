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
const { resolveLaunchTarget, launchEnv } = require('../host/launch-target');
const { portForCwd } = require('../host/port-for-project');

const INSTALL_DIR = path.join(__dirname, '..');

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`claude-custom [folder] [--new]

  Opens the claude-custom harness on a project folder.
  With no folder, opens the one you are standing in.

  The port is derived from the project path, so two projects can be open at
  once and reopening a window finds the host it left running.

  --new    start a SECOND, independent session in the same folder instead of
           reattaching to the one already running there. Each gets its own
           port, its own history and its own context.

  Set CLAUDE_CUSTOM_PORT to pin an exact port for one launch.`);
  process.exit(0);
}

// --new asks for a second session in this folder rather than a reattach. Read
// before the folder is resolved, and removed, so it cannot be mistaken for a
// path.
const wantsNew = argv.includes('--new') || argv.includes('-n');
const folderArgs = argv.filter(a => a !== '--new' && a !== '-n');

let target;
try {
  target = resolveLaunchTarget(folderArgs[0], { cwd: process.cwd() });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`claude-custom: ${target}  (port ~${portForCwd(target)})` + (wantsNew ? '  [new session]' : ''));

// electron is resolved from the install's own node_modules rather than the
// PATH: the launcher can be run from anywhere, and "anywhere" rarely has the
// right electron on it.
const electron = require(path.join(INSTALL_DIR, 'node_modules', 'electron'));

const child = spawn(electron, [INSTALL_DIR], {
  stdio: 'inherit',
  env: wantsNew
    ? { ...launchEnv(process.env, target), CLAUDE_CUSTOM_NEW: '1' }
    : launchEnv(process.env, target),
});
child.on('exit', code => process.exit(code == null ? 1 : code));
