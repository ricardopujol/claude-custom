'use strict';
/**
 * The "where are we" summary's display rules (backlog #39 job 1, documentation/DESIGN_SLAVE_MODE_SUMMARY.md decision 4).
 * Pure: the page paints what these say, in the terminal bar (app/terminal-bar.js) and on the tab strip's hover card.
 *
 *   panelModel({ summary, off, now, openedAt, pinned, typed }) -> { label, lines, note, dim, pinned } | null
 *   openOnSelect({ summary, off, lastInputAt, now })           does switching to this tab open the panel?
 *   untouchedLongEnough(lastInputAt, now) / lastTouchedAt(...times)
 *   labelOf(summary, now) / offNote(off) / hoverLines(summary, now) / hasContent(summary, off)
 *
 * THE RULE (Ricardo's job, 2026-10-02: "once I switch to a session I haven't touched in a while, I can quickly read
 * where we're at"): switching to a tab untouched for UNTOUCHED_MS opens the panel, which stays until the first
 * keystroke or SHOW_MS. A click pins it open (it then survives typing and the clock); Esc closes it.
 *
 * TRUTH RULES
 *   - It is always labelled "local model · <model> · <age>": never mistaken for Claude's words.
 *   - A summary read back from before a restart says it hasn't been refreshed, and is dimmed. When Ollama or the model
 *     is missing that is SAID beside the last summary (or alone, when there is none): never a silent empty state.
 *   - Absence is never a value: nothing to say is no panel, an unknown touch time is unknown (a tab nobody has typed
 *     in this run counts as untouched), a missing time is not time zero (Number(null) is 0), and a clock that ran
 *     backwards hides an open panel rather than keeping it up.
 *   - The words are a model's: the painter sets textContent, never innerHTML.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js): the page loads this as a plain <script> that shares one
 * global scope. One name leaves it: `summaryDisplay`. It needs `terminalBar` (loaded first) for the age label.
 */
(function (root) {

const bar = typeof module !== 'undefined' && module.exports ? require('./terminal-bar') : root.terminalBar;

const MIN = 60_000;
const UNTOUCHED_MS = 10 * MIN;
const SHOW_MS = 30_000;
const MAX_LINES = 5;
const REASONS = ['ollama-down', 'model-missing', 'failed'];

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isStr = (s) => typeof s === 'string' && s !== '';
const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

function validSummary(s) {
  return isObject(s) && isStr(s.text) && s.text.trim() !== '' && isNum(s.at) && isStr(s.model) ? s : null;
}
function validOff(o) {
  return isObject(o) && REASONS.includes(o.reason) ? o : null;
}

const hasContent = (summary, off) => validSummary(summary) !== null || validOff(off) !== null;

/** "local model · llama3.2:3b · 4 min ago", plus "not refreshed yet" for one read back from before a restart. */
function labelOf(summary, now) {
  const s = validSummary(summary);
  if (!s) return 'local model';
  // a clock that ran backwards has no age: say so, so the third part is never silently missing (Miguel S2)
  const age = bar.ageLabel(s.at, now) || 'time unknown';
  return ['local model', s.model, age, s.stale === true ? 'not refreshed yet' : null].filter(Boolean).join(' · ');
}

/** What is wrong, in plain words, or null when nothing is. */
function offNote(off) {
  const o = validOff(off);
  if (!o) return null;
  const model = isStr(o.model) ? o.model : 'the model';
  if (o.reason === 'ollama-down') return "Local summary off: Ollama isn't running";
  if (o.reason === 'model-missing') return `Local summary off: model not installed. Run: ollama pull ${model}`;
  return `Local summary: the last try failed (${isStr(o.detail) ? o.detail : 'unknown'}). It'll try again`;
}

// Controls, bidi overrides and zero-width characters never reach the page or the native tooltip (Miguel I3, PR #105).
const INVISIBLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const linesOf = (text) => String(text).split(/\r?\n/).map(l => l.replace(INVISIBLES, '').trim()).filter(l => l !== '').slice(0, MAX_LINES);

/** Has this tab gone untouched long enough? A time that isn't known counts: nobody has typed in it this run. */
function untouchedLongEnough(lastInputAt, now) {
  if (!isNum(now)) return false;
  if (!isNum(lastInputAt)) return true;
  return now - lastInputAt >= UNTOUCHED_MS;
}

/** The newest of the times that ARE numbers; null when none is. */
function lastTouchedAt(...times) {
  let best = null;
  for (const t of times) if (isNum(t) && (best === null || t > best)) best = t;
  return best;
}

// Only a summary opens the panel (Miguel I1, PR #105). Ollama off with no summary ever made is said on the tab's hover
// card; popping the bar up for it on every idle-tab switch would nag someone who never wanted the feature.
function openOnSelect({ summary, lastInputAt, now } = {}) {
  return validSummary(summary) !== null && untouchedLongEnough(lastInputAt, now);
}

function panelModel({ summary, off, now, openedAt, pinned, typed } = {}) {
  const s = validSummary(summary);
  const o = validOff(off);
  if (!s) return null;
  const pin = pinned === true;
  const within = isNum(openedAt) && isNum(now) && typed !== true && now >= openedAt && now - openedAt < SHOW_MS;
  if (!pin && !within) return null;
  return {
    label: labelOf(s, now),
    lines: linesOf(s.text),
    note: offNote(o),
    dim: s.stale === true || o !== null,
    pinned: pin,
  };
}

/**
 * The tab strip's hover lines for a tab's summary (`summary.note`: why it may be out of date). With no summary, `note`
 * (why there is none: Ollama off) is the whole card; nothing at all when neither exists.
 */
function hoverLines(summary, now, note) {
  const s = validSummary(summary);
  if (!s) return isStr(note) ? [note] : [];
  const own = isStr(summary.note) ? [summary.note] : [];
  return [`Where we're at (${labelOf(s, now)}):`, ...linesOf(s.text), ...own];
}

/**
 * What the page holds about the panel after the host pushed `summary` (Dexter F7, PR #105): the pin, the open time and the
 * typed flag belong to the summary they were made for. When it goes away (/clear) or is another session's, they are
 * released, so a later push can never surface a pinned panel under the person's hands. -> { openedAt, pinned, typed, session }
 */
function afterPush(state, summary) {
  const st = state && typeof state === 'object' ? state : {};
  const s = validSummary(summary);
  const session = s && isStr(s.session) ? s.session : null;
  if (!s) return { openedAt: null, pinned: false, typed: false, session: null };
  if (isStr(st.session) && session !== st.session) return { openedAt: null, pinned: false, typed: false, session };
  return { openedAt: isNum(st.openedAt) ? st.openedAt : null, pinned: st.pinned === true, typed: st.typed === true, session: isStr(st.session) ? st.session : session };
}

const api = { afterPush, panelModel, openOnSelect, untouchedLongEnough, lastTouchedAt, labelOf, offNote, hoverLines, hasContent, UNTOUCHED_MS, SHOW_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.summaryDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
