'use strict';
/**
 * One project window's timers and its crash guard (single-instance PR 2, step 7).
 *
 * With several windows in one process, a timer that outlives its window ticks a dead shell for the life of the app, and a tick that
 * throws must cost that window one tick, never the process: so the poll, the issue-list warm-up and the dev-servers sampling run
 * through guard(), and dispose() stops what is running. Pure: the timer functions are injectable, so this loads under plain node and
 * is tested with node:test's mock timers.
 *
 *   guard(what, fn)          a function that logs `[<label>] <what> failed: ...` when fn throws (or returns a rejected promise) and
 *                            never rethrows
 *   startPoll(ms, tick)      the window's poll: one at a time (a second call is ignored), through guard
 *   later(what, ms, fn)      a one-shot (unref'd), through guard, cleared by dispose()
 *   pollActive()             whether the poll is running
 *   dispose()                clear the poll and every pending one-shot; idempotent; nothing ticks afterwards
 */

function createWindowTimers({ label, log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let poll = null;
  let disposed = false;
  const pending = new Set();

  const fail = (what, err) => log(`[${label}] ${what} failed: ${(err && err.stack) || err}`);

  function guard(what, fn) {
    return (...args) => {
      try {
        const r = fn(...args);
        // a rejected promise is logged and settles as undefined: nobody awaiting a guarded call sees a throw either
        if (r && typeof r.then === 'function') return r.then(undefined, (err) => { fail(what, err); });
        return r;
      } catch (err) {
        fail(what, err);
        return undefined;
      }
    };
  }

  return {
    guard,
    startPoll(ms, tick) {
      if (disposed || poll !== null) return false;
      poll = setIntervalFn(guard('poll', tick), ms);
      return true;
    },
    later(what, ms, fn) {
      if (disposed) return null;
      const t = setTimeoutFn(() => { pending.delete(t); guard(what, fn)(); }, ms);
      if (t && typeof t.unref === 'function') t.unref();
      pending.add(t);
      return t;
    },
    pollActive: () => poll !== null,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (poll !== null) { clearIntervalFn(poll); poll = null; }
      for (const t of pending) clearTimeoutFn(t);
      pending.clear();
    },
  };
}

module.exports = { createWindowTimers };
