'use strict';
/**
 * Hide sleeping agents (BACKLOG #14): pure decisions only, drawn by
 * renderer.js and tested without a DOM -- the same split as
 * app/roster-tabs-display.js.
 *
 * THE ONE RULE: only a SLEEPING agent can be hidden. Anything else -- working,
 * happy, stressed, or a state this file has never heard of -- is visible, and
 * a hidden flag on it is cleared. "Unknown is not sleeping": hiding on a guess
 * would make a live agent vanish, which is the failure this feature must not
 * be able to cause. So the test for "sleeping" is strict equality with the one
 * string, never "not one of the active states".
 *
 * A hidden name that is NOT on the roster is KEPT. After a restart nobody has
 * been seen yet, and dropping the persisted set at that moment would forget
 * everything the user hid. The name is cleared only when its row shows up awake.
 *
 * ONE RULE, ONE PLACE (Miguel M1, PR #66). host/hidden-agents.js `require`s this
 * file and calls `reconcileHidden` / `cleanNames` / `HIDDEN_NAME_MAX` rather
 * than restating them: the module.exports branch below is what lets it. The
 * host persists and re-broadcasts; the renderer also applies the rule locally
 * so a frame ordering never flashes a wrong row.
 */

(function (root) {

const SLEEPING = 'sleeping';

// The longest agent name either end will act on. The host's control-frame
// check uses this same number (Dexter F4), so the button is never offered for
// a click the host would silently refuse.
const HIDDEN_NAME_MAX = 200;

const nameOf = (v) => (typeof v === 'string' && v && v.length <= HIDDEN_NAME_MAX ? v : null);

/** Rows that are usable: objects with a string name. */
function usableRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object' && nameOf(r.agent));
}

/** Distinct valid names, in first-seen order. */
function cleanNames(names) {
  const out = [];
  for (const n of Array.isArray(names) ? names : []) {
    const name = nameOf(n);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Whether the little hide button is offered on this card. */
function hideButtonFor(row) {
  return !!row && typeof row === 'object' && nameOf(row.agent) !== null && row.state === SLEEPING;
}

/**
 * Drop the hidden flag from every agent whose row is awake. `cleared` lists
 * them so the host can persist the clearing. Idempotent.
 */
function reconcileHidden(hiddenNames, rosterRows) {
  const awake = new Set(usableRows(rosterRows).filter(r => r.state !== SLEEPING).map(r => r.agent));
  const kept = [];
  const cleared = [];
  for (const name of cleanNames(hiddenNames)) {
    (awake.has(name) ? cleared : kept).push(name);
  }
  return { hidden: kept, cleared };
}

/**
 * The rows to draw. A row is left out only if it is sleeping AND named in
 * `hidden`, and only while `showHidden` is not exactly `true`. Awake rows are
 * always in, so a stale set can never hide an active agent.
 */
function visibleRows(rows, hidden, showHidden) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (showHidden === true) return list;
  const hiddenSet = new Set(cleanNames(hidden));
  return list.filter(r => !(r && r.state === SLEEPING && hiddenSet.has(r.agent)));
}

/** How many rows are hidden right now -- the n in "show hidden (n)". */
function hiddenCount(rows, hidden) {
  const list = Array.isArray(rows) ? rows : [];
  return list.length - visibleRows(list, hidden, false).length;
}

/**
 * Read a click on the roster: `{ action, agent }` if `target` is inside a
 * `.agent-hide` button on a named card, else null (Dexter F5, Miguel M3).
 * Every click handler on the roster asks THIS before acting on a card click, so
 * a hide click can never also be an open-the-log click -- the repo forbids
 * stopPropagation on mouse listeners, so the guard is "ask first". Any value
 * other than 'unhide' reads as 'hide': there is no third action to smuggle in.
 */
function rosterActionFromClick(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const btn = target.closest('.agent-hide');
  if (!btn) return null;
  const card = typeof btn.closest === 'function' ? btn.closest('.agent') : null;
  const agent = card && card.dataset ? nameOf(card.dataset.agent) : null;
  if (!agent) return null;
  return { action: btn.dataset && btn.dataset.rosterAction === 'unhide' ? 'unhide' : 'hide', agent };
}

/**
 * Whether the roster's markup has to be replaced (Dexter F1). A `processes`
 * frame arrives every second while anything runs and used to rebuild every
 * card through innerHTML, detaching a button between its mousedown and its
 * mouseup and losing the click. Identical markup is left alone.
 */
function repaintNeeded(lastHtml, nextHtml) {
  return !(typeof lastHtml === 'string' && typeof nextHtml === 'string' && lastHtml === nextHtml);
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system. IIFE-wrapped for the reason in
// CLAUDE.md's first trap (one shared global scope).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    reconcileHidden, visibleRows, hideButtonFor, hiddenCount,
    rosterActionFromClick, repaintNeeded, cleanNames, HIDDEN_NAME_MAX,
  };
} else {
  root.rosterActionFromClick = rosterActionFromClick;
  root.repaintNeeded = repaintNeeded;
  root.reconcileHidden = reconcileHidden;
  root.visibleRows = visibleRows;
  root.hideButtonFor = hideButtonFor;
  root.hiddenCount = hiddenCount;
}

})(typeof window !== 'undefined' ? window : globalThis);
