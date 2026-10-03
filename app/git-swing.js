'use strict';
/**
 * The Git dial's motion (documentation/DESIGN_GIT_TREE.md, "Enhancement #46", mock A3 *Settle*). Pure:
 * every function takes the time it needs, so a fake clock tests all of it.
 *
 *   start() / step(state, nowMs, { holding, reduced }) -> state { clock, speed, t, resumeAt }
 *   angleDeg(clock)      the dial's turn: 40 deg * sin(2 pi * clock / 90 s). Never a full turn.
 *   breath(name, sec, { reduced })   a spoke's length factor, 1 +- 3%, a slow sine whose phase is a
 *                                    stable hash of the branch name. 3% is the honesty limit (length
 *                                    still means tokens), so it is a constant, not a setting.
 *   grown(prev, next)    the names whose spend was MEASURED to grow between two answers
 *   sparksOn / sparkAt   sparks stream only for measured growth, for a while after the refresh
 *
 * The dial has its OWN clock, not the wall's: it slows to a stop (about 0.5 s) while the pointer is over
 * the dial or a branch is pinned, so a spoke never slides from under a click, and picks up again about
 * 2.5 s after the hold ends. Reduced motion is still: the clock never moves.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitSwing`.
 */
(function (root) {

const SWING_DEG = 40;
const PERIOD_S = 90;
const EASE_S = 0.5;          // from full speed to a stop (and back)
const RESUME_MS = 2500;      // after the hold ends
const MAX_STEP_S = 0.1;      // a frame after a long gap (a hidden window) is a step, not a leap
const BREATH = 0.03;
const BREATH_PERIOD_S = 9;
const SPARK_MS = 15000;      // sparks keep streaming this long after the refresh that measured growth
const SPARK_PERIOD_S = 1.2;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function start() { return { clock: 0, speed: 1, t: null, resumeAt: 0 }; }

/**
 * Advances the dial's own clock to `nowMs`. `holding`: the pointer is over the dial, or a branch is
 * pinned. `reduced`: prefers-reduced-motion. Returns a new state; the old one is untouched.
 */
function step(state, nowMs, { holding = false, reduced = false } = {}) {
  const dt = state.t === null ? 0 : Math.min(MAX_STEP_S, Math.max(0, (nowMs - state.t) / 1000));
  if (reduced) return { clock: state.clock, speed: 0, t: nowMs, resumeAt: state.resumeAt };
  const resumeAt = holding ? nowMs + RESUME_MS : state.resumeAt;
  const target = holding || nowMs < resumeAt ? 0 : 1;
  const ramp = dt / EASE_S;
  const speed = target > state.speed ? Math.min(target, state.speed + ramp) : Math.max(target, state.speed - ramp);
  let clock = state.clock + dt * (state.speed + speed) / 2;
  if (clock >= PERIOD_S) clock -= PERIOD_S;
  return { clock, speed, t: nowMs, resumeAt };
}

const angleDeg = clock => SWING_DEG * Math.sin(2 * Math.PI * clock / PERIOD_S);

/** FNV-1a over the name's UTF-16 units -> [0, 1). A name is data: it is only ever hashed. */
function breathPhase(name) {
  let h = 0x811c9dc5;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

function breath(name, sec, { reduced = false } = {}) {
  if (reduced) return 1;
  return 1 + BREATH * Math.sin(2 * Math.PI * (sec / BREATH_PERIOD_S + breathPhase(name)));
}

/** (x, y) turned `deg` clockwise (SVG's y runs down) about (cx, cy). */
function rotatePoint(x, y, cx, cy, deg) {
  if (deg === 0) return [x, y];
  const a = deg * Math.PI / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/**
 * The names whose spend was measured before AND is larger now. No earlier answer, an unknown (null)
 * spend on either side, or a spend that fell (a ledger re-read) is not growth: nothing was measured.
 */
function grown(prev, next) {
  const out = new Set();
  if (!Array.isArray(prev) || !Array.isArray(next)) return out;
  const before = new Map();
  for (const b of prev) if (b && isNum(b.spend)) before.set(b.name, b.spend);
  for (const b of next) {
    if (b && isNum(b.spend) && before.has(b.name) && b.spend > before.get(b.name)) out.add(b.name);
  }
  return out;
}

/** Are sparks streaming at `nowMs`, given when growth was last measured (null: never)? */
function sparksOn(since, nowMs) {
  return isNum(since) && nowMs >= since && nowMs < since + SPARK_MS;
}

/** Where along its spoke (0 at the tip, 1 at the reach) spark `i` of `n` is at `nowMs`. */
function sparkAt(i, n, nowMs) {
  const p = (nowMs / 1000 / SPARK_PERIOD_S + i / Math.max(1, n)) % 1;
  return p < 0 ? p + 1 : p;
}

const api = {
  start, step, angleDeg, breath, breathPhase, rotatePoint, grown, sparksOn, sparkAt,
  SWING_DEG, PERIOD_S, EASE_S, RESUME_MS, BREATH, SPARK_MS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.gitSwing = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
