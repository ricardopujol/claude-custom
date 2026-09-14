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
const MILESTONES = [
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
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The highest milestone reached, or null below the first rung.
function milestoneFor(total) {
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
  const t = Math.max(0, num(total));
  const next = nextMilestone(t);
  if (!next) return 1;                       // past the top rung, the bar is full
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

const compact = (n) => {
  const v = num(n);
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
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
  const fresh = num(u.input) + num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheShare = total > 0 ? cacheRead / total : 0;

  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a null rate
  // computed a confident "$0.00" -- exactly the invented figure this refuses to
  // produce. The check has to be for an actual number.
  const rate = typeof usdPerMillion === 'number' && Number.isFinite(usdPerMillion)
    ? usdPerMillion : null;
  const costUsd = metered && rate !== null ? (total / 1e6) * rate : null;

  const label = costUsd !== null
    ? `$${costUsd.toFixed(2)} · ${compact(total)} tokens`
    : metered
      ? `${compact(total)} tokens · ${compact(fresh)} fresh`
      : `${compact(total)} tokens`;

  return { total, fresh, cacheRead, cacheShare, metered, costUsd, label };
}

module.exports = {
  MILESTONES, milestoneFor, nextMilestone, progressTo, crossed, describeSpend, compact,
};
