'use strict';
/**
 * The in-flight-request bookkeeping around `host/openrouter.js`'s
 * `loadCatalogue`, pulled out of `host/host.js` so it can be unit tested.
 *
 * Dexter/Miguel, PR #60 review (F5/S1). `host.js` is ~1300 lines of
 * module-level wiring that cannot be `require()`d into a unit test without
 * spawning a pty -- which is exactly how this dedupe bug shipped untested in
 * the first place. The logic itself has nothing host-specific in it (it is a
 * promise-memoization policy over an injected loader), so it moves here.
 *
 * THE BUG THIS EXISTS TO FIX: `.finally(() => { pending = null; })` on the
 * SHARED slot clears it unconditionally. When a `force` call starts a second
 * fetch while an earlier one is still in flight, whichever of the two
 * settles FIRST clears the slot out from under the other -- a third caller
 * arriving in that window sees no pending promise and starts a THIRD
 * concurrent fetch, silently violating "exactly one request in flight".
 * Fixed by capturing the promise EACH call creates and only clearing the
 * slot if it is still the one sitting in it.
 *
 * `force` still always starts its own fetch rather than joining whatever is
 * in flight: a forced caller (the Refresh button) must get a real network
 * answer, never a joined cache-hit promise from an unrelated non-forced call
 * that happened to be in flight at the same moment.
 */
function createCatalogueCache({ loadCatalogue, cacheFile, normalize = (x) => x }) {
  let pending = null;

  function current({ force = false } = {}) {
    if (pending && !force) return pending;
    const promise = loadCatalogue({ cacheFile, force })
      .then((r) => ({ ...r, models: normalize(r.rows), rows: undefined }));
    pending = promise;
    // Dexter, PR #60 round 2, N4 (latent): `.finally()` returns a NEW promise
    // that re-rejects with `promise`'s own reason if `promise` rejects, and
    // nothing else holds a reference to THIS one. `promise` itself is
    // returned to the caller, who is expected to handle it -- but this
    // derived one is not, and with no `.catch` it is an unhandled rejection,
    // which Node's default `--unhandled-rejections=throw` turns into a
    // crashed host. Unreachable TODAY (`loadCatalogue` is total: readCache,
    // fetch and writeCache all catch; `normalize` is defensive) -- exactly
    // why this is Low, and exactly why it is fixed anyway rather than relied
    // on staying unreachable forever.
    promise.finally(() => { if (pending === promise) pending = null; }).catch(() => {});
    return promise;
  }

  return { current };
}

module.exports = { createCatalogueCache };
