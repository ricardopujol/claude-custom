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
  const age = bar.ageLabel(s.at, now);
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
const INVISIBLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;
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

function openOnSelect({ summary, off, lastInputAt, now } = {}) {
  return hasContent(summary, off) && untouchedLongEnough(lastInputAt, now);
}

function panelModel({ summary, off, now, openedAt, pinned, typed } = {}) {
  const s = validSummary(summary);
  const o = validOff(off);
  if (!s && !o) return null;
  const pin = pinned === true;
  const within = isNum(openedAt) && isNum(now) && typed !== true && now >= openedAt && now - openedAt < SHOW_MS;
  if (!pin && !within) return null;
  return {
    label: s ? labelOf(s, now) : labelOf(null, now) + (o && isStr(o.model) ? ' · ' + o.model : ''),
    lines: s ? linesOf(s.text) : [],
    note: offNote(o),
    dim: (s !== null && s.stale === true) || o !== null,
    pinned: pin,
  };
}

/** The tab strip's hover lines for a tab's summary (`summary.note`: why it may be out of date), or [] when it has none. */
function hoverLines(summary, now) {
  const s = validSummary(summary);
  if (!s) return [];
  const note = isStr(summary.note) ? [summary.note] : [];
  return [`Where we're at (${labelOf(s, now)}):`, ...linesOf(s.text), ...note];
}

const api = { panelModel, openOnSelect, untouchedLongEnough, lastTouchedAt, labelOf, offNote, hoverLines, hasContent, UNTOUCHED_MS, SHOW_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.summaryDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
