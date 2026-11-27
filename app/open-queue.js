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

  function push(job) {
    pending++;
    const r = tail.then(() => runOne(job));
    tail = r.then(() => {}, () => {});
    return r.finally(() => { pending--; });
  }

  return { push, busy: () => pending > 0 };
}

module.exports = { createOpenQueue };
