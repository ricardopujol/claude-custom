'use strict';
/**
 * When a quota window is used up (BACKLOG #90): the header says when Claude is back, and says "Claude is back" once.
 *
 * Pure decisions, in their own file for the reason app/quota-display.js is: nothing can test a decision that lives inside a
 * browser script. This never touches the session or the CLI; it only reads the quota payload the header already has.
 *
 * ABSENCE IS NEVER A COUNTDOWN, AND UNKNOWN IS NEVER "BACK". Only a fresh `ok` payload (no older than DATA_STALE_MS when it
 * says when it was read) with a window at 100% or more, or locked by the server, AND a future `resetsAt`, is "used up". A
 * missing file, a stale one, an unknown percent, a missing reset time or an empty window list show what the header showed
 * before (the existing unknown state included): never an invented wait, and never the end of one.
 *
 * WHICH WINDOWS SAY "CLAUDE". Only the unscoped windows (the 5-hour and the weekly) are Claude-wide. A model-scoped window
 * (host/quota.js keys it `kind:Model`, e.g. `weekly_scoped:Fable`) blocks that one model, not Claude: it gets its own wording
 * ("Fable back Thu 09:00") and never drives the "Claude back" text or the "Claude is back" toast.
 *
 * ONE TOAST PER EPISODE. An episode starts the first time an unscoped window is seen used up and ends when EVERY window it was
 * waiting on is back: the clock passed that window's reset, or a fresh read shows it under 100% with its reset moved on (the
 * window rolled over). A dip under 100% with the same reset (99.6% then 100% again) is not a reset. The watcher is the memory
 * that makes "once per reset, not once per poll, not once per re-render" true.
 *
 * ONCE MEANS ONCE IT COULD BE SEEN. The toast gate holds a toast while the header is hidden (lean, focus mode, a hidden or
 * minimised window) and shows it the next time the header is visible, unless a newer episode has started by then.
 *
 * WRAPPED IN AN IIFE (CLAUDE.md): plain <script> tags share one global scope.
 */
