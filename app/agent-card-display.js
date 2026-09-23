'use strict';
/**
 * Two truths the roster card did not draw before: how many instances of one
 * agent are running RIGHT NOW, and which model an agent actually used.
 *
 * `mood.stack()` already holds one entry per running instance (pushed on
 * PreToolUse(Agent), spliced on SubagentStop) and reaches the renderer as
 * `party` -- this module turns that list into per-agent counts so the roster
 * can draw a `×N` badge instead of silently collapsing two concurrent runs
 * into one card with no signal that a second is in flight.
 *
 * The model line follows host/session-model.js's own rule: absence is `null`,
 * never a guess and never `''`, and this module's job is to turn THAT into a
 * caller-safe display -- same "unknown is not zero" shape app/career-display.js
 * already established for tokens and minutes.
 *
 * WRAPPED IN AN IIFE, and that is not style -- see app/career-display.js's own
 * header. The renderer loads every script as a plain <script> tag sharing ONE
 * global scope; two files declaring the same top-level `const` is a
 * SyntaxError that silently kills the SECOND file, and no unit test can see it
 * because every test requires a module into its own scope. Rendered proof
 * lives in test/renderer-scope.test.js.
 */

(function (root) {

const UNKNOWN = '—';   // em dash -- absence, not a guess

/**
 * How many currently-running instances each agent type has, given `party`
 * (the live delegation stack, outermost first, exactly as `mood.stack()` and
 * the `party` field on `hello`/`processes` already carry it).
 *
 * Ignores anything that is not a non-empty string rather than throwing --
 * the payload is somebody else's process boundary, not a value this module
 * controls, and a malformed entry must not take the whole roster down.
 *
 * Property this holds for any input: the sum of every count in the returned
 * map equals the number of valid (non-empty-string) entries in `party` -- no
 * running instance is invented or lost.
 */
function instanceCounts(party) {
  const counts = new Map();
  if (!Array.isArray(party)) return counts;
  for (const agent of party) {
    if (typeof agent !== 'string' || !agent) continue;
    counts.set(agent, (counts.get(agent) || 0) + 1);
  }
  return counts;
}

/**
 * How to draw one agent's model line, given its entry from the host's
 * `sessionModel.agents` map (`{model, at, unresolved}` or absent entirely).
 *
 * `entry` may be `undefined` (the host has not reported anything for this
 * agent yet), or `{model: null, ...}` (reported, but nothing usable was read)
 * -- both draw the SAME "not read yet" state, because to the person looking at
 * the card they are the same fact: there is no model to show.
 */
function modelLine(entry) {
  const model = entry && typeof entry.model === 'string' && entry.model ? entry.model : null;
  if (!model) {
    return { text: UNKNOWN, title: 'model not read yet', unresolved: false };
  }
  const unresolved = !!(entry && entry.unresolved);
  return {
    text: model,
    title: unresolved
      ? `${model} — identity unresolved, this is a label not an agent type`
      : model,
    unresolved,
  };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/career-display.js and app/quota-display.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { instanceCounts, modelLine, UNKNOWN };
} else {
  root.instanceCounts = instanceCounts;
  root.modelLine = modelLine;
}

})(typeof window !== 'undefined' ? window : globalThis);
