'use strict';
/**
 * Coalesce an event-triggered async read, without losing the last event.
 *
 * THE DEFECT THIS EXISTS FOR. Vera (display-integrity-auditor) 2026-09-14, and
 * Miguel independently, on `refreshAgentStats`:
 *
 *     if (agentStatsPending) return agentStatsPending;
 *
 * That is correct for DEDUPLICATING concurrent reads and wrong for the
 * CORRECTNESS of the last one. A read that started before an event cannot
 * reflect that event. Concretely: two agents finish 50ms apart; the second
 * `SubagentStop` is handed the in-flight promise, which began before that agent
 * had finished writing its transcript; both callers broadcast the same stale
 * snapshot; and since nothing else re-reads, the second agent's run stays
 * missing from the panel indefinitely.
 *
 * This project's own merge gate mandates running two reviewers IN PARALLEL on
 * every branch, so "two agents finish seconds apart" is the normal case here,
 * not an edge case.
 *
 * The shape is a dirty flag: while a read is in flight, a new request does not
 * start a second read (that would race and double the disk cost the coalescing
 * exists to avoid) and does not get the stale one either. It marks the result
 * dirty, and exactly one fresh read starts when the current one settles --
 * however many requests arrived in the meantime.
 *
 * Failure does not wedge it. A rejected read clears the in-flight slot and
 * still honours a queued request: leaving `pending` set after a failure would
 * hand every later caller a dead promise and freeze the panel for the life of
 * the host.
 */

function createCoalescer(fn) {
  let pending = null;      // the read currently in flight
  let queued = null;       // the promise handed to callers who arrived mid-flight
  let resolveQueued = null;
  let rejectQueued = null;

  function start() {
    // `fn` is invoked SYNCHRONOUSLY, not deferred through a microtask: a caller
    // that has just handled an event expects the read to be in flight when the
    // call returns, and deferring it opens a window in which a second caller
    // sees no pending read and starts a competing one.
    let run;
    try {
      run = Promise.resolve(fn());
    } catch (err) {
      run = Promise.reject(err);
    }
    pending = run;

    run.then(() => settle(run), () => settle(run));
    return run;
  }

  // Clearing `pending` and launching any queued re-run happen together, so
  // there is never a window where a request sees no flight AND no queue.
  function settle(run) {
    if (pending === run) pending = null;
    if (!queued) return;

    const resolve = resolveQueued;
    const reject = rejectQueued;
    queued = null;
    resolveQueued = null;
    rejectQueued = null;

    // The queued callers asked for a read that reflects THEIR event, so they
    // get the result of the FRESH run, never the one that just finished.
    start().then(resolve, reject);
  }

  return function coalesced() {
    if (!pending) return start();

    if (!queued) {
      queued = new Promise((res, rej) => { resolveQueued = res; rejectQueued = rej; });
    }
    return queued;
  };
}

module.exports = { createCoalescer };
