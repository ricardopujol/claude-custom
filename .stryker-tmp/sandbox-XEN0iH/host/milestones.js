// @ts-nocheck
'use strict';
/**
 * The token counter, gamified.
 *
 * A COUNTER, NEVER A LIMIT. That single constraint decides the whole shape:
 * progress runs TOWARD the next milestone, and never depletes an allowance.
 * Nothing here can go red, warn, or run out. A bar that fills as you work reads
 * as an achievement; the same bar labelled "remaining" reads as a leash, and
 * the harness has no business rationing anyone's own subscription.
 *
 * There is deliberately no `remaining`, `quota`, `budget`, `cap` or `limit`
 * field, and a test asserts none appears.
 *
 * THE BREAKDOWN IS NOT DECORATION. Measured on this project: ~97M of 119M
 * tokens were CACHE READS. A single headline number implies spend that did not
 * happen, so fresh tokens and cache reads are always reported apart.
 */

// The ladder. Emoji per the project's art placeholder rule -- stored as DATA
// beside the thing it marks, so swapping in generated art later is one field.
//
// The top rung sits above where this project already stands (~1B), because a
// ladder you have already climbed past has nothing left to say.
const MILESTONES = Object.freeze([
  { at: 10e3, name: 'First Sparks', icon: '✨' },
  { at: 100e3, name: 'Getting Warm', icon: '🔥' },
  { at: 1e6, name: 'Millionaire', icon: '🪙' },
  { at: 10e6, name: 'Deep Work', icon: '⛏️' },
  { at: 50e6, name: 'Heavy Machinery', icon: '⚙️' },
  { at: 100e6, name: 'Industrial', icon: '🏭' },
  { at: 250e6, name: 'Orbital', icon: '🛰️' },
  { at: 500e6, name: 'Half a Billion', icon: '🌒' },
  { at: 1e9, name: 'Billionaire', icon: '🌕' },
  { at: 5e9, name: 'Deep Space', icon: '🪐' },
  { at: 10e9, name: 'Legendary', icon: '🐉' },
].map(Object.freeze));

// The demo milestone, named once. Two hardcoded copies (a positional index in
// the host, a literal in the renderer) silently disagree the moment a rung is
// inserted below them.
const DEMO_MILESTONE = MILESTONES.find(m => m.name === 'Billionaire');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// An unusably large total is ABOVE the ladder, not below it. `num` floors every
// non-finite value to 0, which reported Infinity as "no milestone reached, 0%
// toward First Sparks" -- degrading in the direction opposite to the truth.
const isAboveLadder = (v) => Number(v) === Infinity;

// The highest milestone reached, or null below the first rung.
function milestoneFor(total) {
  if (isAboveLadder(total)) return MILESTONES[MILESTONES.length - 1];
  const t = num(total);
  let found = null;
  for (const m of MILESTONES) {
    if (t >= m.at) found = m;
    else break;                 // the ladder ascends, so the first miss ends it
  }
  return found;
}

function nextMilestone(total) {
  const t = num(total);
  return MILESTONES.find(m => t < m.at) || null;    // past the top: nothing above
}

// Progress through the CURRENT segment: from the rung you are standing on to
// the one above. Below the first rung the segment starts at zero.
function progressTo(total) {
  if (isAboveLadder(total)) return 1;
  const t = Math.max(0, num(total));
  const next = nextMilestone(t);
  if (!next) {
    // PAST THE TOP RUNG THE BAR KEEPS MOVING. Pinning it at 1 forever is the
    // visual signature of a meter that is FULL -- the one shape "a counter,
    // never a limit" rules out. Each further top-rung span is another lap.
    const top = MILESTONES[MILESTONES.length - 1].at;
    return ((t - top) % top) / top;
  }
  const floor = milestoneFor(t) ? milestoneFor(t).at : 0;
  const span = next.at - floor;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (t - floor) / span));
}

/**
 * A milestone newly reached between two readings, for the flourish.
 *
 * `before` of null/undefined means "no previous reading" and returns null. On
 * launch the previous total is unknown, and treating that as 0 -> 900M would
 * throw a party for work done weeks ago, on every single launch.
 *
 * A total that goes DOWN never celebrates: totals are re-read from transcripts
 * on disk, and a session file can disappear.
 */
function crossed(before, after) {
  if (before === null || before === undefined) return null;
  const from = num(before);
  const to = num(after);
  if (!(to > from)) return null;

  const reached = milestoneFor(to);
  if (!reached) return null;
  const had = milestoneFor(from);
  if (had && had.at >= reached.at) return null;
  // The HIGHEST crossed. One turn can move a long way, and announcing the
  // lowest would be a stale celebration while announcing all of them is a parade.
  return reached;
}

// Rounds INSIDE the unit, never across it. `(999950/1e3).toFixed(1)` is
// "1000.0", so the naive version emitted "1000k" -- longer than the number it
// abbreviates, and unrecognisable next to the "1M" the tooltip prints for the
// rung one token away. Each unit is therefore chosen after rounding, not before.
// A trillion rung exists so the promotion at the top of 'B' has somewhere to
// go; without it 999_950_000_000 rendered as "1000B".
const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];

