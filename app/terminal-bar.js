'use strict';
/**
 * The terminal bar's decisions (backlog #49 last prompt + #52 bedtime, with #47's occupancy banner folded in as
 * a chip; documentation/DESIGN_TERMINAL_BAR.md). Pure: the page only paints what `barModel` says.
 *
 *   barModel({ prompt, anchor, view, now, bedtime, occupancy, focusMode })
 *       -> { visible, prompt: { head, full, age } | null, chips: [{ kind, short, long, warn, jump? }] }
 *   scrolledAway(prompt, anchor, view)   is the prompt's place in the terminal above the top of the viewport?
 *   makeAnchor(prompt, { line, epoch}) / locatingAnchor(prompt, epoch)   the line the CLI's echo was FOUND on, or
 *                                        "not drawn yet"
 *   echoNeedle(text) / findEcho(lines, needle)   what to look for in the buffer, and where it is
 *   barVisible({ promptDue, chips, focusMode })
 *   promptModel(prompt, now) / ageLabel(at, now) / bedtimeChip(payload, now) / occupancyChip(model)
 *
 * THE SCROLLED-AWAY RULE (Ricardo's pick 1: the prompt shows only once it has scrolled off the top)
 *   The prompt's place is the buffer line the CLI ECHOED it on, FOUND BY ITS TEXT (PR #99 Dexter F6). It is not the
 *   cursor: measured with the real CLI (verify/probe-prompt-anchor.js), Claude Code pins its input box to the
 *   bottom of the screen, so the cursor is at the bottom row both before a submit and when the hook fires, 30 lines
 *   below a one-line echo and 24 below the first line of a five-line one. While the echo isn't drawn yet the anchor
 *   is `locating` (not due: no flash of the bar on every submit); the page gives it a few seconds and then drops it
 *   (no anchor: due, fails visible). The prompt part is due while that line is above the viewport, or under the rows
 *   the bar itself covers (`viewportY + coveredRows > line`, F7: a chip keeps the bar open over the first rows),
 *   and hides again when the person scrolls back to it. IT FAILS VISIBLE: a prompt that was
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

const NEEDLE_MAX = 60;

/** The buffer line a prompt's echo was found on, or null when there is no usable line. */
function makeAnchor(prompt, { line, epoch = 0 } = {}) {
  if (!prompt || !isNum(prompt.seq) || !isNum(line) || line < 0) return null;
  return { seq: prompt.seq, line, epoch };
}

/** "The echo isn't drawn yet": bound to this prompt and epoch; not due while it lasts (the page bounds that). */
function locatingAnchor(prompt, epoch = 0) {
  if (!prompt || !isNum(prompt.seq)) return null;
  return { seq: prompt.seq, locating: true, epoch };
}

/**
 * What to look for in the buffer: the first non-blank line of what was TYPED (the CLI echoes it as typed, so an
 * [Image #1] stays one), trimmed and clipped to NEEDLE_MAX characters; null when there's nothing to search by (a
 * needle of one or two characters would match anything).
 */
function echoNeedle(text) {
  if (typeof text !== 'string') return null;
  const first = text.split(/\r?\n/).find(l => l.trim() !== '');
  if (first === undefined) return null;
  const chars = Array.from(first.trim());
  if (chars.length < 3) return null;
  return chars.slice(0, NEEDLE_MAX).join('');
}

/** The index of the LAST line holding the needle (the newest echo), or -1. Non-strings are never matched. */
function findEcho(lines, needle) {
  if (!Array.isArray(lines) || typeof needle !== 'string' || needle === '') return -1;
  for (let i = lines.length - 1; i >= 0; i--) if (typeof lines[i] === 'string' && lines[i].includes(needle)) return i;
  return -1;
}

/**
 * Is the prompt's place above the viewport? `view`: { viewportY, bufferLength, full, epoch, coveredRows }.
 * `full` is true once the scrollback is at its limit (lines are being trimmed from the top); `coveredRows` is how
 * many rows from the top the bar itself hides (0 when it is closed; anything but a non-negative integer is 0).
 */
