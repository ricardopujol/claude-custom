'use strict';
/**
 * The submit gate (BACKLOG #61, documentation/DESIGN_WAND_SUBMIT.md "The submit gate"). Pure: no DOM, no
 * clock, no globals. A wand click, and the Git drawer's Run /merged, TYPE a command and then ask this whether
 * to press Enter. It is asked only after the typing helper has read the box back as exactly the command (that
 * read-back stays the last check before the CR, in the same task).
 *
 *   planSubmit({ turn, typeOnly }) -> { enter, flash, reason }
 *
 *   turn      the tab's session state from the CLI's own hooks (host/turn-state.js): 'idle', 'turn',
 *             'prompt', or null (session start not seen). Anything else is treated as unknown.
 *   typeOnly  the favourite's "type only" flag. Absent means false (a favourite from before the flag).
 *             Any value but false / absent counts as type-only: an odd value never submits.
 *
 *   state         type-only   result
 *   'idle'        no          Enter. Flash "sent"
 *   'turn'        no          Enter. The CLI queues it (measured: verify/probe-queued-skill.js)
 *   'prompt'      any         refused: a dialog is open (typing is refused before this)
 *   null/unknown  no          type only (a dialog cannot be told apart)
 *   any           yes         type only
 *
 * `enter` is true in exactly two cells of that table. `reason` is set only for a refusal, and then there is
 * no flash.
 *
 * WRAPPED IN AN IIFE (see app/career-display.js): the renderer loads every script as a plain <script> tag
 * sharing ONE global scope. One name leaves it: `submitGate`.
 */
(function (root) {

const FLASH = Object.freeze({
  sent: 'sent',
  queued: "queued: Claude runs it when it's free",
  typed: 'typed, press Enter',
});

const TYPE_ONLY = Object.freeze({ enter: false, flash: FLASH.typed, reason: null });

function planSubmit(input) {
  const o = input !== null && typeof input === 'object' ? input : {};
  const { turn, typeOnly } = o;
  if (turn === 'prompt') return { enter: false, flash: null, reason: 'a dialog is open in this tab: answer it first' };
  if (typeOnly !== false && typeOnly !== undefined) return { ...TYPE_ONLY };
  if (turn === 'idle') return { enter: true, flash: FLASH.sent, reason: null };
  if (turn === 'turn') return { enter: true, flash: FLASH.queued, reason: null };
  return { ...TYPE_ONLY };
}

const api = { planSubmit, FLASH };

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module system.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.submitGate = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
