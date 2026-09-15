'use strict';
/**
 * How an agent's career figures should be DRAWN, given how well they are known.
 *
 * Extracted from renderer.js for the reason app/usage-display.js was, and to
 * fix the same defect one panel over: a decision living inside a browser
 * script is a decision nothing can test.
 *
 * THE DEFECT THIS EXISTS FOR. Vera (display-integrity-auditor), 2026-09-14,
 * tracing every displayed value in the renderer back to its source:
 * host/agent-stats.js computes `ok` and `unresolved` deliberately -- `ok` is
 * ABSENCE, "some transcript could not be read, so the true figure is higher
 * than this" -- and the only consumer that draws pixels read NEITHER. A failed
 * read of the projects folder produced a blank career, pixel-identical to "this
 * agent has never run here". The panel could not tell the user which it was,
 * because it never knew.
 *
 * The same audit found minutes presented as a measurement when they are a
 * bounded ESTIMATE: agent-stats.js caps every inter-turn gap at IDLE_GAP_MS,
 * so an overnight wait contributes five minutes and so does a genuinely long
 * tool call. Measured on this project at the time: 10 of one agent's 21
 * displayed minutes were cap fill. The module's docstring is candid about it;
 * the tooltip said "21 min worked" flat.
 *
 * Four states, mirroring usage-display.js, because a single "is it good"
 * boolean cannot say the useful part:
 *
 *   unknown      the roster read failed and we have no row. A number here
 *                would be invented; draw nothing.
 *   none         the read succeeded and this agent genuinely has no runs.
 *                Also draws nothing -- but it is a DIFFERENT nothing, and the
 *                caller can say so.
 *   lower-bound  we have figures AND something could not be read, so the true
 *                total is higher. Shown with a prefix rather than discarded:
 *                the partial is real, it is just not all of it.
 *   complete     everything was read.
 */

const UNKNOWN = '—';          // em dash
const AT_LEAST = '≥';         // >=
const ABOUT = '≈';            // approximately equal

// Why every minutes figure is approximate, stated once so the tooltip and any
// future surface cannot drift apart.
const ESTIMATE_NOTE =
  'estimated from transcript timestamps; gaps over 5 minutes counted as 5';

/**
 * Minutes as a string, where absence, a real zero, and a sub-minute run are
 * three different answers.
 *
 * `0m` is reserved for a genuine zero (a single-entry transcript really has no
 * measurable elapsed time). Real work under half a minute is `<1m`, because
 * "981k / 0m" beside a nonzero token count reads as "spent tokens, did no
 * work" -- false on its face. A missing or non-finite value is UNKNOWN rather
 * than a confident zero.
 */
function formatMinutes(ms) {
  // STRICTLY a number: `Number(null)` is 0 and `Number('')` is 0, so a
  // coercing check turns "no value" into a confident "0m" -- the exact
  // absence-reported-as-zero conflation this module exists to prevent.
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  if (ms === 0) return '0m';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

/**
 * @param row   the agent's row from `stats.agents`, or undefined if it has none
 * @param stats the whole `{ ok, agents, unresolved }` payload from the host
 */
function careerDisplay(row, stats) {
  const readOk = !stats || stats.ok !== false;
  const hasRuns = !!(row && row.runs);

  if (!hasRuns) {
    // No figures to draw either way -- but WHICH nothing this is matters to
    // the caller, and previously could not be asked.
    return {
      state: readOk ? 'none' : 'unknown',
      draw: false,
      prefix: '',
      minutesPrefix: '',
      unresolved: false,
      note: readOk ? null : 'the career read failed — this is unknown, not zero',
      detail: '',
    };
  }

  const unresolved = row.resolved === false;
  const runs = `${row.runs} run${row.runs === 1 ? '' : 's'} in this project`;
  const tokens = `${Number(row.tokens || 0).toLocaleString()} tokens`;
  const minutes = `${formatMinutes(row.ms)} worked (${ESTIMATE_NOTE})`;
  const detail = [
    runs,
    tokens,
    minutes,
    unresolved ? 'identity unresolved, this is a label not an agent type' : null,
    readOk ? null : 'a transcript could not be read — these figures are a lower bound',
  ].filter(Boolean).join(' — ');

  return {
    state: readOk ? 'complete' : 'lower-bound',
    draw: true,
    prefix: readOk ? '' : AT_LEAST,
    // Minutes are ALWAYS an estimate, however complete the read was.
    minutesPrefix: ABOUT,
    unresolved,
    note: readOk ? null : 'a transcript could not be read — this is a lower bound',
    detail,
  };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/usage-display.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { careerDisplay, formatMinutes, UNKNOWN, AT_LEAST, ABOUT, ESTIMATE_NOTE };
} else if (typeof window !== 'undefined') {
  window.careerDisplay = careerDisplay;
  window.formatCareerMinutes = formatMinutes;
}
