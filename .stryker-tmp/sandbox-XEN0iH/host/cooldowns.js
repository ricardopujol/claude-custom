// @ts-nocheck
'use strict';
/**
 * Per-agent cooldowns for expensive agents.
 *
 * ADVISORY, NEVER BLOCKING. The harness does not refuse to run an agent; the
 * point is to make a cost visible, not to overrule a deliberate decision.
 *
 * Mortimer (mutation-tester) is the motivating case: the project rule is that
 * mutation testing runs LAST, ONCE, against a stable tree, because a score is a
 * property of a fixed codebase. That rule is currently kept only by memory and
 * has already been broken once, wasting a full run.
 *
 * Persisted, because a cooldown that resets when the GUI reopens enforces
 * nothing.
 */

// Milliseconds. Only agents listed here cool down at all.
const DEFAULT_COOLDOWNS = {
  'mutation-tester': 30 * 60 * 1000,   // expensive in wall-clock; one run per stable tree
  'penetration-tester': 15 * 60 * 1000,
  'chaos-engineer': 15 * 60 * 1000,
};

const STORE_KEY = 'cooldowns';

function createCooldowns({ now = Date.now, store, cooldowns = DEFAULT_COOLDOWNS } = {}) {
  if (!store) throw new Error('createCooldowns: store is required');

  const load = () => store.read(STORE_KEY, {});
  const save = (v) => store.write(STORE_KEY, v);

  function finished(agent) {
    // hasOwnProperty, not a bare read. `agent` comes from the hook payload, and
    // a bare lookup of 'constructor' or 'toString' resolves to an inherited
    // FUNCTION: truthy, so it passes the guard, then `now() + duration` string-
    // concatenates, `until` is persisted as a string, `until <= t` compares as
    // NaN and is never true -- an immortal cooldown rendering "NaNm" forever
    // with no way to clear it.
    const duration = Object.prototype.hasOwnProperty.call(cooldowns, agent)
      ? cooldowns[agent] : undefined;
    if (typeof duration !== 'number' || !(duration > 0)) return;   // not an expensive agent
    const state = load();
    // Restart the clock rather than stacking: two runs in a row is one thing to
    // warn about, not a doubled penalty.
    state[agent] = { until: now() + duration, duration };
    save(state);
  }

  function list() {
    const t = now();
    const state = load();
    let changed = false;

    const active = [];
    for (const [agent, entry] of Object.entries(state)) {
      if (!entry || entry.until <= t) { delete state[agent]; changed = true; continue; }
      active.push({ agent, remainingMs: entry.until - t, durationMs: entry.duration });
    }
    if (changed) save(state);

    // Soonest to expire first: that is the one about to become available.
    return active.sort((a, b) => a.remainingMs - b.remainingMs);
  }

  const isCooling = (agent) => list().some(c => c.agent === agent);

  return { finished, list, isCooling };
}

module.exports = { createCooldowns, DEFAULT_COOLDOWNS };
