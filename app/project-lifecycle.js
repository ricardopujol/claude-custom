'use strict';
/**
 * Opening a project window in this process, and closing one (single-instance PR 2; PR #256 Miguel Y2, S3; PR 3 step 3).
 *
 * The ORDER and the failure paths are the logic here (what exists before a window starts, what a start that failed must leave behind, what a
 * close drops), so it lives apart from main.js, where only a regex could pin it, and the regex had already missed a leaked playback watch.
 * No Electron: main hands in the registry and the effects.
 *
 *   startProject(cwd, { launch, show })  ->   (show: how a NEW window starts, 'setting' | 'shown' | 'hidden', app/project-window.js start) { pw, existing, first } | { pw: null, existing: false, first: null, elsewhere: true }
 *                                     | { pw: null, existing: false, first: null, error }
 *       The project's open window is brought forward and shows the cwd's lane (`existing: true`; NO window is built for it). Otherwise a window
 *       is made (`launch`: the process's own launch window, the only one an explicit port goes to) and its ONE-WINDOW CLAIM runs BEFORE it is
 *       registered (PR 3: every window holds its claim; the registry holds only windows that passed it). A claim that handed the launch to
 *       another process's window answers `elsewhere` with no window. Then its record and units, its start(), markReady() (from here a launch
 *       of this project is handed to it), and for a non-launch window its poll (the launch window's poll, refusals and exit are whenReady's).
 *       A start that throws costs ITS window only: it is removed, its record, units, playback watch and exit hook dropped, it is disposed and
 *       its window destroyed. The launch window's failure is rethrown (whenReady exits).
 *       Two opens of one project in flight are ONE open: the second waits for the first and is handled as a window that exists.
 *       After a successful start `onChanged` runs too (a window constructed visible fires no show event).
 *   projectClosed(pw)              a window closed: when another stays it is taken out of the registry and disposed (the registry decides:
 *       the LAST window is left for `window-all-closed` and the quit handlers) and everything main holds for it goes. Always tells
 *       `onChanged` (the tray's count, the Resources sampler's "who is looking").
 *
 * deps: registry, rootOf(cwd) (the project root a cwd belongs to), makeWindow(cwd, { launch }), makeRecord(pw), stopRecord(pw),
 * makeUnits(pw), dropUnits(pw), dropWatch(pw), dropExit(pw) (main's exit hooks for it), getAppStart(), afterStart(pw), onChanged(), log(...).
 */

const { normPath } = require('../host/project-layout');

function createProjectLifecycle({
  registry, rootOf, makeWindow, makeRecord, stopRecord, makeUnits, dropUnits, dropWatch, dropExit = () => {},
  getAppStart, afterStart = () => {}, onChanged = () => {}, log = console.error,
}) {
  const inFlight = new Map();          // normPath(root) -> the open in progress for that project

  function bringForward(open, cwd) {
    open.focusWindow();
    if (typeof open.showLane === 'function') open.showLane(cwd);
    return { pw: open, existing: true, first: null };
  }

  function dropAll(pw) {
    stopRecord(pw);
    dropUnits(pw);
    dropWatch(pw);       // createWindow() already ran onWindowCreated, so the window has a playback watch by now
    dropExit(pw);
  }

  async function openNew(cwd, launch, show) {
    const pw = makeWindow(cwd, { launch });
    // The claim is asked before anything is made for the window: a project another process owns gets its launch handed there.
    if (await pw.claim.run() === 'exit') {
      pw.dispose();
      return { pw: null, existing: false, first: null, elsewhere: true };
    }
    registry.add(pw);
    makeRecord(pw);
    makeUnits(pw);
    let first;
    try {
      first = await pw.start({ ...getAppStart(), show });
    } catch (err) {
      // The crash guard (DESIGN_SINGLE_INSTANCE.md 3.2): a project that fails to start costs ITS window, never the process or the others.
      if (launch) throw err;
      log(`[main] ${pw.label}: start failed:`, (err && err.stack) || err);
      const w = pw.win;
      registry.remove(pw);
      dropAll(pw);
      pw.dispose();
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* already gone */ }
      return { pw: null, existing: false, first: null, error: String((err && err.message) || err) };
    }
    afterStart(pw);
    pw.claim.markReady();           // from here a launch of this project is handed to this window
    // A window made visible fires no show event (its listeners are added after it shows), so who is looking is asked again here: minimise A, open B,
    // and Resources must wake (PR #256 Dexter 1).
    onChanged();
    if (!launch) pw.startPoll();
    return { pw, existing: false, first };
  }

  async function startProject(cwd, { launch = false, show = 'setting' } = {}) {
    // Checked BEFORE a window is built: the project may already have one, and building a window to throw it away costs a whole object graph.
    const root = rootOf(cwd);
    const open = registry.get(root);
    if (open !== null) return bringForward(open, cwd);
    const key = normPath(root) || root;
    const pending = inFlight.get(key);
    if (pending) {
      const r = await pending;
      return r.pw ? bringForward(r.pw, cwd) : r;
    }
    const p = openNew(cwd, launch, show);
    inFlight.set(key, p);
    try { return await p; } finally { if (inFlight.get(key) === p) inFlight.delete(key); }
  }

  function projectClosed(pw) {
    if (registry.closed(pw)) dropAll(pw);
    onChanged();
  }

  return { startProject, projectClosed };
}

module.exports = { createProjectLifecycle };
