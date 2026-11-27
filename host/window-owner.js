'use strict';
/**
 * One window per project (DESIGN_TABS_SESSIONS.md 3.3, Ricardo's pick P2): who owns this project's window?
 *
 * The window that opens first writes `<project>\.claude-custom\window.json` = { pid, start, at }: its own Electron
 * main pid and OS start time (host/proc-start.js FILETIME), the same pid + start proof host/host-identity.js and
 * host/kill-proven use. A later launch of the same project reads it BEFORE it makes a window and decides:
 *
 *   live owner (pid running AND start time equal)   focus it, forward the lane, exit with no window
 *   no file / dead owner / reused pid               proceed (and take the file over)
 *   a proof that could not be made                  proceed: a second window is the old behaviour, never a crash
 *
 * The proof itself (the decision table, the hard-link publish race, the takeover with the judged bytes, the guarded release) is
 * host/owner-file.js, shared with the app lock (host/app-owner.js, single-instance PR 3). This file ties it to the project's look folder:
 * a `.claude-custom` that is a link to somewhere else is never written through ('foreign-dir'), and a fresh one gets its .gitignore first.
 */

const fs = require('fs');
const path = require('path');
const { lookDir, lookDirState, ensureLookDir } = require('./style');
const { samePath, isInside } = require('./project-layout');
const core = require('./owner-file');

const OWNER_FILE = 'window.json';
const { parseOwner, decide, proveOwner } = core;

/** The owner-file core's place for a project: its look folder, unusable when that is a link elsewhere. */
function placeOf(stateRoot) {
  return {
    file: path.join(lookDir(stateRoot), OWNER_FILE),
    usable: () => lookDirState(stateRoot, fs) !== 'foreign',
    prepare: () => ensureLookDir(stateRoot, fs),
  };
}

/**
 * Called once, before this process makes a window. Resolves { action: 'focus', owner, file, text } (forward and exit) or
 * { action: 'proceed', reason, file, published } (make the window; `published` says the file now names this process).
 */
async function claim({ stateRoot, self, startTimes, ask, resolveStart, now = Date.now, link, hooks = {} } = {}) {
  return core.claimFile({ ...placeOf(stateRoot), unusableReason: 'foreign-dir', self, startTimes, ask, resolveStart, now, link, hooks });
}

/**
 * The owner on file was proven live but could not be reached: this launch opens its window anyway, and the file must then name THAT
 * window. Only the judged bytes are replaced (PR #247 Dexter M3). true when the file now names this process.
 */
function takeOver({ stateRoot, self, judgedText = null, now = Date.now, link } = {}) {
  return core.takeOverFile({ ...placeOf(stateRoot), self, judgedText, now, link });
}

/** Remove the file when it still names this process, by pid AND start time (a clean exit, a quit), guarded (PR #247 Dexter 3). */
function release({ stateRoot, selfPid, selfStart, hooks = {} } = {}) {
  return core.releaseFile({ file: placeOf(stateRoot).file, selfPid, selfStart, hooks });
}

/**
 * The lane a launch asked for: the tab on that port, else the tab whose folder IS the launch folder, else the deepest tab whose folder
 * CONTAINS it (a terminal opened in `<lane>\app`: project resolution climbs, so lane resolution does too). null = just focus.
 * `tabs` is tabShell.snapshot().tabs ({ key, cwd, port? }).
 */
function pickLane(tabs, { cwd, port } = {}) {
  if (!Array.isArray(tabs)) return null;
  if (Number.isInteger(port)) {
    const byPort = tabs.find(t => t && t.port === port);
    if (byPort) return byPort.key;
  }
  if (typeof cwd !== 'string' || !cwd) return null;
  const withCwd = tabs.filter(t => t && typeof t.cwd === 'string');
  const exact = withCwd.find(t => samePath(t.cwd, cwd));
  if (exact) return exact.key;
  let best = null;
  for (const t of withCwd) {
    if (isInside(cwd, t.cwd) && (best === null || isInside(t.cwd, best.cwd))) best = t;   // the deeper container wins
  }
  return best ? best.key : null;
}

/**
 * What a launch forwards as its lane: its folder when that is a lane's own folder (a worktree), nothing when it is the project's
 * `dev` or its container root (a plain focus: launching from `dev\` is not asking to leave the lane the person is on).
 */
function forwardedCwd(cwd, project) {
  if (typeof cwd !== 'string' || !cwd || !project) return undefined;
  if (samePath(cwd, project.dev) || samePath(cwd, project.root)) return undefined;
  return cwd;
}

module.exports = { OWNER_FILE, parseOwner, decide, proveOwner, claim, takeOver, release, pickLane, forwardedCwd };
