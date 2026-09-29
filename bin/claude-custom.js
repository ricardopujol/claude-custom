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
const { resolveLaunchTarget, launchEnv, parseLaunchArgs } = require('../host/launch-target');
const { portForCwd } = require('../host/port-for-project');

const INSTALL_DIR = path.join(__dirname, '..');

// --new asks for a second session in this folder rather than a reattach;
// parsed in host/launch-target.js so it is tested and never taken for a path.
const args = parseLaunchArgs(process.argv.slice(2));
if (args.help) {
  console.log(`claude-custom [folder] [--new]

  Opens the claude-custom harness on a project folder.
  With no folder, opens the one you are standing in.

  Reopening a project finds the session it left running. The port is derived
  from the project path, so two projects can be open at once.

  --new    start a SECOND, independent session in the same folder instead of
           reattaching to the one already running there. Each gets its own
           port, its own history and its own context. Closing its window
           leaves it running; a plain \`claude-custom\` on the folder
           reconnects to the first live session it finds, so a second one is
           reachable again once the first has ended.`);
  process.exit(0);
}

let target;
try {
  target = resolveLaunchTarget(args.folder, { cwd: process.cwd() });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// With --new the derived port is, by definition, not the one used (Miguel #3).
console.log(`claude-custom: ${target}  ` +
  (args.fresh ? '[new session, next free port]' : `(port ~${portForCwd(target)})`));

// electron is resolved from the install's own node_modules rather than the
// PATH: the launcher can be run from anywhere, and "anywhere" rarely has the
// right electron on it.
const electron = require(path.join(INSTALL_DIR, 'node_modules', 'electron'));

const child = spawn(electron, [INSTALL_DIR], {
  stdio: 'inherit',
  env: launchEnv(process.env, target, { fresh: args.fresh }),
});
child.on('exit', code => process.exit(code == null ? 1 : code));
