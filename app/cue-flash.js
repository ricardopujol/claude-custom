'use strict';
// Main-process only (not loaded by the renderer, so it adds no renderer global).
/**
 * What the taskbar button should do when the in-window cue changes (BACKLOG #117).
 * The cue border is static, so the taskbar flash is what moves: it starts when the cue
 * RISES on a window that is not focused, and stops when the cue clears. Never flash a
 * focused window. Returns true (start), false (stop) or null (leave it alone).
 */
function cueFlash(wasOn, on, focused) {
  if (!on) return wasOn ? false : null;
  if (focused) return null;
  return wasOn ? null : true;
}

module.exports = { cueFlash };
