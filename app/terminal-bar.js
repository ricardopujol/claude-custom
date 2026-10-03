'use strict';
/**
 * The terminal bar's decisions (backlog #49 last prompt + #52 bedtime, with #47's occupancy banner folded in as
 * a chip; documentation/DESIGN_TERMINAL_BAR.md). Pure: the page only paints what `barModel` says.
 *
 *   barModel({ prompt, anchor, view, now, bedtime, occupancy, focusMode })
 *       -> { visible, prompt: { head, full, age } | null, chips: [{ kind, short, long, warn, jump? }] }
 *   scrolledAway(prompt, anchor, view)   is the prompt's place in the terminal above the top of the viewport?
 *   makeAnchor(prompt, { baseY, cursorY, epoch })   where the CLI is echoing a prompt that has just arrived
 *   barVisible({ promptDue, chips, focusMode })
 *   promptModel(prompt, now) / ageLabel(at, now) / bedtimeChip(payload, now) / occupancyChip(model)
 *
 * THE SCROLLED-AWAY RULE (Ricardo's pick 1: the prompt shows only once it has scrolled off the top)
 *   When the page receives a prompt it records the xterm buffer's absolute line at that moment
 *   (`baseY + cursorY`: where the CLI is echoing it). The prompt part is due while that line is above the viewport
 *   (`viewportY > line`) and hides again when the person scrolls back to it. IT FAILS VISIBLE: a prompt that was
 *   never anchored (a window that attached after it was typed), an anchor from another prompt, another `epoch`
 *   (a resize reflows every line; a /clear or a shrinking buffer moves the lines), a line outside the buffer, a
 *   buffer that is full (scrollback is trimming from the top, so every absolute line has moved), or any number
 *   that isn't a number: the prompt SHOWS rather than vanishing. No prompt at all is never due.
 *
 * TRUTH RULES (the habits this repo keeps paying for)
 *   - Absence is never a value: no prompt is null (no prompt part), no night is no chip, an unknown PR count is
 *     "PRs: ?" and never "0", an unknown wake time says nothing, a missing age says nothing.
 *   - Strict `typeof` finite checks: Number(null) is 0.
 *   - Names and words are somebody else's strings: the painter sets textContent, never innerHTML.
 *   - The bar never animates; focus mode hides it with the rest of the chrome.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js): the page loads this as a plain <script> that shares
 * one global scope. One name leaves it: `terminalBar`.
 */
