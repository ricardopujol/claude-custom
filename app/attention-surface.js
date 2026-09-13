'use strict';
/**
 * Which surfaces an attention event should reach.
 *
 * Split out of the renderer because the original rule -- "suppress the toast
 * whenever the window has focus" -- was wrong in exactly the case the feature
 * exists for: watching the terminal while a long task runs is the NORMAL way to
 * wait for it, and that made "tell me when it finishes" fire never.
 *
 * The corrected rule separates DELIVERY from INSISTENCE. Every event is always
 * delivered. How loudly depends on two things:
 *
 *   urgency  -- a blocked session is blocked whether or not you are looking.
 *   focus    -- if you are already here, do not make noise or demand a click.
 *
 * Pure, so the decision is testable without a window.
 */

function surfacesFor(msg, { focused = false } = {}) {
  const urgent = !!(msg && msg.urgent);

  return {
    // Always. An OS toast is the only surface that reaches you in another app.
    toast: {
      title: (msg && msg.title) || 'claude-custom',
      body: (msg && msg.body) || '',
      // Urgent events make a sound even with focus: "blocked" is worth a sound.
      silent: !urgent,
      // Never nag a window you are already looking at.
      requireInteraction: urgent && !focused,
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
