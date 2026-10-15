'use strict';
/**
 * The Ask explainer as a roster member (BACKLOG #33 gamification, DESIGN_ASK_REPO.md "Gamification, rounds G1-G2"). Pure rules, drawn by
 * renderer.js and app/ask-display.js and tested without a DOM, the same split as app/roster-tabs-display.js.
 *
 * The explainer is ONE per person, so everything that belongs to it (its medals, its counts) is keyed by the fixed id `AGENT`, never by
 * its name: a rename changes what the card says and nothing else. Its live state comes from the host as a `frame`
 * ({ state, detail, panels, counts, portrait }, host/ask-explainer.js + host/ask-counts.js); the card uses the AGENTS' display for it
 * (app/agent-state-display.js: the same four states, ring and corner badge), adding only its own words for what it is doing.
 *
 * Absence is not zero: a frame without usable counts has `counts: null`, drawn as a dash, and a host that has not spoken puts the
 * explainer nowhere (not "asleep").
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askExplainerDisplay`.
 */
(function (root) {

const node = typeof module !== 'undefined' && module.exports;
const ASD = node ? require('./agent-state-display').agentStateDisplay : root.agentStateDisplay;
const RS = node ? require('./roster-search-display') : root.rosterSearchDisplay;

const AGENT = 'ask-explainer';
const ROLE = 'Ask the repo';
const TAG = 'local helper';
// the agents' four, and 'resting': awake and calm between its work and sleep (host/ask-explainer.js; an agent's card has no such state)
const BASE_STATES = Object.freeze(['sleeping', 'working', 'happy', 'stressed', 'resting']);
// What the card says under the name while the explainer works (the agents say "reading" / "writing").
const WORDS = Object.freeze({ reading: 'searching', writing: 'writing the explanation' });

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// Strict: `Number(null)` is 0, and 0 is a confident wrong answer.
const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** The host's frame, cleaned; null when it isn't one (and then the explainer is simply not drawn). */
function frameOf(raw) {
  if (!isObj(raw) || !BASE_STATES.includes(raw.state) || typeof raw.detail !== 'string' || !isCount(raw.panels)) return null;
  const counts = isObj(raw.counts) && isCount(raw.counts.questions) && isCount(raw.counts.places)
    ? { questions: raw.counts.questions, places: raw.counts.places } : null;
  return { state: raw.state, detail: raw.detail, panels: raw.panels, counts, portrait: isObj(raw.portrait) ? raw.portrait : null };
}

const named = (profile) => isObj(profile) && profile.named === true && typeof profile.name === 'string' && profile.name !== '';

/** 'active' while an Ask panel is open in some window, 'inactive' otherwise, null while it isn't on the roster (unnamed, or no frame yet). */
function tabFor(frame, profile) {
  if (!frame || !named(profile)) return null;
  return frame.panels > 0 ? 'active' : 'inactive';
}

/**
 * Whether an Ask panel is docked in this window's layout (Ricardo: Active = "docked anywhere", even behind another tab or on the rail; only a
 * hidden or closed panel is not). null when the layout isn't known: unknown is not "hidden".
 */
// 'ask' is the dock module's id, not the explainer's agent id
function docked(layout) {
  if (!isObj(layout)) return null;
  if (layout.hidden === undefined) return true;
  return Array.isArray(layout.hidden) ? !layout.hidden.includes('ask')   : null;
}

/** The Active tab's row: shaped like an agent's, so agentStateDisplay.sortRows orders it with them. */
function row(frame, profile) {
  if (tabFor(frame, profile) !== 'active') return null;
  return { agent: AGENT, state: frame.state, detail: frame.detail, portrait: frame.portrait, explainer: true };
}

/** The agents' own description of the state, with the explainer's words for reading and writing. */
function look(state, detail) {
  const l = ASD.describeState(state, detail);
  return Object.hasOwn(WORDS, l.detail) ? { ...l, words: WORDS[l.detail] } : l;
}

const plural = (n, one, many) => (n === 1 ? one : many);
/** "142 questions · 318 places opened", or null when the counts are unknown. */
function countsText(counts) {
  if (!isObj(counts) || !isCount(counts.questions) || !isCount(counts.places)) return null;
  return `${counts.questions} ${plural(counts.questions, 'question', 'questions')} · ${counts.places} ${plural(counts.places, 'place', 'places')} opened`;
}

const COUNTS_TITLE = 'Questions it answered and places you opened from it, on this PC across every project';
function countsHtml(counts) {
  const text = countsText(counts);
  if (text === null) return '<div class="career career-unknown" title="Couldn\'t read the counts just now">—</div>';
  return `<div class="career explainer-counts" title="${esc(COUNTS_TITLE)}">${esc(text)}</div>`;
}

const tagHtml = () => `<span class="agent-tag" title="Runs on this computer, not a Claude agent">${esc(TAG)}</span>`;

/** What the roster's name line and search know about it: its name is the persona, its role is fixed. */
const entry = (profile) => ({ persona: named(profile) ? profile.name : null, fn: TAG });
const matches = (profile, query) => RS.matches(ROLE, entry(profile), query);

/** The picture its card shows: the agent's own picture when the naming card picked one, else the explainer's own. */
function portraitFor(profile, frame, lookupAgent) {
  const own = frame ? frame.portrait : null;
  const pick = isObj(profile) && isObj(profile.portrait) && profile.portrait.kind === 'agent' ? profile.portrait.agent : null;
  if (pick && typeof lookupAgent === 'function') {
    const p = lookupAgent(pick);
    if (isObj(p)) return p;
  }
  return own;
}

/** The explainer's log/detail page: its counts (the medal shelf is drawn under it by the renderer, as for an agent). */
function logPageHtml({ name, counts } = {}) {
  const head = '<div class="alog-head"><button type="button" class="alog-close" data-agent-log-close title="Close">&larr;</button>'
    + `<span class="alog-title" title="${esc(name)}">${esc(name)} · ${esc(ROLE)}</span><span class="alog-status">${esc(TAG)}</span></div>`;
  const body = isObj(counts) && isCount(counts.questions) && isCount(counts.places)
    ? `<div class="explainer-stats"><div class="explainer-stat"><b>${counts.questions}</b> ${plural(counts.questions, 'question', 'questions')} answered</div>`
      + `<div class="explainer-stat"><b>${counts.places}</b> ${plural(counts.places, 'place', 'places')} opened</div>`
      + `<div class="alog-none">${esc(COUNTS_TITLE)}.</div></div>`
    : '<div class="explainer-stats"><div class="alog-none">Couldn\'t read the counts just now. Trying again.</div></div>';
  return `${head}<div class="alog-body">${body}</div>`;
}

const API = { AGENT, ROLE, TAG, WORDS, frameOf, tabFor, docked, row, look, countsText, countsHtml, tagHtml, entry, matches, portraitFor, logPageHtml };
if (node) module.exports = API;
else root.askExplainerDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
