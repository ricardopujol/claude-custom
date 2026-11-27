'use strict';
/**
 * Opening a project window in this process, and closing one (single-instance PR 2; PR #256 Miguel Y2, S3).
 *
 * The ORDER and the failure paths are the logic here (what exists before a window starts, what a start that failed must leave behind, what a
 * close drops), so it lives apart from main.js, where only a regex could pin it, and the regex had already missed a leaked playback watch.
 * No Electron: main hands in the registry and the effects.
 *
 *   startProject(cwd, { launch })  -> { pw, existing, first } | { pw: null, existing: false, first: null, error }
 *       launch: the process's own launch window (its claim, poll and refusals are whenReady's; its failure is rethrown, whenReady exits).
 *       otherwise: the project's open window is brought forward and shows the cwd's lane (`existing: true`; NO window is built for it), or a
 *       new window is made, registered, given its record and units, started and polled. A start that throws costs ITS window only: it is
 *       removed, its record, units and playback watch dropped, it is disposed and its window destroyed.
 *       NOTE for PR 3: a second launch of a project that is open in THIS process is routed here too (the per-process claim pipe).
 *       After a successful start `onChanged` runs too (a window constructed visible fires no show event).
 *   projectClosed(pw)              a window closed: when another stays it is taken out of the registry and disposed (the registry decides:
 *       the LAST window is left for `window-all-closed` and the quit handlers) and everything main holds for it goes. Always tells
 *       `onChanged` (the tray's count, the Resources sampler's "who is looking").
 *
 * deps: registry, launchWindow, rootOf(cwd) (the project root a cwd belongs to), makeWindow(cwd), makeRecord(pw), stopRecord(pw),
 * makeUnits(pw), dropUnits(pw), dropWatch(pw), getAppStart(), afterStart(pw) (after a successful start), onChanged(), log(...).
 */

function createProjectLifecycle({
  registry, launchWindow, rootOf, makeWindow, makeRecord, stopRecord, makeUnits, dropUnits, dropWatch,
  getAppStart, afterStart = () => {}, onChanged = () => {}, log = console.error,
}) {
  async function startProject(cwd, { launch = false } = {}) {
    if (!launch) {
      // Checked BEFORE a window is built: the project may already have one, and building a window to throw it away costs a whole object graph.
      const open = registry.get(rootOf(cwd));
      if (open !== null) {
        open.focusWindow();
        if (typeof open.showLane === 'function') open.showLane(cwd);
        return { pw: open, existing: true, first: null };
      }
    }
    const pw = launch ? launchWindow : makeWindow(cwd);
    if (!launch) registry.add(pw);
    makeRecord(pw);
    makeUnits(pw);
    let first;
    try {
      first = await pw.start(getAppStart());
    } catch (err) {
      // The crash guard (DESIGN_SINGLE_INSTANCE.md 3.2): a project that fails to start costs ITS window, never the process or the others.
      if (launch) throw err;
      log(`[main] ${pw.label}: start failed:`, (err && err.stack) || err);
      const w = pw.win;
      registry.remove(pw);
      stopRecord(pw);
      dropUnits(pw);
      dropWatch(pw);       // createWindow() already ran onWindowCreated, so the window has a playback watch by now
      pw.dispose();
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* already gone */ }
      return { pw: null, existing: false, first: null, error: String((err && err.message) || err) };
    }
    afterStart(pw);
    // A window made visible fires no show event (its listeners are added after it shows), so who is looking is asked again here: minimise A, open B,
    // and Resources must wake (PR #256 Dexter 1).
    onChanged();
    if (!launch) pw.startPoll();
    return { pw, existing: false, first };
  }

  function projectClosed(pw) {
    if (registry.closed(pw)) {
      stopRecord(pw);
      dropUnits(pw);
      dropWatch(pw);
    }
    onChanged();
  }

  return { startProject, projectClosed };
}

module.exports = { createProjectLifecycle };
