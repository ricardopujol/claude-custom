'use strict';
/**
 * The resource sampler's own interface (host/resource-sampler.js createSampler: start, stop, setWanted, sampleNow, snapshot,
 * onUpdate) over the SHARED poller (host/shared-poller.js), BACKLOG #100 c. app/resources-service.js cannot tell the two apart.
 *
 * It is a createSampler whose samples come from `fetch` instead of a PowerShell call of its own, and whose timer is not the
 * cadence: the poller's owner samples at the strongest level any window wants (host/poller-policy.js CADENCE), so this side
 * only WAITS for the next record, takes it, and waits again. `viewing` in setWanted is the new fact: a page is showing the
 * Resources panel. With it, a window that shows the panel is `panel`, one that shows only the chip is `chip`, a minimised
 * one is `hidden`.
 *
 * Off-cadence (Stop's re-read) is the poller's sampleNow: the owner's own shell, or a follower's one-off call.
 */

const { createSampler, TIMEOUT_MS } = require('./resource-sampler');
const policy = require('./poller-policy');

/**
 * createSharedSampler({ poller, cores, onUpdate, now, log, setTimer, clearTimer }) -> the createSampler interface.
 * `poller` is host/shared-poller.js createSharedPoller's object (or a fake in a test).
 */
function createSharedSampler({ poller, ...rest } = {}) {
  let level = 'hidden';
  let lastKey = null;

  const fetch = (mode, adhoc) => {
    if (adhoc) return poller.sampleNow();
    const cad = policy.cadenceOf(level) || policy.CADENCE.chip;
    // A record older than two intervals is not "the latest": it would draw a window's first look with a stale figure.
    const wait = poller.next({ after: lastKey, maxAgeMs: cad.intervalMs * 2, timeoutMs: cad.intervalMs * 2 + TIMEOUT_MS });
    const out = wait.then((rec) => {
      lastKey = rec.key;
      if (!rec.ok) throw new Error(rec.error || 'the shared sample failed');
      return { text: rec.text, at: rec.at, mode: rec.mode };
    });
    out.kill = () => wait.kill();
    return out;
  };

  // intervalMs 0: the gap between takes is the poller's, so this side asks again as soon as it has taken one.
  const inner = createSampler({ ...rest, fetch, intervalMs: 0 });

  return {
    start() { poller.start(); inner.start(); },
    stop() { inner.stop(); poller.stop(); },
    setWanted(next) {
      const before = level;
      level = policy.fromWanted(next);
      poller.setLevel(level);
      inner.setWanted(next);
      // Nobody looking: a wait for a record that will not come is cancelled, not left to time out into a failure.
      if (level === 'hidden' && before !== 'hidden') poller.cancelWaiters();
    },
    sampleNow: () => inner.sampleNow(),
    snapshot: () => inner.snapshot(),
    level: () => level,
  };
}

module.exports = { createSharedSampler };
