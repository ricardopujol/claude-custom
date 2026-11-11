'use strict';
/**
 * claude-custom :: one project's window, as an object (single-instance PR 1).
 *
 * Everything that belongs to ONE project's window used to be a module-level `let` or `const` in app/main.js, because there was
 * exactly one project per Electron process: the launch folder and what it makes of itself (PROJECT, MODE, ...), the BrowserWindow,
 * its tab shell, marks, strip layout, occupancy and transcript scanners, issues, canvas and preview views, dev servers, focus mode,
 * cue and focus state, the close question and the one-window claim. They live here now, in a closure made by
 * createProjectWindow(); main.js keeps a Map of them (projectWindows) with one entry for now, so the next lane can make a second.
 * Behaviour is unchanged: still one project per process.
 *
 * WHAT STAYS IN main.js: every ipcMain registration (ipcMain.handle throws on a second one, so a window never touches ipcMain), the
 * app-wide services (the UI store, the tray, the Resources service and sampler, the secret vault, the indexing bridge, the quit
 * handlers) and the per-process constants. A window is HANDED what it needs:
 *
 *   electron   { app, BrowserWindow, WebContentsView, Menu, dialog, session }: this module never requires 'electron', so it loads
 *              under plain `node --test`, and the moved code keeps its text (`win = new BrowserWindow(...)`)
 *   config     per-process constants (EXPLICIT_PORT, STRIP_HEIGHT, POLL_MS, PROBE_PORT, PROBE_TOKEN, ...)
 *   services   app-wide effects the window calls (uiStore, forProbe, openInBrowser, the host helpers, isQuitting / setQuitting, ...)
 *   attach()   the app-wide services that come into being later (resources, trayController, leanBridge, indexing), handed over the
 *              moment main assigns its own binding, so the window sees each become non-null at the same moment main does
 *
 * main.js reads window state live through getters (win, tabShell, focused, ...): never destructure or cache one across an await,
 * because the window's 'closed' handler sets `win = null`.
 */

const { projectOf, stateRoot } = require('../host/project-layout');
const { projectLabel } = require('../host/project-path');

function createProjectWindow({ launchCwd, config = {} }) {
  const { EXPLICIT_PORT = null } = config;

  // --- what this window is ----------------------------------------------------------
  const LAUNCH_CWD = launchCwd;
  const PROJECT = projectOf(LAUNCH_CWD);
  const MODE = (PROJECT && PROJECT.kind === 'container' && EXPLICIT_PORT === null) ? 'tabs' : 'single';
  // What hostEnv hands each host as its project. A folder in no project is its
  // own root and state, as the host would work out for itself.
  const HOST_PROJECT = PROJECT || { kind: 'none', root: LAUNCH_CWD, dev: LAUNCH_CWD };
  const PROJECT_ROOT = HOST_PROJECT.root;
  const STATE_ROOT = stateRoot(HOST_PROJECT);
  // The name on the window and on every tab's header: the same source the host
  // labels itself from (its PROJECT_ROOT).
  const WINDOW_LABEL = projectLabel(PROJECT_ROOT);

  return {
    identity: { LAUNCH_CWD, PROJECT, MODE, HOST_PROJECT, PROJECT_ROOT, STATE_ROOT, WINDOW_LABEL },
    launchCwd: LAUNCH_CWD,
    project: PROJECT,
    mode: MODE,
    hostProject: HOST_PROJECT,
    root: PROJECT_ROOT,
    stateRoot: STATE_ROOT,
    label: WINDOW_LABEL,
  };
}

module.exports = { createProjectWindow };
