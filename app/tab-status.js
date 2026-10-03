'use strict';
/**
 * What one tab's renderer tells the shell about itself (PR 2, worktree tabs).
 *
 *   tabStatus({ mainMood, pendingUrgent, pendingFinished, lock, health }, { healthMarker })
 *       -> { working, needsInput, finished, lock, health }
 *   afterSelected(status)   the shell's `tab-selected` event clears needsInput
 *   sameStatus(a, b)        strict field-by-field equality, so the renderer
 *                           doesn't re-send an unchanged status
 *
 * `healthMarker` is INJECTED so this file doesn't depend on script load
 * order: the renderer passes `worktreeStatus.healthMarker`
 * (app/worktree-status-display.js). `health` in the result is that marker's
 * TEXT (`↓3` / `+12`) or null.
 *
 * Absence is never a confident value: an unknown or missing lock is `null`,
 * never `'held'`; no health marker is `null`.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `tabStatus`.
 */
(function (root) {

const LOCK_STATES = ['held', 'unlocked', 'blocked', 'override', 'pending'];

function tabStatus(inputs, { healthMarker } = {}) {
  const i = inputs || {};
  const lockState = i.lock && typeof i.lock.state === 'string' ? i.lock.state : null;
  let health = null;
  if (typeof healthMarker === 'function') {
    const marker = healthMarker(i.health);
    if (marker && typeof marker.text === 'string' && marker.text !== '') health = marker.text;
  }
  return {
    working: i.mainMood === 'working',
    needsInput: i.pendingUrgent === true,
    // #31: the session finished (a non-urgent attention message) and nobody has looked yet.
    finished: i.pendingFinished === true,
    lock: LOCK_STATES.includes(lockState) ? lockState : null,
    health,
  };
}

/** The same status with the urgent and finished flags cleared (the tab was just selected). */
function afterSelected(status) {
  return { ...status, needsInput: false, finished: false };
}

function sameStatus(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return a.working === b.working &&
    a.needsInput === b.needsInput &&
    a.finished === b.finished &&
    a.lock === b.lock &&
    a.health === b.health;
}

const api = { tabStatus, afterSelected, sameStatus };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabStatus = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
