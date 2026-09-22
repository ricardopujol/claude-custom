// @ts-nocheck
'use strict';

/**
 * Atomic write-and-rename, with the retry Windows requires.
 *
 * `fs.renameSync` is the atomic half of write-and-rename, and on Windows it
 * is also the fragile half: the OS fails a rename with EPERM, EACCES or
 * EBUSY whenever any process holds a handle to either path, even for a
 * moment. Something routinely does -- the real-time antivirus scan of the
 * file we have just finished writing, an indexer, a backup agent -- and it
 * clears in milliseconds.
 *
 * MEASURED here on 2026-09-18, mid test run:
 *
 *   EPERM: operation not permitted, rename
 *   '...\.secrets-46740-1789774020642.tmp' -> '...\secrets.enc'
 *
 * Unretried that is a vault save, or a settings write, that simply throws.
 *
 * WHO USES THIS, because the `host/` folder makes it look host-specific and it
 * is not: app/secret-vault.js (Electron MAIN process), host/store.js (the host
 * process) and host/openrouter.js (the catalogue cache, via the async twin).
 * Shared infrastructure that happens to live here; worth moving one day, not
 * worth moving in the change that found it.
 *
 * NOT SAFE IN A RENDERER as written: `sleepSync` needs SharedArrayBuffer,
 * which a renderer does not get without cross-origin isolation. Both
 * synchronous callers are main/host today.
 *
 * WHAT THIS DOES NOT DO: swallow the failure. A save that cannot happen must
 * be reported, never reported as done -- the same rule the rest of this
 * codebase follows for absence. The retry buys the milliseconds the handle
 * needs; if the rename still fails, the caller still hears about it.
 */

// The codes that mean "someone is holding it, briefly". Deliberately a short
// allow-list rather than "retry anything".
//
// ENOENT means the temp file is not there when the rename runs. The obvious
// cause is a caller bug -- but Dexter, Finding 7, named a second one that is
// not: the antivirus this module exists because of can QUARANTINE the temp
// between the write and the rename, which is the same adversary one step
// further along. Fail-fast is still right either way, since no amount of
// retrying conjures the payload back; the reason was the part that was wrong,
// and someone reading `ENOENT: rename` in a bug report would have gone looking
// in the caller for a fault that was never there.
//
// ENOSPC means the disk is full. Neither improves in 10ms, and retrying turns
// a clear failure into a slow one that looks like a hang.
// PRIVATE, and it stays private. Miguel: exported as a mutable Set, any
// consumer could `TRANSIENT.add('ENOENT')` and turn a deliberate fail-fast
// into five attempts against a file that will never exist -- changing this
// module's policy from the outside, invisibly, with every test still passing.
//
// Object.freeze does NOT fix that, which is worth writing down because it is
// the obvious fix and it silently does nothing: freezing a Set freezes its own
// properties, not its internal data, so `.add()` still succeeds. Verified
// rather than assumed -- `Object.freeze(new Set(['EPERM'])).add('ENOENT')`
// returns a Set of size 2.
//
// So the container is not exported at all; `isTransient` is. A predicate
// cannot be extended from the outside.
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
const TRANSIENT = new Set(stryMutAct_9fa48("332") ? [] : (stryCov_9fa48("332"), [stryMutAct_9fa48("333") ? "" : (stryCov_9fa48("333"), 'EPERM'), stryMutAct_9fa48("334") ? "" : (stryCov_9fa48("334"), 'EACCES'), stryMutAct_9fa48("335") ? "" : (stryCov_9fa48("335"), 'EBUSY')]));

// A frozen snapshot for anyone who needs to SEE the policy (tests, reports)
// without being able to change it. An array copy, so mutating it affects
// nothing.
const TRANSIENT_CODES = Object.freeze(stryMutAct_9fa48("336") ? [] : (stryCov_9fa48("336"), [...TRANSIENT]));
const fs = require('fs');
const fsp = require('fs/promises');

