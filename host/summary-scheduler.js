'use strict';
/**
 * When a tab's "where are we" summary may be refreshed (backlog #39 job 1, DESIGN_SLAVE_MODE_SUMMARY.md decision 3).
 * Pure: the caller passes the time and the power state, and does the work.
 *
 *   createScheduler() -> {
 *     activity(key, at)            this tab has new turns (or just changed on disk)
 *     ready(now, { onBattery })    -> the key whose summary is due now, or null
 *     start(key, now) -> bool      the job begins (refused while another runs)
 *     finish(key, now)             it made a summary
 *     fail(key, now, holdMs)       it didn't (Ollama down): keep waiting, but not before `holdMs` has passed
 *     clean(key, now)              nothing was new after all: no job ran
 *     running() / state(key) / forget(key)
 *   }
 *
 * THE RULES (measured: ~2.5 s of GPU per summary on the 3B model; the GPU is shared by every tab):
 *   - A tab is only ever due if something happened in it (`activity`); an idle tab costs nothing.
 *   - It must have been QUIET for QUIET_MS (the debounce: a streaming turn would otherwise trigger a job every few
 *     seconds), and its last SUMMARY must have started MIN_GAP_MS ago (one per tab per 2 minutes).
 *   - One job at a time. Of the tabs that are due, the one that has waited longest goes first.
 *   - Never on battery. Only a real `true` pauses: an unknown power state (a desktop, a probe that failed) runs.
 *   - A failure or a no-op gives the cap back (no summary was made, no GPU was spent); the hold on a failure is the
 *     only wait, so an Ollama that's down is retried at the caller's pace and not hammered.
 *   - Activity DURING a job keeps the tab waiting; none during it clears it.
 *
 * Every time is strictly a finite number: Number(null) is 0, and a "no value" read as time zero is the confident
 * wrong answer this repo keeps catching.
 */

const QUIET_MS = 25_000;
const MIN_GAP_MS = 120_000;

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isKey = (k) => typeof k === 'string' && k !== '';

function createScheduler() {
  const tabs = new Map();
  let runningKey = null;

  function end(key, now) {
    const st = tabs.get(key);
    if (runningKey !== key || !st) return null;
    runningKey = null;
    // activity at or after the start may not have been seen by the job: keep waiting
    st.dirty = isNum(st.lastActivity) && st.lastActivity >= st.startedAt;
    if (st.dirty) st.dirtySince = st.lastActivity;
    return st;
  }

  return {
    activity(key, at) {
      if (!isKey(key) || !isNum(at)) return;
      let st = tabs.get(key);
      if (!st) {
        st = { dirty: false, dirtySince: null, lastActivity: null, lastStartAt: null, prevStartAt: null, startedAt: null, holdUntil: null };
        tabs.set(key, st);
      }
      if (!st.dirty) { st.dirty = true; st.dirtySince = at; }
      st.lastActivity = at;
    },

    ready(now, { onBattery } = {}) {
      if (!isNum(now) || runningKey !== null || onBattery === true) return null;
      let best = null;
      for (const [key, st] of tabs) {
        if (!st.dirty) continue;
        if (now - st.lastActivity < QUIET_MS) continue;
        if (st.lastStartAt !== null && now - st.lastStartAt < MIN_GAP_MS) continue;
        if (st.holdUntil !== null && now < st.holdUntil) continue;
        if (best === null || st.dirtySince < best.since) best = { key, since: st.dirtySince };
      }
      return best === null ? null : best.key;
    },

    start(key, now) {
      const st = tabs.get(key);
      if (!st || !isNum(now) || runningKey !== null) return false;
      runningKey = key;
      st.startedAt = now;
      st.prevStartAt = st.lastStartAt;
      st.lastStartAt = now;
      return true;
    },

    finish(key, now) {
      const st = end(key, now);
      if (st) st.holdUntil = null;
    },

    fail(key, now, holdMs) {
      const st = end(key, now);
      if (!st) return;
      st.lastStartAt = st.prevStartAt;
      st.dirty = true;
      st.dirtySince = st.dirtySince !== null ? st.dirtySince : st.startedAt;
      st.holdUntil = isNum(holdMs) && holdMs > 0 && isNum(now) ? now + holdMs : null;
    },

    clean(key, now) {
      const st = end(key, now);
      if (st) { st.lastStartAt = st.prevStartAt; st.holdUntil = null; }
    },

    forget(key) {
      tabs.delete(key);
      if (runningKey === key) runningKey = null;
    },

    running: () => runningKey,

    state(key) {
      const st = tabs.get(key);
      return st ? { ...st } : null;
    },
  };
}

module.exports = { createScheduler, QUIET_MS, MIN_GAP_MS };
