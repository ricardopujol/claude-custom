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
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

// A frozen snapshot for anyone who needs to SEE the policy (tests, reports)
// without being able to change it. An array copy, so mutating it affects
// nothing.
const TRANSIENT_CODES = Object.freeze([...TRANSIENT]);

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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The two things the sync and async versions must never disagree about, named
// once. Miguel: shipping near-identical twins is fine -- that duplication is
// control flow, the harmless kind -- but the transient predicate and the
// backoff step appearing twice each is duplication of the POLICY, and that is
// the kind that drifts. A change to either that updated only one copy would
// stay invisible until someone hit the other path.
const isTransient = err => TRANSIENT.has(err && err.code);
const nextWait = prev => prev * 2;

const ATTEMPTS = 5;

// Doubling from 20ms: 20 + 40 + 80 + 160 = 300ms of cover across four waits.
// Long enough to outlast a real on-write antivirus scan, short enough that a
// genuinely stuck rename still fails inside a third of a second rather than
// hanging the save. The happy path waits none of it.
const FIRST_WAIT_MS = 20;

function renameWithRetry(from, to, {
  rename = fs.renameSync, sleep = sleepSync, attempts = ATTEMPTS,
} = {}) {
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
  assertAttempts(attempts);

  let wait = FIRST_WAIT_MS;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      last = err;
      // A non-transient code is hopeless: retrying cannot make a missing file
      // appear or a full disk empty, and it would turn a clear failure slow.
      if (!isTransient(err)) throw err;
      if (i < attempts) {
        sleep(wait);
        wait = nextWait(wait);
      }
    }
  }
  throw last;                       // the error from the FINAL attempt
}

// The async sleep. A caller that can yield MUST yield: freezing the thread
// with Atomics.wait is a cost the synchronous callers have no way around, not
// something to spread to one that does.
const sleepAsync = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function assertAttempts(attempts) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `renameWithRetry: attempts must be a positive integer, got ${String(attempts)}`);
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
  rename = fsp.rename, sleep = sleepAsync, attempts = ATTEMPTS,
} = {}) {
  assertAttempts(attempts);

  let wait = FIRST_WAIT_MS;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      last = err;
      if (!isTransient(err)) throw err;
      if (i < attempts) {
        await sleep(wait);
        wait = nextWait(wait);
      }
    }
  }
  throw last;
}

// `sleepAsync` is deliberately NOT exported: nothing imports it, and an
// unused export is surface that invites a second, divergent caller.
// `sleepSync` is, because verify/probe-atomic-sleep.js measures it directly.
module.exports = {
  renameWithRetry, renameWithRetryAsync, sleepSync,
  isTransient, nextWait, TRANSIENT_CODES, ATTEMPTS, FIRST_WAIT_MS,
};
