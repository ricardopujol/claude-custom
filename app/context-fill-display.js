'use strict';
/**
 * BACKLOG #6 -- the context-fill indicator: a small circle that steps through
 * grey, green, yellow, orange, red at 1/5, 2/5, 3/5 and 4/5 of the model's
 * context window.
 *
 * Pure decisions only (inputs in, a render-ready shape out; no DOM, no clock),
 * for the reason app/top-bar-display.js exists. The numbers come from the CLI's
 * own statusLine document via host/hook-session.js readContext -- this module
 * counts nothing and knows no window size.
 *
 * THE TRAP: `Number(null)` is 0. A count that was never reported must draw as
 * UNKNOWN -- a hollow dashed circle with its own class, never one of the five
 * colours -- not as a confident grey "0%". Every input is checked with
 * `typeof`, never coerced.
 *
 * WRAPPED IN AN IIFE, and that is not style: renderer.html loads these as plain
 * <script> tags sharing ONE global scope (test/renderer-scope.test.js).
 */
(function (root) {

// grey (< 20%) -> green -> yellow -> orange -> red (>= 80%). Fixed, not
// theme-derived, so a colour means the same fill in every project.
const PALETTE = Object.freeze(['#8a8f98', '#4caf6a', '#e6c229', '#f08a24', '#e04848']);
const STEP_CLASSES = Object.freeze(['ctx-0', 'ctx-1', 'ctx-2', 'ctx-3', 'ctx-4']);
const UNKNOWN_CLASS = 'ctx-unknown';

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * { state: 'unknown' } when either number is not a finite positive number;
 * otherwise { state: 'known', used, size, fraction, step, colour }. `step` is
 * 0..4 -- how many of the fifths (0.2, 0.4, 0.6, 0.8) the fill has reached; a
 * boundary belongs to the step above. Over 100% clamps to step 4 while the
 * numbers stay the real ones.
 */
function contextFill(ctx) {
  if (!ctx || typeof ctx !== 'object' || !positive(ctx.used) || !positive(ctx.size)) {
    return { state: 'unknown' };
  }
  const { used, size } = ctx;
  let step = 0;
  // used/size >= k/5, compared as used*5 >= k*size so that a whole-token count
  // sitting exactly on a boundary (40,000 of 200,000) lands on it.
  for (let k = 1; k <= 4; k++) if (used * 5 >= k * size) step = k;
  return { state: 'known', used, size, fraction: used / size, step, colour: PALETTE[step] };
}

/** "context: 123,456 / 200,000 (62%)", or "context: unknown". */
function titleFor(fill) {
  if (!fill || fill.state !== 'known') return 'context: unknown';
  const n = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `context: ${n(fill.used)} / ${n(fill.size)} (${Math.round(fill.fraction * 100)}%)`;
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { contextFill, titleFor, PALETTE, STEP_CLASSES, UNKNOWN_CLASS };
} else {
  root.contextFill = contextFill;
  root.contextFillTitle = titleFor;
  root.CONTEXT_STEP_CLASSES = STEP_CLASSES;
  root.CONTEXT_UNKNOWN_CLASS = UNKNOWN_CLASS;
}

})(typeof window !== 'undefined' ? window : globalThis);
