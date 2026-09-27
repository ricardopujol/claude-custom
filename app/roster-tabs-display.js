'use strict';
/**
 * Active/Inactive roster tabs (BACKLOG D #16): pure decisions only, drawn by
 * renderer.js, tested without a DOM here -- the same split app/career-display.js
 * and app/agent-card-display.js already made for their own panels.
 *
 * ACTIVE is today's list, unchanged: whatever host/mood-machine.js's
 * `roster()` already reports for THIS host lifetime. INACTIVE is the whole
 * roster (host/roster-index.js: every agent definition plus every name ever
 * seen in a transcript, across every project) minus Active. Active wins any
 * disagreement -- an agent working right now must never vanish from Active
 * because a background whole-roster scan has not caught up to it yet.
 *
 * SORT is lifetime tokens ACROSS ALL PROJECTS (host/agent-stats-cache.js's
 * `lifetimeAgentTokens`), most first. A never-used agent shows NO count, not a
 * "0" -- the same absence-is-not-zero rule CLAUDE.md names for this whole
 * codebase (`Number(null)` is `0`), so `rosterTokenState`/`sortRosterRows`
 * both check with strict `typeof`/`Number.isFinite` rather than a coercing
 * comparison, and a never-used agent sorts LAST rather than tying with a
 * genuine zero.
 *
 * DELIBERATE, NOT A LAW OF NATURE (Dexter F9, PR #59 review): an earlier
 * version of this comment claimed "a resolved run always has at least one
 * token, so tokens <= 0 and 'never ran' are the same fact" -- false. A spawn
 * aborted before its first API response, or a subagent transcript that
 * vanished between listing and read, produces a genuine `total: 0` for a run
 * that DID happen. This module still draws that the same as "never used"
 * (rather than inventing a third visual state), a deliberate simplification
 * pinned by its own test rather than justified by a premise that doesn't
 * hold.
 *
 * REUSES app/career-display.js's LOWER-BOUND STATE, per the spec, rather than
 * inventing a new one: the same three-way idea (nothing to show / a real but
 * possibly-incomplete total / a complete total) -- restated here rather than
 * imported, because every display module in this renderer is self-contained
 * on purpose (they load as plain <script> tags in a fixed order; see this
 * file's own IIFE wrapper note below and app/career-display.js's header for
 * why importing across them is the wrong direction to couple in).
 */

(function (root) {

const AT_LEAST = '≥'; // >=, identical character to app/career-display.js's own AT_LEAST

/**
 * Active is exactly `activeNames`; Inactive is `wholeRosterNames` minus
 * whatever is Active. An agent that is Active but missing from the whole
 * roster (a scan mid-pass, or a brand new agent this host has not indexed
 * yet) still counts as Active -- the live roster is always authoritative for
 * "is this agent working", and this function must never make one disappear
 * entirely for lack of a slower background read.
 */
function splitActiveInactive(wholeRosterNames, activeNames) {
  const whole = Array.isArray(wholeRosterNames) ? wholeRosterNames : [];
  const activeList = Array.isArray(activeNames) ? activeNames : [];
  const activeSet = new Set(activeList.filter(n => typeof n === 'string' && n));
  const merged = new Set([...whole.filter(n => typeof n === 'string' && n), ...activeSet]);
  const inactive = [...merged].filter(n => !activeSet.has(n));
  return { active: [...activeSet], inactive };
}

/**
 * Whether to draw a lifetime-token figure at all, and with what prefix.
 *
 * `tokens` must be a genuine positive finite number to draw anything -- `null`
 * (never used), `undefined`, `NaN`, a string, and `0` all draw NOTHING, the
 * same "absence, not zero" rule as app/career-display.js's `careerDisplay`.
 * `complete` is whether the FULL background scan (across every project) has
 * finished at least once; while it has not, a real total is still real, just
 * possibly short -- shown with `AT_LEAST` rather than withheld, the same
 * "lower-bound" state `careerDisplay` already draws for a partial project
 * read.
 */
function rosterTokenState(tokens, complete) {
  const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0;
  if (!hasTokens) return { show: false, prefix: '' };
  return { show: true, prefix: complete ? '' : AT_LEAST };
}

/**
 * `rows`: `[{ agent, tokens }]`, `tokens` a positive finite number or
 * anything else (absence). Returns a NEW array, most tokens first; rows with
 * no usable tokens sort last, among themselves alphabetically, same as a tie
 * among counted rows -- so the order is always fully determined, never an
 * accident of whatever order the caller built the array in.
 */
function sortRosterRows(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const has = (r) => typeof r.tokens === 'number' && Number.isFinite(r.tokens) && r.tokens > 0;
  return list.sort((a, b) => {
    const ah = has(a);
    const bh = has(b);
    if (ah !== bh) return ah ? -1 : 1; // a countable total always beats "never used"
    if (ah) return b.tokens - a.tokens || a.agent.localeCompare(b.agent);
    return a.agent.localeCompare(b.agent);
  });
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/career-display.js and app/agent-card-display.js -- and for the SAME
// reason: the renderer loads every script into one shared global scope, so
// this file must not leak an unwrapped top-level declaration into it (see
// test/renderer-scope.test.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitActiveInactive, rosterTokenState, sortRosterRows, AT_LEAST };
} else {
  root.splitActiveInactive = splitActiveInactive;
  root.rosterTokenState = rosterTokenState;
  root.sortRosterRows = sortRosterRows;
}

})(typeof window !== 'undefined' ? window : globalThis);
