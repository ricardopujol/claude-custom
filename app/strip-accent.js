'use strict';
/**
 * Which accent the tab strip shows (backlog #64, Miguel F2). The strip is the
 * window's own page, so it only hears the SELECTED tab's accent. Each tab page
 * reports its own; this keeps them apart so the strip never wears another
 * worktree's colour while the selected tab hasn't reported yet (a page still
 * loading, a new or reopened tab).
 *
 * Pure bookkeeping, no Electron: main.js owns the sending. `view` is any object
 * (main passes the tab's webContents); it is held weakly.
 */
const HEX = /^#[0-9a-f]{6}$/i;

function createStripAccent() {
  const reported = new WeakMap();
  return {
    /** Remember what `view` reported. Only a #rrggbb counts; returns whether it was kept. */
    report(view, hex) {
      if (!view || typeof view !== 'object' || typeof hex !== 'string' || !HEX.test(hex)) return false;
      reported.set(view, hex);
      return true;
    },
    /** The accent for the strip while `view` is selected: its own, or null (the strip's default). */
    show(view) {
      return view && typeof view === 'object' && reported.has(view) ? reported.get(view) : null;
    },
  };
}

module.exports = { createStripAccent };