// Rounds INSIDE the unit, never across it. `(999950/1e3).toFixed(1)` is
// "1000.0", so the naive version emitted "1000k" -- longer than the number it
// abbreviates, and unrecognisable beside the "1M" the tooltip prints for a rung
// one token away. When rounding carries, the unit is PROMOTED.
/**
 * Decides WHEN to announce, which is the whole of the once-only guarantee.
 *
 * Lives here rather than in host.js because requiring host.js boots a pty and a
 * WebSocket server. The previous version was a private function in the host, so
 * the tests written for it were aimed at a COPY of the algorithm re-implemented
 * inside the test file -- deleting the real high-water mark left every test
 * green. A fix that lands where nothing can reach it looks complete in the diff
 * and is scored by nothing.
 *
 * Three rules, each of which was a bug before it was a rule:
 *
 *   - A FAILED READING IS NOT A READING. readUsage returns zeros with
 *     `ok: false` when it cannot read the transcripts, and a caller that
 *     treated that as a real total announced the whole ladder on the next good
 *     tick.
 *   - THE FIRST READING SEEDS, it does not announce. Otherwise every launch
 *     celebrates work done weeks ago.
 *   - A RUNG IS ANNOUNCED ONCE. `crossed` refuses to celebrate while a total
 *     FALLS but not on the way back up, and the project total legitimately
 *     jitters -- transcripts expire, a partial final line is skipped.
 */
function createAnnouncer() {
  let lastTotal = null;
  let highest = null;

  return {
    see(total, ok = true) {
      if (!ok) return null;                     // absence is not a measurement
      if (lastTotal === null) {
        lastTotal = total;
        highest = milestoneFor(total);          // seed: where we already stand
        return null;
      }
      const hit = crossed(lastTotal, total);
      lastTotal = total;
      if (!hit) return null;
      if (highest && highest.at >= hit.at) return null;
      highest = hit;
      return hit;
    },

    // For tests and diagnostics; never used to make a decision.
    state: () => ({ lastTotal, highest }),
  };
}

const compact = (n) => {
  const v = num(n);
  for (let i = 0; i < UNITS.length; i++) {
    const [size, suffix] = UNITS[i];
    if (v < size) continue;
    const scaled = Number((v / size).toFixed(1));
    if (scaled >= 1000 && i > 0) {
      const [bigger, biggerSuffix] = UNITS[i - 1];
      return String(Number((v / bigger).toFixed(1))) + biggerSuffix;
    }
    return String(scaled) + suffix;
  }
  return String(Math.round(v));
};

/**
 * How to FRAME the same numbers, which differs by provider because the
 * underlying truth differs.
 *
 * On a subscription the marginal cost inside quota is zero, so a playful
 * counter is honest. On a metered provider every token is real money, and a
 * cheerful milestone about someone's bill is not.
 *
 * A dollar figure is shown ONLY when a real rate is supplied. Deriving one from
 * a guessed price would be worse than showing nothing: it is the number someone
 * would repeat. The per-model price table is feature #15 and does not exist.
 */
function describeSpend(usage, { metered = false, usdPerMillion = null } = {}) {
  const u = usage || {};
  const total = num(u.total);
  const cacheRead = num(u.cacheRead);
  // Cache WRITES are newly processed tokens, and metered providers bill them at
  // a PREMIUM -- they are the opposite of free cache traffic. Leaving them out
  // of `fresh` while `total` included them left a silent gap: on this project's
  // real proportions the label said "15k fresh" of 99M when 2.015M were billed
  // as fresh, understating it 134x. fresh + cacheRead now partitions total.
  const cacheWrite = num(u.cacheWrite);
  const fresh = num(u.input) + num(u.output) + cacheWrite;
  const cacheShare = total > 0 ? cacheRead / total : 0;

  // Number.isFinite does NOT coerce -- Number.isFinite(null) is false. The
  // original bug was the `Number()` wrapper I put around the argument, which
  // turned a missing rate into 0 and printed a confident "$0.00": exactly the
  // invented figure this refuses to produce. No wrapper, no coercion.
  const rate = Number.isFinite(usdPerMillion) ? usdPerMillion : null;
  const costUsd = metered && rate !== null ? (total / 1e6) * rate : null;

  const label = costUsd !== null
    ? `$${costUsd.toFixed(2)} · ${compact(total)} tokens`
    : metered
      ? `${compact(total)} tokens · ${compact(fresh)} fresh`
      : `${compact(total)} tokens`;

  return { total, fresh, cacheRead, cacheWrite, cacheShare, metered, costUsd, label };
}

module.exports = {
  MILESTONES, milestoneFor, nextMilestone, progressTo, crossed, describeSpend,
  compact, createAnnouncer,
};
