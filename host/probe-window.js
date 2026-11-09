'use strict';
/**
 * Where a verify/ probe's window goes: off the desktop, off the taskbar, never focused, so a probe running while a person
 * works neither shows up over their screen nor takes their keyboard. What was measured to work is in
 * verify/lib/launch-electron.js (header). CLAUDE_CUSTOM_PROBE_VISIBLE=1 leaves the options as the probe wrote them, for
 * debugging a probe by eye.
 */
const VISIBLE_VAR = 'CLAUDE_CUSTOM_PROBE_VISIBLE';
const OFFSCREEN = -20000;

const probeVisible = (env = process.env) => env[VISIBLE_VAR] === '1';

// A probe that must receive keyboard focus passes `focusable: true`; it stays off screen all the same.
function probeWindowOptions(opts = {}, env = process.env) {
  if (probeVisible(env)) return opts;
  return {
    ...opts,
    x: OFFSCREEN,
    y: OFFSCREEN,
    skipTaskbar: true,
    focusable: opts.focusable === true,
    // Throttling off keeps a window's timers running off screen, but it also makes document.visibilityState report 'visible' for a window
    // that is hidden or minimised (measured: probe-avatar-roster, BACKLOG #75). A probe that must SEE the page go hidden says
    // `backgroundThrottling: true` and keeps it.
    webPreferences: { backgroundThrottling: false, ...opts.webPreferences },
  };
}

module.exports = { probeWindowOptions, probeVisible, VISIBLE_VAR, OFFSCREEN };
