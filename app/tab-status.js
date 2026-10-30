'use strict';
/**
 * What one tab's renderer tells the shell about itself (PR 2, worktree tabs).
 *
 *   tabStatus({ mainMood, pendingUrgent, pendingFinished, lock, health, turn, night, summary, program }, { healthMarker, cleanProgram })
 *       -> { working, needsInput, finished, lock, health, turn, night, summary }
 *   cleanSummary(s)         the tab's "where are we" summary (backlog #39) as { text, model, at, stale, note }, or null
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
 * `summary` is the local model's "where are we" for the strip's hover card: only a usable one (words, a model, a real
 * time), else null. It changes rarely (once per summary), so the status isn't re-sent for its age: the strip works
 * that out when it paints.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `tabStatus`.
 */
(function (root) {

const LOCK_STATES = ['held', 'unlocked', 'blocked', 'override', 'pending'];
const TURNS = ['idle', 'turn', 'prompt'];
const SUMMARY_TEXT_MAX = 2000;
const SUMMARY_NOTE_MAX = 300;

const COUNT_MAX = 99;
/** A held-message count (BACKLOG #156): a whole number 0..99, else 0. Absence is never a number, so nothing drawn. */
const cleanCount = (n) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= COUNT_MAX ? n : 0);

const str = (s, max) => (typeof s === 'string' && s !== '' && s.length <= max ? s : null);

/** { text, model, at, stale, note } or null; every field checked, the rest dropped (a status comes from a renderer). */
function cleanSummary(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const text = str(s.text, SUMMARY_TEXT_MAX);
  const model = str(s.model, 100);
  if (text === null || text.trim() === '' || model === null || typeof s.at !== 'number' || !Number.isFinite(s.at)) return null;
  return { text, model, at: s.at, stale: s.stale === true, note: str(s.note, SUMMARY_NOTE_MAX) };
}

const sameSummary = (a, b) => (a === null || b === null
  ? a === b
  : a.text === b.text && a.model === b.model && a.at === b.at && a.stale === b.stale && a.note === b.note);

function tabStatus(inputs, { healthMarker, cleanProgram } = {}) {
  const i = inputs || {};
  // OSC 7501 (BACKLOG #116): the CLI's own state. INJECTED like healthMarker; with no cleaner a raw record is never trusted.
  const program = typeof cleanProgram === 'function' ? cleanProgram(i.program) : null;
  const lockState = i.lock && typeof i.lock.state === 'string' ? i.lock.state : null;
  let health = null;
  if (typeof healthMarker === 'function') {
    const marker = healthMarker(i.health);
    if (marker && typeof marker.text === 'string' && marker.text !== '') health = marker.text;
  }
  return {
    // The CLI saying it is working counts, but never makes a working roster look idle: a union, not a replacement
    // (the Git drawer reads this to decide whether the session is at rest).
    working: i.mainMood === 'working' || (program !== null && program.state === 'working'),
    needsInput: i.pendingUrgent === true,
    // #31: the session finished (a non-urgent attention message) and nobody has looked yet.
    finished: i.pendingFinished === true,
    // #156: cross-session messages held for approval in this tab, not yet looked at.
    messages: cleanCount(i.pendingMessages),
    lock: LOCK_STATES.includes(lockState) ? lockState : null,
    health,
    turn: TURNS.includes(i.turn) ? i.turn : null,
    night: i.night === true,
    summary: cleanSummary(i.summary),
    // why there is no summary (Ollama off), for the hover card; the page sends it only while there is none
    summaryNote: str(i.summaryNote, SUMMARY_NOTE_MAX),
    program,
  };
}

/** The same status with the urgent and finished flags cleared (the tab was just selected). */
function afterSelected(status) {
  return { ...status, needsInput: false, finished: false, messages: 0 };
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
    // OSC 7501: the CLI went back to work or rest, so what it was blocked on was answered (a finished turn is kept).
    case 'answered': return { ...cur, urgent: false };
    default: return cur;
  }
}

const sameProgram = (a, b) => (a === null || b === null
  ? a === b
  : a.state === b.state && a.kind === b.kind && a.msg === b.msg && a.progress === b.progress);

function sameStatus(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return a.working === b.working &&
    a.needsInput === b.needsInput &&
    a.finished === b.finished &&
    cleanCount(a.messages) === cleanCount(b.messages) &&
    a.lock === b.lock &&
    a.health === b.health &&
    a.turn === b.turn &&
    a.night === b.night &&
    sameProgram(a.program === undefined ? null : a.program, b.program === undefined ? null : b.program) &&
    sameSummary(a.summary === undefined ? null : a.summary, b.summary === undefined ? null : b.summary) &&
    (a.summaryNote === undefined ? null : a.summaryNote) === (b.summaryNote === undefined ? null : b.summaryNote);
}

const api = { tabStatus, afterSelected, sameStatus, pendingAfter, cleanSummary, cleanCount, TURNS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabStatus = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
