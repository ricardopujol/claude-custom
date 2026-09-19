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
 * WHAT THIS DOES NOT DO: swallow the failure. A save that cannot happen must
 * be reported, never reported as done -- the same rule the rest of this
 * codebase follows for absence. The retry buys the milliseconds the handle
 * needs; if the rename still fails, the caller still hears about it.
 */

// The codes that mean "someone is holding it, briefly". Deliberately a short
// allow-list rather than "retry anything": ENOENT means the temp file is not
// there, which is a real bug in the caller, and ENOSPC means the disk is
// full. Neither improves in 10ms, and retrying turns a clear failure into a
// slow one that looks like a hang.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

const fs = require('fs');

// A SYNCHRONOUS sleep, because both callers are synchronous: a vault save
// returns the saved entry, and a store write returns the written value.
// setTimeout cannot be awaited from either, and a busy loop would burn a core
// for the whole backoff on a machine already loaded enough to be holding the
// handle. Atomics.wait blocks the thread and yields it.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const ATTEMPTS = 5;

// Doubling from 20ms: 20 + 40 + 80 + 160 = 300ms of cover across four waits.
// Long enough to outlast a real on-write antivirus scan, short enough that a
// genuinely stuck rename still fails inside a third of a second rather than
// hanging the save. The happy path waits none of it.
const FIRST_WAIT_MS = 20;

function renameWithRetry(from, to, {
  rename = fs.renameSync, sleep = sleepSync, attempts = ATTEMPTS,
} = {}) {
  let wait = FIRST_WAIT_MS;
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT.has(err && err.code) || i >= attempts) throw err;
      sleep(wait);
      wait *= 2;
    }
  }
}

module.exports = { renameWithRetry, sleepSync, TRANSIENT, ATTEMPTS };
