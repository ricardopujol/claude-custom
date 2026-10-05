'use strict';
/**
 * The tab warning's counter (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "Warning on a tab"). Pure state
 * machine, one per session: a session whose tree holds at least 40% of the machine's CPU for three consecutive
 * 10 s samples (30 s) is on, amber, and red from 75%. It clears after ONE sample below 40%: it shows up slowly
 * and clears quickly, so a finished run stops warning at once.
 *
 * A sample with no figure (null: the first sample, a failed one) changes nothing. Nothing measured is neither a
 * warning nor the end of one.
 */

const THRESHOLD = 40;
const RED = 75;
const NEEDED = 3;

const initial = () => ({ over: 0, on: false, level: null, pct: null });

function step(state, pct, { threshold = THRESHOLD, needed = NEEDED } = {}) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return state;
  const over = pct >= threshold ? state.over + 1 : 0;
  const on = over >= needed;
  return { over, on, level: on ? (pct >= RED ? 'red' : 'amber') : null, pct };
}

/** A copy of `states` (a Map keyed by session) holding only the keys in `live` (a Set). */
function prune(states, live) {
  const out = new Map();
  for (const [key, st] of states) if (live.has(key)) out.set(key, st);
  return out;
}

module.exports = { initial, step, prune, THRESHOLD, RED, NEEDED };
