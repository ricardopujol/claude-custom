'use strict';
/**
 * Which surfaces an attention event should reach.
 *
 * One rule decides the toast: it is for when you are NOT looking. A toast for
 * the thing already in front of you is noise, and noise is how a notification
 * system stops being read.
 *
 * This was briefly inverted, on the theory that focus suppression was why
 * notifications never arrived. It was not -- no hook was reaching the host at
 * all, because the subagent tool is named "Agent" and the host tested for
 * "Task". Removing the suppression fixed nothing and added noise; the diagnosis
 * was wrong, not the rule.
 *
 * Urgency still decides how INSISTENT an unfocused toast is:
 *
 *   urgent  -- makes a sound, flashes the taskbar, waits to be dismissed.
 *   not     -- appears quietly and goes away on its own.
 *
 * Pure, so the decision is testable without a window.
 */

function surfacesFor(msg, { focused = false } = {}) {
  const urgent = !!(msg && msg.urgent);

  return {
    // An OS toast exists to reach you in ANOTHER app. With the window focused
    // there is nothing for it to do that the in-window cue is not already doing.
    toast: focused ? null : {
      title: (msg && msg.title) || 'claude-custom',
      body: (msg && msg.body) || '',
      silent: !urgent,
      requireInteraction: urgent,
    },
    // Flashing an already-focused window is a no-op on Windows, and reserving
    // the flash for urgency is what stops it becoming background noise.
    flashTaskbar: urgent && !focused,
    badge: urgent ? 'urgent' : 'done',
    // The toast evaporates; this is what is still on screen when you come back.
    cue: true,
  };
}

// Loaded two ways: require() from tests and the main process, and a plain
// <script> tag in the renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) module.exports = { surfacesFor };
else if (typeof window !== 'undefined') window.surfacesFor = surfacesFor;