(function (root) {

// host/quota-share.js DATA_STALE_MS; the renderer cannot require host/, so the number is repeated here (a test pins them equal).
const DATA_STALE_MS = 240000;
// A fresh read whose reset has moved on by more than this is a new window instance, not the same reset reported a second late.
const RESET_MOVED_MS = 60000;
// Inside this the header ticks every second so the seconds show; outside it, every 30 s.
const FINAL_STRETCH_MS = 90000;
const DAY_MS = 24 * 3600000;

// The clock and weekday as app/quota-display.js writes them: one definition for the header and for this.
const clockOf = (typeof module !== 'undefined' && module.exports) ? require('./quota-display') : { clockText: root.quotaClockText, weekdayText: root.quotaWeekdayText };

const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function resetMs(resetsAt) {
  if (typeof resetsAt !== 'string' || resetsAt === '') return null;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * "Claude back in 2h 14m" within a day (minutes; seconds under a minute), "Claude back Thu 09:00" beyond it, and with the date
 * ("Tue 21 Oct 09:00") from six days out so it can't read like today. Rounds UP, so it never reads 0m or 0s while still
 * waiting, never "60s", and never goes negative: null when there is no future time. `who` is "Claude" or a model's name.
 */
function backText(resetsAt, now = Date.now(), who = 'Claude') {
  const at = resetMs(resetsAt);
  if (at === null) return null;
  const ms = at - now;
  if (!(ms > 0)) return null;
  if (ms >= DAY_MS) {
    const d = new Date(at);
    const when = ms >= 6 * DAY_MS
      ? `${clockOf.weekdayText(d)} ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`
      : clockOf.weekdayText(d);
    return `${who} back ${when} ${clockOf.clockText(d)}`;
  }
  if (ms <= 59000) return `${who} back in ${Math.ceil(ms / 1000)}s`;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${who} back in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${who} back in ${h}h ${m}m` : `${who} back in ${h}h`;
}

/** The windows of a payload we may reason about, or null: not ok, no list, or read longer ago than DATA_STALE_MS. */
function usableWindows(quota, now) {
  if (!quota || quota.ok !== true || !Array.isArray(quota.windows)) return null;
  const readAt = finiteOrNull(quota.readAt);
  if (readAt !== null && now - readAt > DATA_STALE_MS) return null;
  return quota.windows.filter(w => w && typeof w === 'object');
}

const isScoped = w => typeof w.key === 'string' && w.key.indexOf(':') > 0;
const isLocked = w => typeof w.lockedReason === 'string' && w.lockedReason !== '';
const isOutByValue = (w) => { const pct = finiteOrNull(w.percent); return isLocked(w) || (pct !== null && pct >= 100); };

/** The reset time (ms) of a window that is used up and still waiting, else null. */
function waitingUntil(w, now) {
  if (!isOutByValue(w)) return null;
  const at = resetMs(w.resetsAt);
  return at !== null && at > now ? at : null;
}

/**
 * `{ state: 'normal' }` or `{ state: 'usedUp', key, resetAtMs, text }` (Claude-wide: the unscoped window that resets last, since
 * Claude is back only when all are; every unscoped window that is out still has its own text in `texts`), plus `texts` (window key -> its "back" wording, scoped windows included) and `soonestMs`
 * (the nearest reset among every window used up, or null) for the tick.
 */
function countdownState(quota, now = Date.now()) {
  const rows = usableWindows(quota, now);
  const texts = {};
  let best = null;
  let soonest = null;
  for (const w of rows || []) {
    const at = waitingUntil(w, now);
    if (at === null) continue;
    soonest = soonest === null ? at : Math.min(soonest, at);
    if (isScoped(w)) texts[w.key] = backText(w.resetsAt, now, typeof w.label === 'string' && w.label ? w.label : 'That model');
    else {
      texts[w.key] = backText(w.resetsAt, now);        // every Claude-wide window that is out says when it is back
      if (best === null || at > best.resetAtMs) best = { key: w.key, resetAtMs: at, resetsAt: w.resetsAt };
    }
  }
  const soonestMs = soonest === null ? null : soonest - now;
  if (best === null) return { state: 'normal', texts, soonestMs };
  const text = texts[best.key];
  return { state: 'usedUp', key: best.key, resetAtMs: best.resetAtMs, text, texts, soonestMs };
}

/** How long until the header next needs a look: every second in the last 90 s of a used-up window, else every 30 s. */
function tickDelayMs(quota, now = Date.now()) {
  const s = countdownState(quota, now);
  return s.soonestMs !== null && s.soonestMs <= FINAL_STRETCH_MS ? 1000 : 30000;
}

/**
 * A window the payload still reports used up but whose reset has passed is not used up any more: the next poll just hasn't said
 * so. It is drawn as unknown (no percent), never as the old red 100% right after "Claude is back". Returns a copy.
 */
function settlePastResets(quota, now = Date.now()) {
  if (!quota || quota.ok !== true || !Array.isArray(quota.windows)) return quota;
  let changed = false;
  const windows = quota.windows.map((w) => {
    if (!w || typeof w !== 'object' || !isOutByValue(w)) return w;
    const at = resetMs(w.resetsAt);
    if (at === null || at > now) return w;
    changed = true;
    return { ...w, percent: null, lockedReason: null, severity: 'normal' };
  });
  return changed ? { ...quota, windows } : quota;
}

/** `see(quota, now)` -> `{ ...countdownState, toast }`; `toast` is true exactly once per used-up episode, on the call that ends it. */
function createResetWatcher() {
  let waits = null;                       // key -> { at, done }; non-null means an episode is open
  function see(quota, now = Date.now()) {
    const s = countdownState(quota, now);
    const rows = usableWindows(quota, now);
    for (const w of rows || []) {
      if (isScoped(w)) continue;
      const at = waitingUntil(w, now);
      if (at === null) continue;
      if (waits === null) waits = new Map();
      waits.set(String(w.key), { at, done: false });
    }
    if (s.state === 'usedUp' || waits === null) return { ...s, toast: false };
    for (const [key, wait] of waits) {
      if (wait.done) continue;
      if (now >= wait.at) { wait.done = true; continue; }
      // Early evidence needs a KNOWN percent under 100 AND a reset that moved on: unknown never ends an episode, and a dip
      // under 100% with the same reset is not a reset.
      const row = (rows || []).find(w => String(w.key) === key);
      if (!row) continue;
      const pct = finiteOrNull(row.percent);
      const at = resetMs(row.resetsAt);
      if (pct !== null && pct < 100 && at !== null && at > wait.at + RESET_MOVED_MS) wait.done = true;
    }
    for (const wait of waits.values()) if (!wait.done) return { ...s, toast: false };
    waits = null;
    return { ...s, toast: true };
  }
  return { see };
}

/**
 * Holds "Claude is back" until the header can show it. `step({ toast, usedUp, visible })` -> true when it should show NOW:
 * the toast the watcher raised (now or earlier) and a visible header. A newer used-up episode drops a held toast (the "back" is
 * stale). Memory only: a reload after the reset starts empty and never replays it.
 */
function createToastGate() {
  let held = false;
  function step({ toast = false, usedUp = false, visible = false } = {}) {
    if (toast) held = true;
    if (usedUp) held = false;
    if (held && visible) { held = false; return true; }
    return false;
  }
  return { step };
}

const api = { backText, countdownState, createResetWatcher, createToastGate, tickDelayMs, settlePastResets, DATA_STALE_MS, FINAL_STRETCH_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.quotaBackText = backText;
  root.quotaCountdownState = countdownState;
  root.createQuotaResetWatcher = createResetWatcher;
  root.createQuotaToastGate = createToastGate;
  root.quotaTickDelayMs = tickDelayMs;
  root.quotaSettlePastResets = settlePastResets;
}

})(typeof window !== 'undefined' ? window : globalThis);
