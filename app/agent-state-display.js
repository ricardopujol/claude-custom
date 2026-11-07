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

// BACKLOG #162: the hover of a stressed card, the host's own sentence (host/stress-cause.js, on the `mood` frame as `cause`). Only a
// stressed card shows one, so a cause that outlived its state is never drawn; nothing to show is '' (the card then has no title).
function causeTitle(state, cause) {
  if (state !== 'stressed' || typeof cause !== 'string') return '';
  return cause.trim();
}

// BACKLOG #142 b: the cards one roster row draws. Two or more instances of one agent (the host's `instances`, host/mood-machine.js
// instancesOf) are one card each: the row's name, entry and portrait, with the instance's own state, detail, cause, wait and
// portrait, and its id as `instance`. The name's own cause and wait never leak onto an instance card. A row with fewer than two
// well-formed instances is its one card, unchanged (an older host sends none).
const goodInstance = (i) => !!i && typeof i === 'object' && typeof i.id === 'string' && i.id !== '' && typeof i.state === 'string';
function instanceRows(row) {
  const list = row && Array.isArray(row.instances) ? row.instances.filter(goodInstance) : [];
  if (list.length < 2) return [row];
  const { instances, cause, wait, ...base } = row;
  return list.map((i) => {
    const card = { ...base, instance: i.id, state: i.state, detail: typeof i.detail === 'string' ? i.detail : i.state,
      portrait: i.portrait && typeof i.portrait === 'object' ? i.portrait : base.portrait };
    if (typeof i.cause === 'string') card.cause = i.cause;
    if (i.wait && typeof i.wait === 'object') card.wait = i.wait;
    // PR #239 Dexter 4: a finish still flashing offers no Pause, and a live card's Pause names its own run.
    if (i.ended === true) card.ended = true;
    if (typeof i.agentId === 'string' && i.agentId !== '') card.agentId = i.agentId;
    return card;
  });
}

// BACKLOG #155's minute count ticks while some card waits on its background work: a name row's detail, or one of its instance
// cards' (#142 b), since a sibling's reading or helper outranks the wait on the name's own detail (PR #239 Miguel S3).
const WAITING_DETAILS = new Set(['bgwait', 'bgwaitlate']);
function anyWaiting(rows) {
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    if (WAITING_DETAILS.has(r.detail)) return true;
    if (Array.isArray(r.instances) && r.instances.some((i) => i && WAITING_DETAILS.has(i.detail))) return true;
  }
  return false;
}

// PR #239 Dexter 5 / Miguel Y5: what a roster repaint replaces. `old` and `fresh` are the cards in order, each { key, html }: `key`
// is data-agent + "|" + data-instance (null for a node that isn't a card), `html` the markup it was painted from (undefined when
// unknown). The same cards in the same places: replace only those whose markup changed, so an unchanged card keeps its node (a
// press on its button, a hover on it, its video survive a sibling's repaint). Anything else (a card came, went or moved, a
// non-card node, an empty roster) is a full replace, as before. The full fix for a press on a card that DID change is BACKLOG #184.
function rosterPatch(old, fresh) {
  const a = Array.isArray(old) ? old : [];
  const b = Array.isArray(fresh) ? fresh : [];
  if (a.length === 0 || a.length !== b.length) return { full: true };
  for (let i = 0; i < b.length; i++) if (b[i].key == null || a[i].key !== b[i].key) return { full: true };
  const replace = [];
  for (let i = 0; i < b.length; i++) if (a[i].html === undefined || a[i].html !== b[i].html) replace.push(i);
  return { full: false, replace };
}

const agentStateDisplay = { describeState, badgeHtml, stateWords, sortRows, waitNote, waitNoteHtml, causeTitle, instanceRows, rosterPatch, anyWaiting, FINER_STATES: Object.keys(FINER) };

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module system.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { agentStateDisplay };
} else {
  root.agentStateDisplay = agentStateDisplay;
}

})(typeof window !== 'undefined' ? window : globalThis);
