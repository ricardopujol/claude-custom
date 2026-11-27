'use strict';
/**
 * The registry of project windows in one Electron process (single-instance PR 2).
 *
 * Pure: no Electron, no timers. main.js makes one, adds each window as it is made, and every ipcMain handler reaches "its" window
 * through a resolver here, never by naming a window.
 *
 *   stripOwner(event)   the window whose own page (the tab strip) sent `event`, or null
 *   viewOwner(sender)   the window one of whose tab views is `sender`, or null
 *   panelOwner(sender)  the window whose Claude's-panel contents is `sender`, or null
 *   closed(pw)          a window closed: see below
 *
 * A resolver returns the window or null; a GATE built from it must stay BOOLEAN (`!== null`), because every bridge requires
 * `isSender(sender) === true`.
 *
 * closed(pw): when more than one window is registered, the closed one is removed and disposed (its poll, timers, dev servers and
 * claim stop) and the answer is true. The LAST window is left registered and the answer is false, so `window-all-closed` and the
 * quit handlers in main.js tear it down exactly as they did when a process held one window.
 */

const { normPath } = require('../host/project-layout');

// The key is the NORMALISED root (resolved, trailing separators off, case-folded on Windows: the same helper the tab model uses), so one folder in
// two spellings is one window (PR #256 Dexter 2). A window keeps the spelling it was made with.
const keyOf = (root) => normPath(root) || root;

function createProjectRegistry() {
  const windows = new Map();   // keyOf(root) -> window, in insertion order
  let last = null;             // the window focused last (touch), while it is registered

  const find = (test) => {
    for (const p of windows.values()) if (test(p)) return p;
    return null;
  };

  return {
    add(pw) {
      if (windows.has(keyOf(pw.root))) throw new Error(`createProjectRegistry: a window for ${pw.root} is already registered`);
      windows.set(keyOf(pw.root), pw);
      return pw;
    },
    remove(pw) { if (windows.get(keyOf(pw.root)) === pw) windows.delete(keyOf(pw.root)); },
    get(root) { return windows.get(keyOf(root)) || null; },
    stripOwner(event) { const s = event && event.sender; return s ? find((p) => p.isStrip(s)) : null; },
    viewOwner(sender) { return sender ? find((p) => p.isTabView(sender)) : null; },
    panelOwner(sender) { return sender ? find((p) => p.canvasViews.isPanel(sender)) : null; },
    forEach(fn) { for (const p of [...windows.values()]) fn(p); },
    first() { for (const p of windows.values()) return p; return null; },
    /** A window was focused (PR 3): it is the one used last. A window that is not registered is ignored. */
    touch(pw) { if (pw && windows.get(keyOf(pw.root)) === pw) last = pw; },
    /** The window used last while it is still registered, else the first one, else null. */
    lastUsed() {
      if (last && windows.get(keyOf(last.root)) === last) return last;
      for (const p of windows.values()) return p;
      return null;
    },
    size() { return windows.size; },
    /** Every registered window, in insertion order (a copy). */
    list() { return [...windows.values()]; },
    closed(pw) {
      if (windows.get(keyOf(pw.root)) !== pw || windows.size <= 1) return false;
      windows.delete(keyOf(pw.root));
      pw.dispose();
      return true;
    },
  };
}

module.exports = { createProjectRegistry };
