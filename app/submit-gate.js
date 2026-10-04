'use strict';
/**
 * The submit gate (BACKLOG #61, documentation/DESIGN_WAND_SUBMIT.md "The submit gate" and "Review round picks").
 * Pure: no DOM, no clock, no globals. A wand click, and the Git drawer's Run /merged, TYPE a command and then
 * ask this whether to press Enter. It is asked only after the typing helper has read the box back as exactly the
 * command (that read-back stays the last check before the CR, in the same task), and a running turn gets one
 * more look first (`recheck`, F1).
 *
 *   planSubmit({ turn, typeOnly }) -> { enter, recheck, flash, reason }
 *
 *   turn      the tab's session state from the CLI's own hooks (host/turn-state.js): 'idle', 'turn',
 *             'prompt', or null (session start not seen). Anything else is treated as unknown.
 *   typeOnly  the favourite's "type only" flag. Absent means false (a favourite from before the flag).
 *             Any value but false / absent counts as type-only: an odd value never submits.
 *
 *   state         type-only   result
 *   'idle'        no          Enter
 *   'turn'        no          Enter, after a re-check ~400 ms later (F1: a permission dialog can open between
 *                             the read-back and the CR, and the read-back only proves what xterm had parsed)
 *   'prompt'      any         type only, flash "Claude may be waiting on you..." (F3: the host's dialog flag can
 *                             stay set at a quiet prompt; the SCREEN check refuses a dialog it can see, before
 *                             anything is typed). Never Enter when the host and the screen disagree.
 *   null/unknown  no          type only (a dialog cannot be told apart)
 *   any           yes         type only
 *
 * `flash` of an Enter is provisional ('sent'): what the page says afterwards comes from the screen, not from the
 * hook state (F7): `queuedShown` below. `enter` is true in exactly two cells of the table. `reason` is for a
 * refusal and then there is no flash (the gate itself has none today: the screen refuses a dialog earlier).
 *
 * WRAPPED IN AN IIFE (see app/career-display.js): the renderer loads every script as a plain <script> tag
 * sharing ONE global scope. One name leaves it: `submitGate`.
 */
(function (root) {

const FLASH = Object.freeze({
  sent: 'sent',
  queued: "queued: Claude runs it when it's free",
  typed: 'typed, press Enter',
  waiting: "Claude may be waiting on you: press Enter if it's free",
});

// Said once a typed command replaced a non-empty box (a draft, or the CLI's placeholder: the text can't tell).
// ONE copy for the wand's flash and the Git drawer's Run /merged answer (Dexter F5).
const DRAFT_CLEARED = " Its input box wasn't empty: if that was a draft, Ctrl+Y in that tab brings it back.";

const plan = (enter, recheck, flash) => ({ enter, recheck, flash, reason: null });

function planSubmit(input) {
  const o = input !== null && typeof input === 'object' ? input : {};
  const { turn, typeOnly } = o;
  if (turn === 'prompt') return plan(false, false, FLASH.waiting);
  if (typeOnly !== false && typeOnly !== undefined) return plan(false, false, FLASH.typed);
  if (turn === 'idle') return plan(true, false, FLASH.sent);
  if (turn === 'turn') return plan(true, true, FLASH.sent);
  return plan(false, false, FLASH.typed);
}

// What the CLI itself draws when it holds a submitted line for the end of the turn (measured: verify/probe-queued-
// skill.js, claude 2.1.289: "❯ Press up to edit queued messages" under the queued line).
const QUEUED_PHRASE = 'Press up to edit queued messages';

/** Is the CLI's queued-messages line on screen? `lines` is the screen as strings; anything else is false. */
function queuedShown(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.some(l => typeof l === 'string' && l.replace(/\s+/g, ' ').includes(QUEUED_PHRASE));
}

const api = { planSubmit, queuedShown, FLASH, DRAFT_CLEARED };

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module system.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.submitGate = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