(function (root) {

const MIN = 60_000;
const PROMPT_HEAD_MAX = 240;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isStr = (s) => typeof s === 'string' && s !== '';

// --- the scrolled-away rule ------------------------------------------------------------------------------

/** Where a freshly arrived prompt is being echoed, or null when the buffer can't say. */
function makeAnchor(prompt, { baseY, cursorY, epoch = 0 } = {}) {
  if (!prompt || !isNum(prompt.seq) || !isNum(baseY) || !isNum(cursorY) || baseY < 0 || cursorY < 0) return null;
  return { seq: prompt.seq, line: baseY + cursorY, epoch };
}

/**
 * Is the prompt's place above the viewport? `view`: { viewportY, bufferLength, full, epoch }.
 * `full` is true once the scrollback is at its limit (lines are being trimmed from the top).
 */
function scrolledAway(prompt, anchor, view) {
  if (!prompt || !isNum(prompt.seq)) return false;                       // nothing to show
  const v = view && typeof view === 'object' ? view : {};
  if (!anchor || typeof anchor !== 'object' || anchor.seq !== prompt.seq) return true;
  if (!isNum(anchor.line) || anchor.line < 0) return true;
  if (v.epoch !== anchor.epoch) return true;
  if (!isNum(v.viewportY) || !isNum(v.bufferLength)) return true;
  if (anchor.line >= v.bufferLength) return true;
  if (v.full === true) return true;
  return v.viewportY > anchor.line;
}

// --- the prompt part -------------------------------------------------------------------------------------

/** "4 min ago" style, or null when either time is unknown or the prompt is from the future (a clock skew). */
function ageLabel(at, now) {
  if (!isNum(at) || !isNum(now) || now < at) return null;
  const m = Math.floor((now - at) / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const IMAGE = /\[Image #\d+\]/gi;

/** The first line, clipped, plus the whole text for the hover; pasted images read `[image]`. */
function promptModel(prompt, now) {
  if (!prompt || !isStr(prompt.text) || prompt.text.trim() === '') return null;
  const full = prompt.text.replace(IMAGE, '[image]').trim();
  const first = full.split(/\r?\n/)[0];       // `full` is trimmed, so its first line is never blank
  const chars = Array.from(first.trim());
  const head = chars.length > PROMPT_HEAD_MAX ? chars.slice(0, PROMPT_HEAD_MAX).join('') + '…' : chars.join('');
  return { head, full, age: ageLabel(prompt.at, now) };
}

// --- the chips -------------------------------------------------------------------------------------------

const two = (n) => String(n).padStart(2, '0');
function clock(ms) {
  if (!isNum(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : `${two(d.getHours())}:${two(d.getMinutes())}`;
}
const prsShort = (n) => (Number.isInteger(n) && n >= 0 ? `${n} PR${n === 1 ? '' : 's'}` : 'PRs: ?');
const prsLong = (n) => (Number.isInteger(n) && n >= 0 ? `${n} PR${n === 1 ? '' : 's'} so far` : 'PRs so far: unknown');

/** The 🌙 chip for host/night-status.js's payload, or null when there is no night. */
function bedtimeChip(night, now) {
  if (!night || typeof night !== 'object' || !isNum(night.startedAt)) return null;
  const wake = clock(night.nextWakeAt);
  const due = isNum(night.nextWakeAt) && isNum(now) && night.nextWakeAt <= now;
  const next = night.awake === true && !isNum(night.nextWakeAt) ? 'working'
    : wake === null ? null
      : due ? `wake due ${wake}` : `next wake ${wake}`;
  const since = clock(night.startedAt);
  const short = ['overnight', next, prsShort(night.prs)].filter(Boolean).join(' · ');
  const long = [
    since ? `overnight run since ${since}` : 'overnight run',
    next === 'working' ? 'awake now, working' : next,
    isNum(night.wakes) && night.wakes > 0 ? `${night.wakes} wake${night.wakes === 1 ? '' : 's'} so far` : null,
    prsLong(night.prs),
  ].filter(Boolean);
  return { kind: 'bedtime', short: `🌙 ${short}`, long: long.join('\n'), warn: false };
}

/** The agents' chip for app/occupancy-display.js chipModel, or null. */
function occupancyChip(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.tags)) return null;
  const tags = m.tags.filter(isStr);
  if (tags.length === 0) return null;
  const more = Number.isInteger(m.more) && m.more > 0 ? ` +${m.more}` : '';
  const chip = {
    kind: 'occupancy',
    short: tags.join(' ') + more,
    long: Array.isArray(m.lines) ? m.lines.filter(isStr).join('\n') : '',
    warn: m.warn === true,
  };
  if (m.jump && isStr(m.jump.root)) chip.jump = { label: isStr(m.jump.label) ? m.jump.label : 'Jump to its session', root: m.jump.root };
  return chip;
}

// --- the bar ---------------------------------------------------------------------------------------------

/** Shown when the prompt part is due OR any chip is active; never in focus mode; absent when there is nothing to say. */
function barVisible({ promptDue, chips, focusMode } = {}) {
  if (focusMode === true) return false;
  return promptDue === true || (Array.isArray(chips) && chips.length > 0);
}

function barModel({ prompt = null, anchor = null, view = null, now, bedtime = null, occupancy = null, focusMode = false } = {}) {
  const p = promptModel(prompt, now);
  const due = p !== null && scrolledAway(prompt, anchor, view);
  const chips = [bedtimeChip(bedtime, now), occupancyChip(occupancy)].filter(c => c !== null);
  const visible = barVisible({ promptDue: due, chips, focusMode });
  return { visible, prompt: visible && due ? p : null, chips: visible ? chips : [] };
}

const api = { barModel, barVisible, scrolledAway, makeAnchor, promptModel, ageLabel, bedtimeChip, occupancyChip, PROMPT_HEAD_MAX };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.terminalBar = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
