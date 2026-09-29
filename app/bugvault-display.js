'use strict';
/**
 * How the bug vault panel should be DRAWN, given what the host has sent.
 *
 * Extracted for the reason `app/usage-display.js` was: a decision living
 * inside `renderer.js` is a decision nothing can test, and this project's own
 * CLAUDE.md records two PRs rejected for exactly that.
 *
 * THE GROUPING IS COMPUTED ON THE HOST, NOT HERE. `host/bugvault.js` already
 * has `groupByCategory` and `detectionBreakdown`; the control message carries
 * their output as `summary.byCategory` / `summary.byDetection`. Re-deriving
 * the same grouping in the browser from the raw list would be the same
 * duplication `agent-stats.js` was built to avoid by reusing `usage.js`'s
 * reader rather than growing a second one -- one algorithm, one place, so the
 * two cannot drift.
 *
 * WRAPPED IN AN IIFE, deliberately, from the first line: the renderer loads
 * every script as a plain `<script src>` tag sharing ONE global scope, and
 * `app/usage-display.js` already declares a top-level `const UNKNOWN` there.
 * A second top-level `const UNKNOWN` here would be the exact collision that
 * killed `app/career-display.js` on arrival (CLAUDE.md, "Traps this codebase
 * has already paid for") -- silently, with every unit test still green,
 * because `require()` gives each test its own scope where there is nothing to
 * collide with.
 *
 * Three states, not two: a payload that has not arrived yet, a real empty
 * vault, and a vault with bugs in it. Collapsing the first two into "no bugs"
 * would be the absence-reported-as-zero bug this project keeps catching, one
 * panel over from `usage-display.js` and `career-display.js`.
 */

(function (root) {

const UNKNOWN = '—';   // em dash — same glyph and meaning as usage-display.js's

/**
 * Every state this module can return, as DATA rather than as four string
 * literals scattered through a function.
 *
 * Mortimer, PR #29 mutation gate. The test that checks renderer.js handles
 * them all used to regex the source text of this file for `state: '...'`,
 * which asserts the SPELLING of the source rather than a property of the
 * code -- it could not survive instrumentation (it failed on the unmutated
 * baseline under Stryker and had to be skipped by name), nor minification,
 * nor a formatter switching to double quotes, nor moving a name into a
 * constant. Exported, the same check becomes a fact about the module.
 */
const STATES = Object.freeze({
  READING: 'reading',       // nothing has arrived yet; it will resolve on its own
  UNREADABLE: 'unreadable', // the vault is on disk and could not be read; needs a person
  EMPTY: 'empty',           // a real, readable, empty vault
  READY: 'ready',           // records to draw
});

function bugVaultDisplay(payload) {
  const bugs = payload && Array.isArray(payload.bugs) ? payload.bugs : null;

  if (!bugs) {
    // Either no message has arrived yet, or the host sent something that is
    // not a bug list at all. Both are "we do not know", not "there are none".
    return { state: STATES.READING, total: 0, fixed: 0, unfixed: 0, rows: [], groups: [], detection: [], error: null };
  }

  const summary = (payload && payload.summary) || {};

  // THE FOURTH STATE. Dexter F1: the vault now refuses to overwrite a file it
  // could not read, and says why. Rendering that as `empty` would show "no
  // bugs recorded yet -- add one below" over a damaged vault full of the
  // user's records, and invite them to type into a store refusing every write.
  // Unlike `reading`, this unknown does not resolve on its own; it needs a
  // person to go and look at the file.
  if (summary.error) {
    return {
      state: STATES.UNREADABLE, total: 0, fixed: 0, unfixed: 0,
      rows: [], groups: [], detection: [], error: summary.error,
    };
  }
  const groups = formatGroups(summary.byCategory);
  const detection = (Array.isArray(summary.byDetection) ? summary.byDetection : [])
    .map(row => ({ ...row, label: row.detectedBy === null ? 'not recorded' : row.detectedBy }));

  const fixedCount = bugs.filter(b => b && b.fixed).length;
  const unfixedCount = bugs.length - fixedCount;

  // Unfixed first: the open work is what a reviewer opening this panel needs
  // to see without scrolling past every already-closed record ahead of it.
  const rows = bugs
    .slice()
    .sort((a, b) => Number(!!(a && a.fixed)) - Number(!!(b && b.fixed)))
    .map(formatBugRow);

  return {
    state: bugs.length === 0 ? STATES.EMPTY : STATES.READY,
    total: bugs.length,
    fixed: fixedCount,
    unfixed: unfixedCount,
    rows,
    groups,
    detection,
    error: null,
  };
}

/**
 * The category grouping, ready to draw.
 *
 * THE HOST RANKED THESE and that order is the feature: "six found by
 * measurement, none by reading" only reads as a fact if the biggest class is
 * not buried under insertion order. Nothing here re-sorts -- re-deriving the
 * ranking in the browser would be the second, divergent copy of an algorithm
 * this module's header explicitly refuses to grow.
 *
 * `bar` is a PERCENTAGE of the largest group, computed here rather than in
 * renderer.js for the reason this whole module exists: a drawing decision
 * inline in the renderer is a decision nothing can test, and the first version
 * of this feature put it there. It is a percentage rather than a pixel count
 * so the panel can be resized without the arithmetic moving back.
 *
 * A floor of 4 keeps a one-bug class visible as a bar rather than as nothing,
 * which would read as a rendering fault rather than as a small number.
 */
function formatGroups(byCategory) {
  const rows = Array.isArray(byCategory) ? byCategory.filter(g => g && typeof g === 'object') : [];
  const widest = rows.reduce((m, g) => Math.max(m, num(g.total)), 0);
  return rows.map(g => ({
    category: typeof g.category === 'string' && g.category.trim() ? g.category : UNKNOWN,
    total: num(g.total),
    fixed: num(g.fixed),
    unfixed: num(g.unfixed),
    bar: widest > 0 ? Math.max(4, Math.round((num(g.total) / widest) * 100)) : 0,
    // Drawn only when there are open ones: "0 open" on every closed class is
    // noise that buries the line worth reading.
    openLabel: num(g.unfixed) > 0 ? `${num(g.unfixed)} open` : null,
  }));
}

// A count, or zero -- but only for a REAL number. `Number(null)` is 0, which
// is the absence-reported-as-zero trap this codebase keeps paying for; a
// missing total must not become a confident 0 that also sizes a bar.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * One bug record, as text ready to drop into a template. Every optional field
 * renders as the same UNKNOWN placeholder `usage-display.js` uses for the
 * same reason: a blank cell and a recorded-but-empty cell must not look alike,
 * and a dash reads as "not recorded" rather than as a rendering mistake.
 */
function formatBugRow(bug) {
  const b = bug || {};
  const at = (v) => (typeof v === 'string' && v.trim()) ? v : UNKNOWN;
  return {
    id: typeof b.id === 'string' ? b.id : null,
    icon: b.fixed === true ? '✅' : '🐛',
    statusLabel: b.fixed === true ? 'fixed' : 'open',
    category: at(b.category),
    summary: at(b.summary),
    whereFound: at(b.whereFound),
    detectedBy: at(b.detectedBy),
    survived: at(b.survived),
    wouldHaveCaught: at(b.wouldHaveCaught),
  };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/usage-display.js and the other display modules.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bugVaultDisplay, formatBugRow, formatGroups, STATES, UNKNOWN };
} else {
  root.bugVaultDisplay = bugVaultDisplay;
  root.formatBugRow = formatBugRow;
}

})(typeof window !== 'undefined' ? window : globalThis);
