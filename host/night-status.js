'use strict';
/**
 * What the host tells every window about the bedtime night (backlog #52, documentation/DESIGN_TERMINAL_BAR.md):
 * host/bedtime-state.js's view plus "PRs so far", and nothing else.
 *
 *   createNightStatus({ bedtime, countPrs, now, onChange })
 *     handle(event)   feed one hook event; pushes when the payload changed
 *     tick()          re-judge the clock (overdue is a verdict of time, not an event); pushes when it changed
 *     payload()       { startedAt, nextWakeAt|null, awake, wakes, lastWakeAt|null, prs|null } | null
 *
 * `onChange(payload)` is called only when the payload differs from what it last said, and a `null` means "no
 * night": every window drops its chip. The PR count is asked of `countPrs(startedAt)` (host/night-prs.js) at the
 * start and again at every wake, never per event. It is `null` -- UNKNOWN, drawn "PRs: ?" -- until gh answers,
 * and when gh can't; an answer that arrives after its night ended (or after a newer night began) is dropped.
 * A throwing listener or a throwing gh never reaches the host's hook handler.
 */

const { PR_LIMIT } = require('./night-prs');

function createNightStatus({ bedtime, countPrs = async () => null, now = Date.now, onChange = () => {} } = {}) {
  let prs = null;
  let prsStale = false;      // gh isn't answering now, and `prs` is the last answer
  let prsCapped = false;     // `prs` reached gh's list limit: a floor
  let prsFor = null;         // the night (its startedAt) `prs` answers for
  let wakesAsked = 0;        // the wake count the last question was asked at
  let lastSent = 'null';

  function payload() {
    const v = bedtime.view(now());
    if (v === null) return null;
    const mine = prsFor === v.startedAt;
    return { ...v, prs: mine ? prs : null, prsStale: mine && prs !== null && prsStale, prsCapped: mine && prs !== null && prsCapped };
  }

  function push() {
    const p = payload();
    if (p === null) { prs = null; prsFor = null; prsStale = false; prsCapped = false; wakesAsked = 0; }
    const text = JSON.stringify(p);
    if (text === lastSent) return;
    lastSent = text;
    try { onChange(p); } catch { /* a listener must never wedge the hook handler */ }
  }

  function ask(since) {
    let asked;
    try { asked = Promise.resolve(countPrs(since)); } catch { asked = Promise.resolve(null); }
    asked.then((n) => n, () => null).then((n) => {
      if (prsFor !== since) return;                       // that night is over, or a newer one began
      const known = Number.isInteger(n) && n >= 0;
      // A failed ask after a good answer keeps the number, marked stale (the count only grows within a night); only a
      // night that never had an answer shows "?".
      const nextStale = !known && prs !== null;
      const nextPrs = known ? n : prs;
      const nextCapped = known ? n >= PR_LIMIT : prsCapped;
      if (nextPrs === prs && nextStale === prsStale && nextCapped === prsCapped) return;
      prs = nextPrs;
      prsStale = nextStale;
      prsCapped = nextCapped;
      push();
    });
  }

  function handle(ev) {
    bedtime.handle(ev);
    const v = bedtime.view(now());
    if (v !== null) {
      if (prsFor !== v.startedAt) {
        prsFor = v.startedAt;
        prs = null;
        prsStale = false;
        prsCapped = false;
        wakesAsked = v.wakes;
        ask(v.startedAt);
      } else if (v.wakes !== wakesAsked) {
        wakesAsked = v.wakes;
        ask(v.startedAt);
      }
    }
    push();
  }

  return { handle, tick: push, payload };
}

module.exports = { createNightStatus };
