'use strict';
/**
 * What one tab's renderer tells the shell about itself (PR 2, worktree tabs).
 *
 *   tabStatus({ mainMood, pendingUrgent, pendingFinished, lock, health, turn, night }, { healthMarker })
 *       -> { working, needsInput, finished, lock, health, turn, night }
 *   afterSelected(status)   the shell's `tab-selected` event clears needsInput
 *   pendingAfter(p, event)  the page's { urgent, finished } after an event (#31)
 *   sameStatus(a, b)        strict field-by-field equality, so the renderer
 *                           doesn't re-send an unchanged status
 *
 * `healthMarker` is INJECTED so this file doesn't depend on script load
 * order: the renderer passes `worktreeStatus.healthMarker`
 * (app/worktree-status-display.js). `health` in the result is that marker's
 * TEXT (`↓3` / `+12`) or null.
 *
 * Absence is never a confident value: an unknown or missing lock is `null`,
 * never `'held'`; no health marker is `null`. `turn` is the HOST's measure of the main session
 * (host/turn-state.js: 'idle' | 'turn' | 'prompt'), or null when it hasn't said -- never a guessed idle.
 * A look clears needsInput (attention), never `turn` (PR #93 Dexter F2: a dialog stays open after a glance).
 * `night` is the host's word that a /bedtime night is on (host/bedtime-state.js, backlog #52): only a real `true`.
 * It is the run's, not something waiting for you, so a look never clears it.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `tabStatus`.
 */
(function (root) {

const LOCK_STATES = ['held', 'unlocked', 'blocked', 'override', 'pending'];
const TURNS = ['idle', 'turn', 'prompt'];

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
    turn: TURNS.includes(i.turn) ? i.turn : null,
    night: i.night === true,
  };
}

/** The same status with the urgent and finished flags cleared (the tab was just selected). */
function afterSelected(status) {
  return { ...status, needsInput: false, finished: false };
}

/**
 * What the page is holding for you, `{ urgent, finished }`, after an event:
 *   urgent    a session that needs you (an urgent attention message)
 *   finished  a finished turn: clears a pending urgent need (it was answered, e.g.
 *             over Remote Control, so "finished" is the honest look)
 *   working   a turn STARTED: "done, come look" is no longer true
 *   looked    the tab was selected and focused
 * Only a real `true` is pending; an unknown event changes nothing.
 */
function pendingAfter(pending, event) {
  const cur = { urgent: !!pending && pending.urgent === true, finished: !!pending && pending.finished === true };
  switch (event) {
    case 'urgent': return { ...cur, urgent: true };
    case 'finished': return { urgent: false, finished: true };
    case 'working': return { ...cur, finished: false };
    case 'looked': return { urgent: false, finished: false };
    default: return cur;
  }
}

function sameStatus(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return a.working === b.working &&
    a.needsInput === b.needsInput &&
    a.finished === b.finished &&
    a.lock === b.lock &&
    a.health === b.health &&
    a.turn === b.turn &&
    a.night === b.night;
}

const api = { tabStatus, afterSelected, sameStatus, pendingAfter, TURNS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabStatus = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
