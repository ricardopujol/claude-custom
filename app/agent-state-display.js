'use strict';
/**
 * How a roster card shows the finer states of BACKLOG #55 (look A, Ricardo 2026-10-09): a small badge on the
 * portrait's corner, and the state in words under the name. host/mood-machine.js decides WHICH state; this
 * decides what it looks like, so the card only draws what comes back.
 *
 * `state` is the four the card always had (sleeping, working, happy, stressed) and keeps its ring. `detail` is the
 * finer name the host sends beside it. A host that sends none (an older one) shows the state; a detail that does
 * not fit the state is not drawn -- the display never claims more than the host said.
 *
 * WRAPPED IN AN IIFE, and that is not style -- see app/career-display.js's own header. The renderer loads every
 * script as a plain <script> tag sharing ONE global scope, so ONE name leaves this file: `agentStateDisplay`.
 */

(function (root) {

const BASE = new Set(['sleeping', 'working', 'happy', 'stressed']);

// icon: the corner badge; label: the words under the name. The four base states have neither badge nor
// different words: their ring is their look.
const FINER = {
  reading: { icon: '\u{1F4D6}', label: 'reading' },
  writing: { icon: '✏️', label: 'writing' },
  running: { icon: '▶️', label: 'running' },
  waiting: { icon: '✋', label: 'waiting on you' },
  stuck: { icon: '⚠️', label: 'stuck' },
  helper: { icon: '⏳', label: 'waiting on helper' },
  // BACKLOG #155: waiting on background work it launched (host/mood-machine.js bgwait); red from 30 minutes (bgwaitlate).
  bgwait: { icon: '⌛', label: 'waiting…' },
  bgwaitlate: { icon: '⌛', label: 'waiting…' },
};

// Which finer names fit which state. A tool name (reading, writing, running) only tells you what a WORKING agent is
// doing: after an error the card says stressed. The other three hold either way, as in host/mood-machine.js.
const FITS = {
  working: new Set(['reading', 'writing', 'running', 'waiting', 'stuck', 'helper', 'bgwait', 'bgwaitlate']),
  stressed: new Set(['waiting', 'stuck', 'helper', 'bgwait', 'bgwaitlate']),
};

function describeState(state, detail) {
  if (typeof state !== 'string' || !BASE.has(state)) {
    // Not ours to relabel ('inactive', or something a newer host invented).
    return { state, detail: state, words: typeof state === 'string' ? state : '', badge: null };
  }
  const fine = typeof detail === 'string' && Object.hasOwn(FINER, detail) && FITS[state] && FITS[state].has(detail) ? detail : state;
  const meta = fine === state ? null : FINER[fine];
  return { state, detail: fine, words: meta ? meta.label : state, badge: meta ? { icon: meta.icon, label: meta.label } : null };
}

// The roster order: a card waiting on you first (Ricardo, #55), then by base state (working, stressed, happy, sleeping), then by name.
// Among several waiting cards the same order holds. Returns a new array.
// 'resting' is the Ask explainer's awake-and-calm state (app/ask-explainer-display.js): after happy, before sleeping. No agent card has it.
const STATE_RANK = { working: 0, stressed: 1, happy: 2, resting: 2.5, sleeping: 3 };
function sortRows(rows) {
  const waiting = (r) => describeState(r.state, r.detail).detail === 'waiting';
  const rank = (r) => (Object.hasOwn(STATE_RANK, r.state) ? STATE_RANK[r.state] : 9);
  return [...rows].sort((a, b) => (waiting(b) - waiting(a)) || (rank(a) - rank(b)) || String(a.agent).localeCompare(String(b.agent)));
}

const stateWords = (state, detail) => describeState(state, detail).words;

// The line under "waiting…" (BACKLOG #155): what it waits on and the minutes waited, e.g. `on: npm test · 7 min`. `wait` is the host's
// { on, since }; an unknown is left out, never shown as a number (a missing `since` is no minutes, not 0). Null for any other detail.
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
function waitNote(detail, wait, now) {
  if (detail !== 'bgwait' && detail !== 'bgwaitlate') return null;
  const w = wait && typeof wait === 'object' ? wait : {};
  const parts = [];
  if (typeof w.on === 'string' && w.on !== '') parts.push('on: ' + w.on);
  if (finite(w.since) && finite(now) && now >= w.since) {
    const mins = Math.floor((now - w.since) / 60000);
    parts.push(mins < 1 ? '<1 min' : mins + ' min');
  }
  return { text: parts.join(' · '), late: detail === 'bgwaitlate' };
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

// The corner badge. Decoration for the eye: the words under the name carry the same fact for a screen reader.
function badgeHtml(state, detail) {
  const { detail: d, badge } = describeState(state, detail);
  if (!badge) return '';
  return `<span class="state-badge" data-badge="${esc(d)}" title="${esc(badge.label)}" aria-hidden="true">${badge.icon}</span>`;
}

function waitNoteHtml(detail, wait, now) {
  const note = waitNote(detail, wait, now);
  if (!note || note.text === '') return '';
  return `<div class="wait-note" data-late="${note.late}">${esc(note.text)}</div>`;
}

const agentStateDisplay = { describeState, badgeHtml, stateWords, sortRows, waitNote, waitNoteHtml, FINER_STATES: Object.keys(FINER) };

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module system.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { agentStateDisplay };
} else {
  root.agentStateDisplay = agentStateDisplay;
}

})(typeof window !== 'undefined' ? window : globalThis);
