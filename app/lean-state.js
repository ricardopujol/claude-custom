'use strict';
/**
 * Lean mode's one window-level state (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md). Main owns it; every tab page
 * and the strip are told. PURE: no Electron, no clock.
 *
 *   on           the window is lean
 *   byBedtime    a /bedtime night turned it on (so the night's end turns it off); false when the button did
 *   bedtimeSince the start (ms) of the night that did it, for the strip's `bedtime HH:MM`; null otherwise
 *
 * THE RULES (Ricardo's, round 3):
 *   - the ☾ Lean button always wins. setByHand(on) sets the state and takes it away from any night: a night that
 *     started while it was on by hand leaves it by hand, and a night that turned it on loses the right to turn it off
 *     the moment the button is pressed.
 *   - a night starting turns it on ONLY if it was not already on. A night is `owner` (a tab view) + the start the host
 *     reported. The same night reported again (a reconnect, a reload) never counts twice, so "Back to normal"
 *     during a night is not undone by the host saying the night is still going; a NEW night asks again.
 *   - a night ending turns it off only if bedtime turned it on and no other tab still has a night going.
 *   - typing, or anything else in the terminal, never enters here: it stays lean.
 */

const HANDLED_CAP = 50;

const isTime = (n) => typeof n === 'number' && Number.isFinite(n);

function createLean() {
  let on = false;
  let byBedtime = false;
  let since = null;
  const nights = new Map();        // owner -> startedAt, the nights going now
  const handled = [];              // `${owner}:${startedAt}` of nights already given their say

  function view() {
    return { on, byBedtime: on && byBedtime, bedtimeSince: on && byBedtime ? since : null };
  }

  function snapshot() { return JSON.stringify(view()); }

  function setByHand(next) {
    const before = snapshot();
    on = next === true;
    byBedtime = false;
    since = null;
    return snapshot() !== before;
  }

  function nightStarted(owner, startedAt) {
    if (!isTime(startedAt)) return false;
    nights.set(owner, startedAt);
    const key = `${owner}:${startedAt}`;
    if (handled.includes(key)) return false;
    handled.push(key);
    if (handled.length > HANDLED_CAP) handled.shift();
    if (on) return false;
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

module.exports = { createLean };
