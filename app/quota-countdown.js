'use strict';
/**
 * When a quota window is used up (BACKLOG #90): the header says when Claude is back, and says "Claude is back" once.
 *
 * Pure decisions, in their own file for the reason app/quota-display.js is: nothing can test a decision that lives inside a
 * browser script. This never touches the session or the CLI; it only reads the quota payload the header already has.
 *
 * ABSENCE IS NEVER A COUNTDOWN. Only a fresh `ok` payload with a window at 100% or more AND a future `resetsAt` is "used up".
 * No file, a stale file, an unknown percent, a missing reset time: all "normal", so the header shows what it showed before
 * (the existing unknown state included), never an invented wait.
 *
 * ONE TOAST PER EPISODE. An episode starts the first time a window is seen used up and ends when Claude is back: fresh data
 * with nothing used up, or the clock passing the reset we were told about (so a stale file or a closed laptop still gets its
 * toast, once). The watcher is the memory that makes "once per reset, not once per poll, not once per re-render" true.
 *
 * WRAPPED IN AN IIFE (CLAUDE.md): plain <script> tags share one global scope.
 */
(function (root) {

const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function resetMs(resetsAt) {
  if (typeof resetsAt !== 'string' || resetsAt === '') return null;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) ? at : null;
}

const pad2 = n => String(n).padStart(2, '0');

/**
 * "Claude back in 2h 14m" within a day (minutes; seconds under a minute), "Claude back Thu 09:00" beyond it.
 * Rounds UP, so it never reads 0m or 0s while still waiting, and never goes negative: null when there is no future time.
 */
function backText(resetsAt, now = Date.now()) {
  const at = resetMs(resetsAt);
  if (at === null) return null;
  const ms = at - now;
  if (!(ms > 0)) return null;
  if (ms >= 24 * 3600000) {
    const d = new Date(at);
    return `Claude back ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (ms < 60000) return `Claude back in ${Math.ceil(ms / 1000)}s`;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `Claude back in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `Claude back in ${h}h ${m}m` : `Claude back in ${h}h`;
}

/** `{ state: 'normal' }` or `{ state: 'usedUp', key, resetAtMs, text }` for the window that resets last (Claude is back when all are). */
function countdownState(quota, now = Date.now()) {
  if (!quota || quota.ok !== true || !Array.isArray(quota.windows)) return { state: 'normal' };
  let best = null;
  for (const w of quota.windows) {
    if (!w || typeof w !== 'object') continue;
    const pct = finiteOrNull(w.percent);
    const at = resetMs(w.resetsAt);
    if (pct === null || pct < 100 || at === null || at <= now) continue;
    if (best === null || at > best.resetAtMs) best = { key: w.key, resetAtMs: at, resetsAt: w.resetsAt };
  }
  if (best === null) return { state: 'normal' };
  return { state: 'usedUp', key: best.key, resetAtMs: best.resetAtMs, text: backText(best.resetsAt, now) };
}

/** `see(quota, now)` -> `{ ...countdownState, toast }`; `toast` is true exactly once per used-up episode, on the call that ends it. */
function createResetWatcher() {
  let pendingAt = null;           // the latest reset time seen while used up; non-null means an episode is open
  function see(quota, now = Date.now()) {
    const s = countdownState(quota, now);
    if (s.state === 'usedUp') {
      pendingAt = pendingAt === null ? s.resetAtMs : Math.max(pendingAt, s.resetAtMs);
      return { ...s, toast: false };
    }
    let toast = false;
    if (pendingAt !== null) {
      const freshRead = !!quota && quota.ok === true && Array.isArray(quota.windows);
      // Absence ends it only by the clock; a fresh read with nothing used up ends it now.
      if (freshRead || now >= pendingAt) { toast = true; pendingAt = null; }
    }
    return { ...s, toast };
  }
  return { see };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { backText, countdownState, createResetWatcher };
} else {
  root.quotaBackText = backText;
  root.quotaCountdownState = countdownState;
  root.createQuotaResetWatcher = createResetWatcher;
}

})(typeof window !== 'undefined' ? window : globalThis);
