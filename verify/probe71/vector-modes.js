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
// `print-loop` and `spin-loop` wedge a panel and only mean something sealed (they test that the APP survives them): no naive control.
const NEVER_NAIVE = new Set(['dialog-loop', 'print-loop', 'spin-loop']);

/** @param {'sealed'|'naive'} mode  @param {string[]} names every vector  @param {{watched?: boolean, only?: string}} opts */
function vectorsFor(mode, names, { watched = false, only = '' } = {}) {
  const wanted = only ? only.split('|') : null;
  return names.filter((n) => {
    if (wanted && !wanted.includes(n)) return false;
    if (mode === 'sealed') return true;
    if (NEVER_NAIVE.has(n)) return false;
    return !DIALOG_VECTORS.has(n) || watched === true;
  });
}

module.exports = { DIALOG_VECTORS, NEVER_NAIVE, vectorsFor };