function scrolledAway(prompt, anchor, view) {
  if (!prompt || !isNum(prompt.seq)) return false;                       // nothing to show
  const v = view && typeof view === 'object' ? view : {};
  if (!anchor || typeof anchor !== 'object' || anchor.seq !== prompt.seq) return true;
  if (v.epoch !== anchor.epoch) return true;
  if (anchor.locating === true) return false;                            // the echo isn't drawn yet
  if (!isNum(anchor.line) || anchor.line < 0) return true;
  if (!isNum(v.viewportY) || !isNum(v.bufferLength)) return true;
  if (anchor.line >= v.bufferLength) return true;
  if (v.full === true) return true;
  const covered = Number.isInteger(v.coveredRows) && v.coveredRows > 0 ? v.coveredRows : 0;
  return v.viewportY + covered > anchor.line;
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

// The head and the hover depend on the text alone, and a paint can run on every scrolled line while output streams
// (PR #99 Miguel G1): one remembered text, so the regex, split and Array.from run once per prompt, not per paint.
let memo = { key: null, head: '', full: '' };

/** The first line, clipped, plus the whole text for the hover; pasted images read `[image]`. */
function promptModel(prompt, now) {
  if (!prompt || !isStr(prompt.text) || prompt.text.trim() === '') return null;
  // A cut prompt (the host's cap) says so at the end of the whole text, never silently (PR #99 Miguel Y4).
  const cut = prompt.truncated === true;
  const omitted = cut && Number.isInteger(prompt.omitted) && prompt.omitted > 0 ? prompt.omitted : 0;
  const key = `${cut}|${omitted}|${prompt.text}`;
  if (memo.key !== key) {
    const body = prompt.text.replace(IMAGE, '[image]').trim();
    const first = body.split(/\r?\n/)[0];       // `body` is trimmed, so its first line is never blank
    const chars = Array.from(first.trim());
    const marker = !cut ? '' : omitted > 0 ? `\n…(truncated, ${omitted} more character${omitted === 1 ? '' : 's'})` : '\n…(truncated)';
    memo = { key, head: chars.length > PROMPT_HEAD_MAX ? chars.slice(0, PROMPT_HEAD_MAX).join('') + '…' : chars.join(''), full: body + marker };
  }
  return { head: memo.head, full: memo.full, age: ageLabel(prompt.at, now) };
}

// --- the chips -------------------------------------------------------------------------------------------

const two = (n) => String(n).padStart(2, '0');
function clock(ms) {
  if (!isNum(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : `${two(d.getHours())}:${two(d.getMinutes())}`;
}
const isCount = (n) => Number.isInteger(n) && n >= 0;
// `stale`: gh isn't answering now and this is the last answer; `capped`: the count hit gh's list limit (a floor)
const prsShort = (n, { stale, capped } = {}) => (isCount(n)
  ? `${n}${capped === true ? '+' : ''} PR${n === 1 && capped !== true ? '' : 's'}${stale === true ? ' (stale)' : ''}`
  : 'PRs: ?');
const prsLong = (n, { stale, capped } = {}) => (isCount(n)
  ? `${n}${capped === true ? '+' : ''} PR${n === 1 && capped !== true ? '' : 's'} so far${capped === true ? ' (gh\'s list limit)' : ''}${stale === true ? ' (last answer; gh is not answering now)' : ''}`
  : 'PRs so far: unknown');

/** The 🌙 chip for host/night-status.js's payload, or null when there is no night. */
function bedtimeChip(night, now) {
  if (!night || typeof night !== 'object' || !isNum(night.startedAt)) return null;
  const wake = clock(night.nextWakeAt);
  const due = isNum(night.nextWakeAt) && isNum(now) && night.nextWakeAt <= now;
  const next = night.awake === true && !isNum(night.nextWakeAt) ? 'working'
    : wake === null ? null
      : due ? `wake due ${wake}` : `next wake ${wake}`;
  const since = clock(night.startedAt);
  const prs = { stale: night.prsStale, capped: night.prsCapped };
  const short = ['overnight', next, prsShort(night.prs, prs)].filter(Boolean).join(' · ');
  const long = [
    since ? `overnight run since ${since}` : 'overnight run',
    next === 'working' ? 'awake now, working' : next,
    isNum(night.wakes) && night.wakes > 0 ? `${night.wakes} wake${night.wakes === 1 ? '' : 's'} so far` : null,
    prsLong(night.prs, prs),
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

const api = {
  barModel, barVisible, scrolledAway, makeAnchor, locatingAnchor, echoNeedle, findEcho, promptModel, ageLabel, bedtimeChip,
  occupancyChip, PROMPT_HEAD_MAX, NEEDLE_MAX,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.terminalBar = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
