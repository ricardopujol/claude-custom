'use strict';
/**
 * The open queue (single-instance PR 3, step 5): every open main runs (a launch handed over on the app pipe, the tray, the ▾ menu, the probe
 * driver, a crash restore) goes through here, one at a time, in arrival order, so two opens never race each other's window construction.
 *
 * A STUCK START MUST NOT BLOCK EVERY LATER LAUNCH (plan risk 5): an open that has not settled after boundMs frees its slot (said once in
 * the log) and its push resolves { ok: false, error: 'timed out' }; the open itself goes on, and the next one runs. A throw resolves its
 * push { ok: false, error } and never stops the queue. No Electron.
 *
 *   createOpenQueue({ open(job) -> Promise, boundMs = 60000, log }) -> { push(job) -> Promise, busy() }
 */

function createOpenQueue({ open, boundMs = 60_000, log = () => {} } = {}) {
  let tail = Promise.resolve();
  let pending = 0;

  function runOne(job) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => {
        log(`[main] an open did not settle within ${boundMs} ms; the next one runs`);
        finish({ ok: false, error: 'timed out' });
      }, boundMs);
      if (timer.unref) timer.unref();
      let p;
      try { p = Promise.resolve(open(job)); } catch (err) { p = Promise.reject(err); }
      p.then(finish, (err) => finish({ ok: false, error: String((err && err.message) || err) }));
    });
  }

  let idle = [];
  const flushIdle = () => { if (pending > 0) return; const fns = idle; idle = []; for (const fn of fns) { try { fn(); } catch (err) { log(`[main] open queue idle: ${err && err.message}`); } } };

  function push(job) {
    pending++;
    const r = tail.then(() => runOne(job));
    tail = r.then(() => {}, () => {});
    return r.finally(() => { pending--; if (pending === 0) setImmediate(flushIdle); });
  }

  /** Run fn once nothing is opening (on the next tick when nothing is): main's quit after the last window closed (PR #258 Dexter 7). */
  function onIdle(fn) {
    idle.push(fn);
    if (pending === 0) setImmediate(flushIdle);
  }

  return { push, busy: () => pending > 0, onIdle };
}

module.exports = { createOpenQueue };
