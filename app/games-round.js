'use strict';
/**
 * One round of a wait game (BACKLOG #41) and the rules for when it may run: the 45-second clock, the hand-back, and the three
 * questions "does the game get this key", "does it draw" and "what does the cover say".
 *
 * The hand-back is the point of the feature (documentation/DESIGN_ROUND_2026-10-09B.md, rounds 10-11): a wait game must never
 * make Ricardo miss Claude. When Claude needs him (a permission prompt, a question) or finishes the turn, the running round
 * PAUSES and says why, keyboard focus goes back to the terminal, and the round resumes only when he comes back to the panel.
 * A game also never takes keys while the terminal has focus, so a keystroke meant for Claude can't land in a game.
 *
 * Pure: every function takes a state and returns a new one. app/games-display.js turns DOM events into these calls.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one global scope (test/renderer-scope.test.js).
 * The page sees one name, `gamesRound`.
 */
(function (root) {

const ROUND_SECONDS = 45;
// A frame after a real gap (a suspended tab, a stalled process) must not eat the round. A merely slow machine isn't a gap: at 15 fps
// every frame is 67 ms and still counts in full, so a round lasts 45 s of wall time however slow the frames are.
const MAX_GAP = 0.5;

const WHY = Object.freeze({
  claude: '✋ Claude needs you',
  hidden: 'Paused while the panel was out of sight',
  time: 'Time',
  missed: 'Missed',
  full: 'Board full',
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);

const idle = () => ({ phase: 'idle', left: ROUND_SECONDS, score: 0, why: null });

/** A round begins: the full clock, no score. Starting is allowed from any phase, so "Again" and a new pick both work. */
const start = () => ({ phase: 'running', left: ROUND_SECONDS, score: 0, why: null });

/** The game's own score, only while it is live. Anything that is not a finite number is no score. */
function withScore(s, score) {
  if (s.phase !== 'running' || !isNum(score)) return s;
  return { ...s, score };
}

/** `dt` seconds of play. Only a running round has a clock; a bad or negative `dt` is no time; a gap over MAX_GAP counts as MAX_GAP. */
function tick(s, dt) {
  if (s.phase !== 'running') return s;
  const step = isNum(dt) && dt > 0 ? Math.min(dt, MAX_GAP) : 0;
  const left = s.left - step;
  return left <= 0 ? { ...s, left: 0, phase: 'over', why: 'time' } : { ...s, left };
}

/** The round ends now for `why` ('missed', 'full'); a round that is not running has nothing to end. */
function finish(s, why) {
  if (s.phase !== 'running' && s.phase !== 'paused') return s;
  return { ...s, phase: 'over', why: typeof why === 'string' && WHY[why] ? why : 'time' };
}

/**
 * Claude needs Ricardo, or has finished: a running round freezes, with the reason on its cover. A round that is not running
 * stays as it is (an idle panel or a finished round is already waiting).
 */
function handBack(s) { return s.phase === 'running' ? { ...s, phase: 'paused', why: 'claude' } : s; }

/** The panel left the screen (another tab, a minimised window, lean mode): freeze, so the clock doesn't run unseen. */
function hide(s) { return s.phase === 'running' ? { ...s, phase: 'paused', why: 'hidden' } : s; }

/** Ricardo is back in the panel: a paused round runs again from where it stopped. Nothing else changes. */
function comeBack(s) { return s.phase === 'paused' ? { ...s, phase: 'running', why: null } : s; }

/**
 * Does the game get this key? Only while it is running, only when focus is inside the panel, and never when the terminal has it.
 * `focus` is { panel, terminal }; anything that is not strictly `true` counts as no.
 */
function acceptsKeys(s, focus) {
  return s.phase === 'running' && !!focus && focus.panel === true && focus.terminal !== true;
}

/** Does the panel paint a frame? Only when it is on screen: shown by the dock, the page visible, and not in lean mode. */
function shouldDraw(view) {
  return !!view && view.shown === true && view.pageVisible === true && view.lean !== true;
}

/** Whole seconds left, never below 0 and never a fraction ("45" at the start, "1" until it is over). */
const secondsLeft = s => Math.max(0, Math.ceil(s.left));

/** The cover over the board: null while the round is live (nothing to say), else { text, note, button }. */
function cover(s, label) {
  if (s.phase === 'running') return null;
  if (s.phase === 'paused') {
    return { text: WHY[s.why] || WHY.hidden, note: 'Your round waits here. Click the board to carry on.', button: 'Resume' };
  }
  if (s.phase === 'over') return { text: `${WHY[s.why] || WHY.time}: ${s.score}`, note: '', button: 'Again' };
  return { text: label || '', note: '', button: 'Play' };
}

/**
 * Does coming back to the panel resume a paused round? Only a paused round, only when the press or focus landed on the board (not on
 * the cover's own button, whose click resumes it), and only while the panel is on screen.
 */
const shouldResume = (s, onBoard, drawing) => s.phase === 'paused' && onBoard === true && drawing === true;

const API = { ROUND_SECONDS, MAX_GAP, shouldResume, WHY, idle, start, withScore, tick, finish, handBack, hide, comeBack, acceptsKeys, shouldDraw, secondsLeft, cover };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.gamesRound = API;

})(typeof window !== 'undefined' ? window : globalThis);
