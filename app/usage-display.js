'use strict';
/**
 * How a token figure should be DRAWN, given how well it is known.
 *
 * Extracted from renderer.js for the reason attention-surface.js was: a
 * decision living inside a browser script is a decision nothing can test, and
 * this project has already shipped a fix into exactly that kind of region.
 *
 * THE DEFECT THIS EXISTS FOR. host/usage.js goes to real lengths to make
 * absence distinguishable from zero -- the `ok`, `absent` and `stale` fields,
 * and several paragraphs explaining why reporting a confident lower total is
 * what seeds a false baseline. Then the only consumer that draws pixels read
 * `session`, `project` and `milestone`, and never looked at any of them. On
 * attach before the first read landed, the header printed
 *
 *     session 0 · project 0 · 0 sessions
 *
 * which is the precise thing the module one layer down refuses to produce. A
 * status field that reaches no consumer is not a status field.
 *
 * Four states, because a single "is it good" boolean cannot say the useful
 * part:
 *
 *   reading      nothing has been read yet. A number here would be invented.
 *   lower-bound  some transcript could not be read and never has been, so the
 *                true figure is HIGHER than this. Shown with a prefix, because
 *                throwing the partial total away would be its own dishonesty --
 *                it is real, it is just not all of it.
 *   held         a transcript we have read before is temporarily unreadable and
 *                its last known total is standing in. The number is trustworthy
 *                and simply is not moving, which is worth saying out loud:
 *                substitution trades a visible drop for a frozen number, and a
 *                frozen number with no signal is the worse of the two.
 *   complete     everything was read this tick.
 */


/*
 * WRAPPED IN AN IIFE, and this file is why the pattern exists. It declared
 * top-level `UNKNOWN`, `AT_LEAST` and `plural`, and the renderer loads these as
 * plain <script> tags sharing ONE global scope -- so the NEXT file to want any
 * of those names aborted on a SyntaxError and its panel silently never drew.
 * That happened twice (career-display, quota-display); both defended themselves
 * and the aggressor was left as-is. `plural` is the one that would have done it
 * again: nobody writing a sixth module thinks twice about `const plural`.
 * Enforced now by test/renderer-scope.test.js.
 */
(function (root) {

const UNKNOWN = '—';          // em dash
const AT_LEAST = '≥';         // >=

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function usageDisplay(usage) {
  if (!usage || !usage.project) {
    return { state: 'reading', placeholder: UNKNOWN, prefix: '', note: 'reading transcripts…' };
  }

  const absent = Number(usage.absent) || 0;
  const stale = Number(usage.stale) || 0;

  // `ok === false` with nothing read yet is the attach case. Note that a
  // project genuinely at zero tokens reports ok:true, so this cannot swallow a
  // real zero.
  if (usage.ok === false && !(usage.project.sessions > 0)) {
    return { state: 'reading', placeholder: UNKNOWN, prefix: '', note: 'reading transcripts…' };
  }

  if (usage.ok === false) {
    return {
      state: 'lower-bound',
      placeholder: null,
      prefix: AT_LEAST,
      note: `${plural(absent, 'transcript')} could not be read — this is a lower bound`,
    };
  }

  if (stale > 0) {
    return {
      state: 'held',
      placeholder: null,
      prefix: '',
      note: `holding the last figure — ${plural(stale, 'transcript')} temporarily unreadable`,
    };
  }

  return { state: 'complete', placeholder: null, prefix: '', note: null };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/attention-surface.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { usageDisplay, UNKNOWN, AT_LEAST };
} else {
  root.usageDisplay = usageDisplay;
}

})(typeof window !== 'undefined' ? window : globalThis);