// A SYNCHRONOUS sleep, because both callers are synchronous: a vault save
// returns the saved entry, and a store write returns the written value.
// setTimeout cannot be awaited from either, and a busy loop would burn a core
// for the whole backoff on a machine already loaded enough to be holding the
// handle. Atomics.wait yields the CPU instead of spinning.
//
// BUT IT IS STILL A FREEZE, not merely a yielded core, and the earlier wording
// here obscured that (Dexter, Finding 2). It blocks the calling THREAD: for
// app/secret-vault.js that is the Electron main process, so a retrying vault
// save stops the message loop -- no IPC, no window events -- for up to 300ms.
// Acceptable for a user-initiated save, and worth knowing before this helper
// is reused anywhere hotter.
//
// That it works in that process at all is MEASURED, not assumed: see
// verify/probe-atomic-sleep.js. Electron 33.4.11, process.type 'browser',
// sleepSync(40) returned after 46ms. A unit test cannot answer this, because
// [[CanBlock]] is a property of the isolate and node --test is the one agent
// where it is already known to be true.
function sleepSync(ms) {
  if (stryMutAct_9fa48("337")) {
    {}
  } else {
    stryCov_9fa48("337");
    if (stryMutAct_9fa48("338")) {
      ;
    } else {
      stryCov_9fa48("338");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }
}

// The two things the sync and async versions must never disagree about, named
// once. Miguel: shipping near-identical twins is fine -- that duplication is
// control flow, the harmless kind -- but the transient predicate and the
// backoff step appearing twice each is duplication of the POLICY, and that is
// the kind that drifts. A change to either that updated only one copy would
// stay invisible until someone hit the other path.
const isTransient = stryMutAct_9fa48("339") ? () => undefined : (stryCov_9fa48("339"), (() => {
  const isTransient = err => TRANSIENT.has(stryMutAct_9fa48("342") ? err || err.code : stryMutAct_9fa48("341") ? false : stryMutAct_9fa48("340") ? true : (stryCov_9fa48("340", "341", "342"), err && err.code));
  return isTransient;
})());
const nextWait = stryMutAct_9fa48("343") ? () => undefined : (stryCov_9fa48("343"), (() => {
  const nextWait = prev => stryMutAct_9fa48("344") ? prev / 2 : (stryCov_9fa48("344"), prev * 2);
  return nextWait;
})());
const ATTEMPTS = 5;

// Doubling from 20ms: 20 + 40 + 80 + 160 = 300ms of cover across four waits.
// Long enough to outlast a real on-write antivirus scan, short enough that a
// genuinely stuck rename still fails inside a third of a second rather than
// hanging the save. The happy path waits none of it.
const FIRST_WAIT_MS = 20;
function renameWithRetry(from, to, {
  rename = fs.renameSync,
  sleep = sleepSync,
  attempts = ATTEMPTS
} = {}) {
  if (stryMutAct_9fa48("345")) {
    {}
  } else {
    stryCov_9fa48("345");
    // Validated before the loop, so the loop is BOUNDED BY CONSTRUCTION rather
    // than by a conditional inside it.
    //
    // HISTORY (Dexter, Finding 6): with `for (;;)` and `i >= attempts` as the
    // only exit, `attempts: NaN` never terminated -- every comparison against
    // NaN is false, `wait` doubled to Infinity after ~1070 passes, and
    // `Atomics.wait(..., Infinity)` then blocked forever. A synchronous,
    // uninterruptible hang of whichever process called it, which for the vault
    // is the Electron main process.
    //
    // WHAT THE GUARD ACTUALLY DOES NOW, which is not the same thing (Miguel):
    // the new loop shape already handles NaN -- `1 <= NaN` is false, the body
    // never runs -- but it would then `throw last`, which is `undefined`. So
    // this check is LOAD-BEARING for `Infinity`, where `i <= Infinity` is
    // forever true and the loop would still never end, and it is hygiene for
    // everything else: it turns "throws undefined" into an error that says what
    // went wrong. Keeping the old rationale here without this would have left a
    // comment describing a hang the code can no longer have.
    if (stryMutAct_9fa48("346")) {
      ;
    } else {
      stryCov_9fa48("346");
      assertAttempts(attempts);
    }
    let wait = FIRST_WAIT_MS;
    let last;
    for (let i = 1; stryMutAct_9fa48("349") ? i > attempts : stryMutAct_9fa48("348") ? i < attempts : stryMutAct_9fa48("347") ? false : (stryCov_9fa48("347", "348", "349"), i <= attempts); stryMutAct_9fa48("350") ? i-- : (stryCov_9fa48("350"), i++)) {
      if (stryMutAct_9fa48("351")) {
        {}
      } else {
        stryCov_9fa48("351");
        try {
          if (stryMutAct_9fa48("352")) {
            {}
          } else {
            stryCov_9fa48("352");
            if (stryMutAct_9fa48("353")) {
              ;
            } else {
              stryCov_9fa48("353");
              rename(from, to);
            }
            return;
          }
        } catch (err) {
          if (stryMutAct_9fa48("354")) {
            {}
          } else {
            stryCov_9fa48("354");
            last = err;
            // A non-transient code is hopeless: retrying cannot make a missing file
            // appear or a full disk empty, and it would turn a clear failure slow.
            if (stryMutAct_9fa48("357") ? false : stryMutAct_9fa48("356") ? true : stryMutAct_9fa48("355") ? isTransient(err) : (stryCov_9fa48("355", "356", "357"), !isTransient(err))) throw err;
            if (stryMutAct_9fa48("361") ? i >= attempts : stryMutAct_9fa48("360") ? i <= attempts : stryMutAct_9fa48("359") ? false : stryMutAct_9fa48("358") ? true : (stryCov_9fa48("358", "359", "360", "361"), i < attempts)) {
              if (stryMutAct_9fa48("362")) {
                {}
              } else {
                stryCov_9fa48("362");
                if (stryMutAct_9fa48("363")) {
                  ;
                } else {
                  stryCov_9fa48("363");
                  sleep(wait);
                }
                wait = nextWait(wait);
              }
            }
          }
        }
      }
    }
    throw last; // the error from the FINAL attempt
  }
}

// The async sleep. A caller that can yield MUST yield: freezing the thread
// with Atomics.wait is a cost the synchronous callers have no way around, not
// something to spread to one that does.
const sleepAsync = stryMutAct_9fa48("364") ? () => undefined : (stryCov_9fa48("364"), (() => {
  const sleepAsync = ms => new Promise(stryMutAct_9fa48("365") ? () => undefined : (stryCov_9fa48("365"), resolve => setTimeout(resolve, ms)));
  return sleepAsync;
})());
function assertAttempts(attempts) {
  if (stryMutAct_9fa48("366")) {
    {}
  } else {
    stryCov_9fa48("366");
    if (stryMutAct_9fa48("369") ? !Number.isInteger(attempts) && attempts < 1 : stryMutAct_9fa48("368") ? false : stryMutAct_9fa48("367") ? true : (stryCov_9fa48("367", "368", "369"), (stryMutAct_9fa48("370") ? Number.isInteger(attempts) : (stryCov_9fa48("370"), !Number.isInteger(attempts))) || (stryMutAct_9fa48("373") ? attempts >= 1 : stryMutAct_9fa48("372") ? attempts <= 1 : stryMutAct_9fa48("371") ? false : (stryCov_9fa48("371", "372", "373"), attempts < 1)))) {
      if (stryMutAct_9fa48("374")) {
        {}
      } else {
        stryCov_9fa48("374");
        throw new Error(stryMutAct_9fa48("376") ? `` : (stryCov_9fa48("376"), `renameWithRetry: attempts must be a positive integer, got ${String(attempts)}`));
      }
    }
  }
}

/**
 * The same retry, for callers that await.
 *
 * Dexter, Finding 5: `host/openrouter.js` does the identical
 * write-to-temp-then-rename with `await fsp.rename`, inside a try/catch that
 * swallows everything. On the machine this module exists for -- where a handle
 * is briefly held on every write -- that rename throws EPERM, is swallowed,
 * and the model catalogue cache is NEVER written. `readCache` then always
 * returns null and every launch pays a network fetch, with nothing reporting
 * it, because the catch there reasonably says an unwritable cache is a slower
 * panel rather than a broken one.
 *
 * That reasoning is sound for a write that FAILS occasionally. It is what
 * hides a write that never succeeds at all, which is the actual situation.
 *
 * Still rejects if the rename never lands. The caller may swallow that --
 * openrouter does, deliberately -- but it has to be the caller's choice,
 * taken knowingly, rather than something this helper decides for it.
 */
async function renameWithRetryAsync(from, to, {
  rename = fsp.rename,
  sleep = sleepAsync,
  attempts = ATTEMPTS
} = {}) {
  if (stryMutAct_9fa48("377")) {
    {}
  } else {
    stryCov_9fa48("377");
    if (stryMutAct_9fa48("378")) {
      ;
    } else {
      stryCov_9fa48("378");
      assertAttempts(attempts);
    }
    let wait = FIRST_WAIT_MS;
    let last;
    for (let i = 1; stryMutAct_9fa48("381") ? i > attempts : stryMutAct_9fa48("380") ? i < attempts : stryMutAct_9fa48("379") ? false : (stryCov_9fa48("379", "380", "381"), i <= attempts); stryMutAct_9fa48("382") ? i-- : (stryCov_9fa48("382"), i++)) {
      if (stryMutAct_9fa48("383")) {
        {}
      } else {
        stryCov_9fa48("383");
        try {
          if (stryMutAct_9fa48("384")) {
            {}
          } else {
            stryCov_9fa48("384");
            await rename(from, to);
            return;
          }
        } catch (err) {
          if (stryMutAct_9fa48("385")) {
            {}
          } else {
            stryCov_9fa48("385");
            last = err;
            if (stryMutAct_9fa48("388") ? false : stryMutAct_9fa48("387") ? true : stryMutAct_9fa48("386") ? isTransient(err) : (stryCov_9fa48("386", "387", "388"), !isTransient(err))) throw err;
            if (stryMutAct_9fa48("392") ? i >= attempts : stryMutAct_9fa48("391") ? i <= attempts : stryMutAct_9fa48("390") ? false : stryMutAct_9fa48("389") ? true : (stryCov_9fa48("389", "390", "391", "392"), i < attempts)) {
              if (stryMutAct_9fa48("393")) {
                {}
              } else {
                stryCov_9fa48("393");
                await sleep(wait);
                wait = nextWait(wait);
              }
            }
          }
        }
      }
    }
    throw last;
  }
}

// `sleepAsync` is deliberately NOT exported: nothing imports it, and an
// unused export is surface that invites a second, divergent caller.
// `sleepSync` is, because verify/probe-atomic-sleep.js measures it directly.
module.exports = stryMutAct_9fa48("394") ? {} : (stryCov_9fa48("394"), {
  renameWithRetry,
  renameWithRetryAsync,
  sleepSync,
  isTransient,
  nextWait,
  TRANSIENT_CODES,
  ATTEMPTS,
  FIRST_WAIT_MS
});