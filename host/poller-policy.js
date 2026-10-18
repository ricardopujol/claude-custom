'use strict';
/**
 * The pure half of the shared resource poller (BACKLOG #100 c): WHEN to sample and WHO samples. No clock, no OS, no files.
 *
 * THE CADENCE TABLE IS A DESIGN CALL, and it is Ricardo's (CLAUDE.md "Design Is Ricardo's"): this is the recommendation,
 * held in ONE constant so his answer changes a number here and nothing else.
 *   panel   10 s   an instance shows the Resources panel (docked, peeked or popped)
 *   chip    30 s   only the top bar's machine chip is in view
 *   hidden  none   every window is minimised
 * Both rows are the FULL sample, on purpose: the tab warning and Leftovers read the process tree (Round 3 Q1, PR #113), so
 * a machine-only sample at the chip level would switch them off. The cost of that choice is open: at 30 s the warning's
 * "three samples in a row" spans 90 s, not 30 s.
 *
 * ONE SAMPLER FOR ALL INSTANCES. Every instance records the level it wants; the owner samples at the strongest one.
 * Who the owner is, is a file (host/shared-poller.js); whether a recorded owner still is one is `ownerVerdict`, and it follows
 * host/pid-ledger.js's rule: DOUBT KEEPS. A pid alone proves nothing on Windows (it is reused), the start time does.
 */

const CADENCE = Object.freeze({
  panel: Object.freeze({ intervalMs: 10000, mode: 'full' }),
  chip: Object.freeze({ intervalMs: 30000, mode: 'full' }),
  hidden: null,
});
const LEVELS = Object.freeze(['hidden', 'chip', 'panel']);   // weakest first
// How long an owner's heartbeat may go unrenewed before a live pid stops being taken on trust and its start time is asked.
const STALE_BEAT_MS = 20000;

const isLevel = (l) => typeof l === 'string' && LEVELS.includes(l);

/** The row for a level, or null (hidden, or anything unknown). */
function cadenceOf(level) {
  return isLevel(level) && Object.prototype.hasOwnProperty.call(CADENCE, level) ? CADENCE[level] : null;
}

/** What one instance wants, from what it knows. Only real booleans count; unknown reads as the cheap-but-alive `chip`. */
function levelOf({ minimised, panelShown } = {}) {
  if (minimised === true) return 'hidden';
  return panelShown === true ? 'panel' : 'chip';
}

/** The sampler's `{ panel, chip, viewing }` (host/resource-sampler.js setWanted) as a level. Nothing wanted is hidden. */
function fromWanted(wanted) {
  if (!wanted || typeof wanted !== 'object' || (wanted.panel !== true && wanted.chip !== true)) return 'hidden';
  return levelOf({ minimised: false, panelShown: wanted.viewing === true });
}

/** The strongest of several instances' levels; none, or only junk, is hidden. */
function strongest(levels) {
  if (!Array.isArray(levels)) return 'hidden';
  let best = 0;
  for (const l of levels) if (isLevel(l)) best = Math.max(best, LEVELS.indexOf(l));
  return LEVELS[best];
}

const validPid = (pid) => Number.isInteger(pid) && pid > 0;

/**
 * What to do about the recorded owner. 'mine' | 'keep' | 'claim' | 'verify' (ask for the start-time proof, then ask again).
 *   owner       the record { pid, start } or null; self { pid, start }
 *   pidAlive    true | false | null (could not tell)
 *   beatAgeMs   how long since the owner last renewed its heartbeat
 *   startsMatch the proof, once asked: true (same start), false (another process has the pid), null (query failed), undefined (not asked yet)
 */
function ownerVerdict({ owner, self, pidAlive, beatAgeMs, startsMatch } = {}) {
  if (!owner || typeof owner !== 'object' || !validPid(owner.pid)) return 'claim';
  if (self && owner.pid === self.pid) return owner.start === self.start ? 'mine' : 'claim';
  if (pidAlive === false) return 'claim';
  if (pidAlive !== true) return 'keep';
  if (!(Number.isFinite(beatAgeMs) && beatAgeMs > STALE_BEAT_MS)) return 'keep';
  if (startsMatch === undefined) return 'verify';
  return startsMatch === false ? 'claim' : 'keep';
}

/**
 * The start-time proof about a recorded owner, from proc-start's `startTimes([pid])` answer (a Map pid -> start string, a
 * pid whose start it could not read -> null, a pid not listed -> absent; or null when the whole query failed).
 * true (same start) | false (another process has the pid, or none does) | null (could not tell: doubt keeps).
 */
function startProof(starts, owner) {
  if (!starts || typeof starts.has !== 'function' || !owner) return null;
  if (!starts.has(owner.pid)) return false;
  const s = starts.get(owner.pid);
  if (typeof s !== 'string') return null;
  return s === owner.start;
}

module.exports = { CADENCE, LEVELS, STALE_BEAT_MS, cadenceOf, levelOf, fromWanted, strongest, ownerVerdict, startProof };
