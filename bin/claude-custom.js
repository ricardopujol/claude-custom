#!/usr/bin/env node
'use strict';
/**
 * claude-custom <folder>
 * claude-custom <folder> --stop
 * claude-custom --version
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
const { resolveLaunchTarget, parseCli, launchEnv, versionLine } = require('../host/launch-target');
const { portForCwd } = require('../host/port-for-project');

const INSTALL_DIR = path.join(__dirname, '..');

const argv = process.argv.slice(2);
let cli;
try {
  cli = parseCli(argv, { cwd: process.cwd() });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (cli.cmd === 'version') {
  console.log(versionLine(require('../package.json')));
  process.exit(0);
}

if (cli.cmd === 'help') {
  console.log(`claude-custom [folder]
claude-custom [folder] --stop
claude-custom --version

  Opens the claude-custom harness on a project folder.
  With no folder, opens the one you are standing in.

  A project laid out as a container (<root>/dev plus a sibling folder per git
  worktree) opens ONE window with a tab per worktree, whichever of those folders
  you name: launching from dev/ or from a sibling opens the project window with
  THAT worktree's tab selected. Any other folder opens as a single-tab window.

  The port is derived from each worktree's path, so two projects can be open at
  once and reopening a window finds the hosts it left running. Set
  CLAUDE_CUSTOM_PORT to override it for one launch (that launch is single-tab).

  --stop  Opens no window. Stops every claude-custom session using the folder
          -- working in it or in a folder inside it, or run from a build that
          lives there -- from this build and the builds beside it, so the
          folder can be removed. A session with a window open is never
          stopped, and nothing is stopped that can't be proven to be that
          session. Prints one line per session, then a note when not every
          session could be checked.
          exit 0  nothing is left serving the folder
          exit 3  something may still be: a session was kept, one started
                  meanwhile, or not every session could be checked
          exit 1  a usage error: an unknown option, two folders, an empty name`);
  process.exit(0);
}

if (cli.cmd === 'stop') {
  // Plain Node, no window: the worktree scripts call this before removing a
  // folder (Windowless sessions PR 3). Same deps as the ▾ menu's Stop.
  const { listBackgroundHosts } = require('../host/background-hosts');
  const { stopHost } = require('../host/stop-holder');
  const { listDeps, hostStopDeps } = require('../host/stop-deps');
  const { stopFolder, stopExitCode, stopReportLines } = require('../host/stop-folder');
  // A console on Windows is written asynchronously: exiting at once can cut the
  // report short. Let it drain, but never hang a script on a stray handle.
  const finish = (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 1000).unref();
  };
  // "Something may still be serving it" until the stop says otherwise: a run
  // that ends any other way is never read as clear (Dexter, PR #83 F8).
  process.exitCode = 3;
  stopFolder({ folder: cli.folder }, {
    list: () => listBackgroundHosts({ ownInstall: INSTALL_DIR }, listDeps(INSTALL_DIR)),
    stopHost: row => stopHost({ row }, hostStopDeps()),
  }).then((rep) => {
    for (const line of stopReportLines(rep)) console.log(line);
    finish(stopExitCode(rep));
  }, (err) => {
    console.error(`claude-custom --stop failed: ${err && err.message}`);
    finish(3);
  });
  return;
}

let target;
try {
  target = resolveLaunchTarget(cli.arg, { cwd: process.cwd() });
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
