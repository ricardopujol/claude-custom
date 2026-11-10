/* A right click in a claude terminal pastes nothing (BACKLOG #194).
 *
 * The CLI turns mouse reporting on (DECSET 1000 + 1006) and, on Windows, pastes the clipboard when it reads a right-button
 * report. xterm sends that report for every right press, release and drag. This filter looks at what xterm is about to send to
 * the pty and drops only those reports. Nothing is intercepted in the page (no listener, no stopPropagation), so every menu and
 * popover that closes on a press in the terminal still sees a right press exactly as it did before (PR #251 Dexter 4); the left
 * button, wheel and keyboard (Ctrl+V, Shift+Insert) are untouched, and so is the `contextmenu` event.
 *
 * `isActive()` says whether to filter at all: a plain shell tab (mc, vim with mouse=a, htop) asks for the right button and keeps
 * it (Dexter 3; Ricardo's note said "in CLI"). Both encodings the CLI can use are handled: SGR (`ESC [ < b ; x ; y M|m`) and the
 * legacy one (`ESC [ M` then three bytes), whose right-button release is the anonymous "button 3" and is dropped only after a dropped right
 * press.
 *
 * A plain script shares one global scope, so the file is an IIFE (CLAUDE.md, "Traps"). */
(function (root) {
'use strict';

const SGR = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
const LEGACY = /^\x1b\[M([\s\S])[\s\S][\s\S]$/;

// Button code: bits 0-1 = button (0 left, 1 middle, 2 right, 3 release in the legacy encoding), +4 shift, +8 meta, +16 ctrl,
// +32 motion, +64 wheel.
const isRightCode = (code) => Number.isInteger(code) && (code & 64) === 0 && (code & 3) === 2;

/** `drop(data)` is true for a right-button mouse report that must not reach the pty. */
function createRightClickFilter(isActive = () => true) {
  let legacyRightDown = false;
  return {
    drop(data) {
      if (typeof data !== 'string' || data.length < 6 || data.charCodeAt(0) !== 0x1b || !isActive()) return false;
      const sgr = SGR.exec(data);
      if (sgr) return isRightCode(Number(sgr[1]));
      const legacy = LEGACY.exec(data);
      if (!legacy) return false;
      const code = legacy[1].charCodeAt(0) - 32;
      if (isRightCode(code)) { legacyRightDown = true; return true; }
      if ((code & 64) === 0 && (code & 3) === 3 && legacyRightDown) { legacyRightDown = false; return true; }
      if ((code & 3) !== 3) legacyRightDown = false;     // another button went down: the next release is not the right one's
      return false;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRightClickFilter, isRightCode };
} else {
  root.createRightClickFilter = createRightClickFilter;
}

})(typeof window !== 'undefined' ? window : globalThis);
