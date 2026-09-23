'use strict';
/**
 * How wide the roster panel may be.
 *
 * Miguel, PR #33 review, A1 — and it is here rather than inline in
 * `renderer.js` for exactly the reason FF1's `spendOf` and FF3's
 * `projectLabel` are: a decision inline in the renderer is a decision nothing
 * can test. FF5 changed a clamp and left it in the one file with no test that
 * renders anything, which is the inconsistency this corrects.
 *
 * THE BUG THIS FIXES. FF5 replaced a flat `ROSTER_MAX = 420` with a
 * window-proportional cap, because a fixed pixel cap makes the panel
 * relatively NARROWER the larger the monitor — which is backwards, and is what
 * made the Map tab unreadable. But nothing re-evaluated the cap when the
 * window changed size, and `renderer.js` has no resize listener at all. So:
 * drag the roster to 1892px on a 3440px monitor, then move the window to a
 * 1366px screen, and the panel is now WIDER THAN THE WINDOW with nothing to
 * re-clamp it. The flat 420 was at least bounded. That traded "too narrow on a
 * big screen" for "unbounded on a shrinking one", and the second is worse
 * because it eats the terminal.
 *
 * THREE NUMBERS, WHICH ARE A POLICY AND NOT A DETAIL:
 *
 *   MIN   120   below this the portrait is a few pixels of face and the name
 *               truncates; narrower is not a smaller panel, it is a broken one.
 *   FLOOR 420   the old flat cap, kept as a lower bound on the cap so nothing
 *               gets worse on a small screen than it was before FF5.
 *   SHARE 0.55  of the window.
 *
 * MIGUEL, PR #33, R6 CAUGHT THE STATED REASON BEING WRONG. This used to read
 * "past this the terminal stops being the larger half" -- but at 0.55 the
 * roster is 55% and the terminal 45%, so the terminal has ALREADY stopped
 * being the larger half at exactly this value. The boundary that sentence
 * describes is 0.5.
 *
 * The number is deliberate and the reason was not. 0.55 exists so that a
 * roster dragged to its limit can show a readable portrait and a full agent
 * name on a laptop screen, which 0.5 does not quite manage at 1366px -- and
 * the terminal is still usable at 45% because it is the thing being READ,
 * while the roster is the thing being SCANNED. The rule, stated so a test can
 * hold it: the roster may take slightly more than half, and never two thirds.
 * That upper bound is what the assertion pins.
 *
 * None of the three was asserted anywhere before this module existed, and
 * StrykerJS generates no mutants for numeric literals, so no mutation score
 * could ever have covered them. They are pinned explicitly in
 * test/roster-width.test.js.
 */

(function (root) {

const ROSTER_MIN = 120;
const ROSTER_FLOOR = 420;
const ROSTER_SHARE = 0.55;

// The widest the panel may be in a window of this size. Never below the old
// flat cap, so a small window is no worse off than before FF5.
function rosterMax(innerWidth) {
  const w = typeof innerWidth === 'number' && Number.isFinite(innerWidth) ? innerWidth : 0;
  return Math.max(ROSTER_FLOOR, Math.round(w * ROSTER_SHARE));
}

/**
 * The width to actually apply, given what was asked for and the window today.
 *
 * Total by construction: a non-finite request (a corrupt localStorage value, a
 * drag event with no clientX) yields the minimum rather than NaN. `width:NaNpx`
 * is a declaration the browser drops, and the panel would silently take its
 * auto width — a broken value reading as a deliberate one, which is the failure
 * this codebase keeps paying for.
 */
function rosterWidth(px, innerWidth) {
  const want = typeof px === 'number' && Number.isFinite(px) ? Math.round(px) : ROSTER_MIN;
  return Math.max(ROSTER_MIN, Math.min(rosterMax(innerWidth), want));
}

// Faces grow with the panel, capped so they stay a portrait and not a poster.
// Tuned so the default 180px panel gives a ~41px face with room for the name.
// An earlier formula produced 73px faces at the default width and truncated
// every agent name.
function faceSize(w) {
  const width = typeof w === 'number' && Number.isFinite(w) ? w : ROSTER_MIN;
  return Math.round(Math.max(28, Math.min(150, 28 + (width - ROSTER_MIN) * 0.22)));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rosterWidth, rosterMax, faceSize, ROSTER_MIN, ROSTER_FLOOR, ROSTER_SHARE };
} else {
  root.rosterWidth = rosterWidth;
  root.rosterMax = rosterMax;
  root.faceSize = faceSize;
}

})(typeof window !== 'undefined' ? window : globalThis);
