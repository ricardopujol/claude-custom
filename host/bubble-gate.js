'use strict';
/**
 * The speech bubbles' rate limit and queue (BACKLOG #80, rules from #55).
 *
 *   createBubbleGate({ now })
 *     .offer(agent) -> { ok: true }                       the caller now owns the one request slot; it MUST call done()
 *                    | { ok: false, reason: 'busy' }      another bubble's model request is running: DROPPED, not queued
 *                    | { ok: false, reason: 'rate' }      this agent had a bubble less than MIN_GAP_MS ago
 *     .done()        -> the request finished (or failed): the slot is free again
 *     .remembered()  -> how many agents the gate still remembers (bounded)
 *
 * The gap counts from the moment a request is ACCEPTED, so an Ollama that is down can't be hammered by a flapping agent. A
 * request that is dropped (busy or rate) starts nothing. A clock that steps back never opens the gate early: the elapsed time
 * is only trusted when it is not negative.
 */

const MIN_GAP_MS = 3 * 60_000;
const REMEMBER_MAX = 1000;

// A duration clock, not the wall clock: a step back must not hold an agent silent for the length of the step.
const monotonic = () => performance.now();

function createBubbleGate({ now = monotonic, minGapMs = MIN_GAP_MS } = {}) {
  // A Map, so an agent called `__proto__` or `toString` is an ordinary key.
  const last = new Map();
  let inFlight = false;

  function prune(t) {
    if (last.size <= REMEMBER_MAX) return;
    for (const [agent, at] of last) if (t - at >= minGapMs) last.delete(agent);
    // Still over (everyone is recent): drop the oldest, Map keeps insertion order and re-set moves a key to the end.
    while (last.size > REMEMBER_MAX) last.delete(last.keys().next().value);
  }

  function offer(agent) {
    if (inFlight) return { ok: false, reason: 'busy' };
    const t = now();
    const at = last.get(agent);
    if (at !== undefined) {
      const elapsed = t - at;
      if (!(elapsed >= minGapMs)) return { ok: false, reason: 'rate' };
    }
    last.delete(agent);
    last.set(agent, t);
    inFlight = true;
    prune(t);
    return { ok: true };
  }

  function done() { inFlight = false; }

  return { offer, done, remembered: () => last.size };
}

module.exports = { createBubbleGate, MIN_GAP_MS, monotonic };
