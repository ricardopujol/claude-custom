'use strict';
/**
 * Which escape vectors verify/probe71/sandbox-main.js runs in which mode (PR #122 Dexter R2-2). Kept apart from the Electron main
 * so test/probe-vector-modes.test.js can check it.
 *
 * A DIALOG vector raises a native dialog. In SEALED mode the app's lock-down is what is under test. In NAIVE mode nothing locks the
 * panel, so the dialog is real and stays up until somebody closes it:
 *   - `dialog-loop` (alert/confirm) is a message box nothing in the probe can close. It never runs naive. Measured before this
 *     change: the box appears on the desktop ("Electron"), the panel's renderer blocks, the vector reports 'no report' after the
 *     10 s timer and the box goes when the view is closed. The probe did not hang; it put an alert box on the desktop each run.
 *   - the others run naive only as a measured control: the driver started verify/probe71/watch-windows.ps1, which sees each
 *     dialog window and cancels it by handle.
 */
const DIALOG_VECTORS = new Set(['dialog-loop', 'print-loop', 'file-picker-with-click', 'color-picker-with-click']);
const NEVER_NAIVE = new Set(['dialog-loop']);
// A vector that shows a defect the app still has. It stays out of the default run (it would wedge the probe) until the defect is fixed;
// ask for it by name (PROBE_ONLY) or with PROBE_KNOWN_GAPS=1. `print-loop`: window.print() raises no dialog (measured) but blocks the
// panel's renderer for good, and the Electron process then cannot exit (app.exit(0) did not return in 85 s). PR #122 Dexter R2-1.
const KNOWN_GAPS = new Set(['print-loop']);

/** @param {'sealed'|'naive'} mode  @param {string[]} names every vector  @param {{watched?: boolean, only?: string, gaps?: boolean}} opts */
function vectorsFor(mode, names, { watched = false, only = '', gaps = false } = {}) {
  const wanted = only ? only.split('|') : null;
  return names.filter((n) => {
    if (wanted && !wanted.includes(n)) return false;
    if (KNOWN_GAPS.has(n) && !gaps && !(wanted && wanted.includes(n))) return false;
    if (mode === 'sealed') return true;
    if (NEVER_NAIVE.has(n)) return false;
    return !DIALOG_VECTORS.has(n) || watched === true;
  });
}

module.exports = { DIALOG_VECTORS, NEVER_NAIVE, KNOWN_GAPS, vectorsFor };
