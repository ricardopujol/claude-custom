'use strict';
/**
 * Lean mode's one window-level state (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md). Main owns it; every tab page and the strip are
 * told. PURE: no Electron, no clock, no disk (the dismissed list goes out through `onDismissed` and comes in through `dismissed`).
 *
 *   on           the window is lean
 *   byBedtime    a /bedtime night turned it on (so the night's end turns it off); false when the button did
 *   bedtimeSince the start (ms) of the night that did it, for the strip's `bedtime HH:MM`; null otherwise
 *
 * THE RULES (Ricardo's, round 3):
 *   - the ☾ Lean button always wins. setByHand(on) sets the state and takes it away from any night: a night that started while it
 *     was on by hand leaves it by hand, and a night that turned it on loses the right to turn it off the moment the button is
 *     pressed.
 *   - a night starting turns it on ONLY if it was not already on.
 *   - a night ending turns it off only if bedtime turned it on and no other tab still has a night going.
 *   - typing, or anything else in the terminal, never enters here: it stays lean.
 *
 * A NIGHT IS IDENTIFIED BY ITS START, the host's `startedAt` (host/bedtime-state.js), never by the view that reported it (PR #140
 * Dexter F2): a tab closed and reopened, a page reloaded, an app restarted all report the same night under a new owner.
 *   - "Back to normal" during a night DISMISSES it: pressing the button while lean was on, with nights going, adds each of their
 *     starts to `dismissed`. A dismissed night never turns lean on again (its start is reported again by every hello). The list is
 *     handed to `onDismissed` so main can keep it across a restart, and comes back in through `dismissed`. A NEW night asks again.
 *   - A night that merely went quiet is NOT dismissed (Dexter F3): the host says "no night" once a wake is overdue and, when the late
 *     wake revives the night, the same start comes back. Lean that bedtime had turned off for that gap turns on again.
 * One known edge, accepted (Miguel S3): a night's start is the host's, so closing a night's tab and reopening it does NOT restart the
 * night; it keeps its dismissal.
 */

const DISMISSED_CAP = 50;

const isTime = (n) => typeof n === 'number' && Number.isFinite(n);

/** The stored list and this main's own, merged (two windows are two mains, each with its own memory: PR #140 Dexter N3), capped. */
function unionDismissed(stored, mine) {
  const out = [];
  for (const at of [...(Array.isArray(stored) ? stored : []), ...(Array.isArray(mine) ? mine : [])]) {
    if (isTime(at) && !out.includes(at)) out.push(at);
  }
  return out.slice(-DISMISSED_CAP);
}

function createLean({ dismissed = [], onDismissed = () => {} } = {}) {
  let on = false;
  let byBedtime = false;
  let since = null;
  const nights = new Map();                                       // owner -> startedAt, the nights going now
  const gone = (Array.isArray(dismissed) ? dismissed : []).filter(isTime).slice(-DISMISSED_CAP);

  function view() {
    return { on, byBedtime: on && byBedtime, bedtimeSince: on && byBedtime ? since : null };
  }

  function snapshot() { return JSON.stringify(view()); }

  function dismissGoingNights() {
    let added = false;
    for (const at of nights.values()) {
      if (gone.includes(at)) continue;
      gone.push(at);
      added = true;
    }
    if (!added) return;
    while (gone.length > DISMISSED_CAP) gone.shift();
    try { onDismissed([...gone]); } catch { /* not saved: the dismissal still holds until a restart */ }
  }

  function setByHand(next) {
    const before = snapshot();
    const want = next === true;
    if (!want && on) dismissGoingNights();
    on = want;
    byBedtime = false;
    since = null;
    return snapshot() !== before;
  }

  function nightStarted(owner, startedAt) {
    if (!isTime(startedAt)) return false;
    nights.set(owner, startedAt);
    if (gone.includes(startedAt) || on) return false;
    on = true;
    byBedtime = true;
    since = startedAt;
    return true;
  }

  function nightEnded(owner) {
    if (!nights.delete(owner)) return false;
    if (nights.size > 0 || !on || !byBedtime) return false;
    on = false;
    byBedtime = false;
    since = null;
    return true;
  }

  return { view, setByHand, nightStarted, nightEnded };
}

module.exports = { createLean, unionDismissed };
