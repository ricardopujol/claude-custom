/* A right click in the terminal pastes nothing (BACKLOG #194).
 *
 * The CLI turns mouse reporting on (DECSET 1000 + 1006) and, on Windows, pastes the clipboard when it reads a right-button
 * report. xterm sends that report for every right press and release, so a stray right click pasted by accident. This swallows
 * the right button's mouse events in the capture phase before xterm sees them, so no report reaches the pty. The `contextmenu`
 * event isn't touched (the dock tabs' own menu keeps working), and the left button, wheel and keyboard (Ctrl+V, Shift+Insert)
 * are untouched too.
 *
 * A plain script shares one global scope, so the file is an IIFE (CLAUDE.md, "Traps"). */
(function (root) {
'use strict';

const RIGHT_BUTTON = 2;
// xterm reads these; mouseup only matters after a mousedown it never saw, but a stray one is dropped as well.
const EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'];

function isRightButton(e) { return !!e && e.button === RIGHT_BUTTON; }

/** Swallow right-button mouse events on `el` (capture phase). Returns the remover. */
function installRightClickGuard(el) {
  const handler = (e) => { if (isRightButton(e)) e.stopPropagation(); };
  for (const type of EVENTS) el.addEventListener(type, handler, true);
  return () => { for (const type of EVENTS) el.removeEventListener(type, handler, true); };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installRightClickGuard, isRightButton, EVENTS };
} else {
  root.installRightClickGuard = installRightClickGuard;
}

})(typeof window !== 'undefined' ? window : globalThis);
