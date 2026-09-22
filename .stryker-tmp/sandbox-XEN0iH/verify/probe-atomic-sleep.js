// @ts-nocheck
'use strict';
/**
 * Does Atomics.wait actually block in the ELECTRON MAIN PROCESS?  (re-runnable)
 *
 * Dexter, logic review of PR #30, Finding 2. `host/atomic-write.js`'s
 * `sleepSync` is exercised by the suite only under `node --test` -- the one
 * agent where [[CanBlock]] is already known to be true. But
 * `app/secret-vault.js` runs in the Electron MAIN process, and whether that
 * isolate can block is a property of how Electron creates it, not something
 * the repo can answer by being read.
 *
 * WHY IT MATTERS: if [[CanBlock]] is false there, the first real EPERM on a
 * vault save throws `TypeError: Atomics.wait cannot be called in this context`
 * from INSIDE the catch block. No retry happens at all, and the error the user
 * sees names Atomics rather than the rename -- strictly worse than having no
 * retry, on the exact path the measured bug was on. The suite would stay green
 * through the whole failure, because no unit test can reach this process.
 *
 * MEASURED 2026-09-21, Electron 33.4.11, process.type 'browser':
 *
 *   sleepSync(40) returned after 46ms         BLOCKS: true
 *   retry path survived: 3 attempts in 78ms   RETRY OK: true
 *
 * Re-run after any Electron major upgrade.
 *
 *   npx electron verify/probe-atomic-sleep.js
 */

const { app } = require('electron');
const path = require('path');
const { sleepSync, renameWithRetry } =
  require(path.join(__dirname, '..', 'host', 'atomic-write.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

app.whenReady().then(() => {
  console.log('[atomic-sleep] electron:', process.versions.electron);
  console.log('[atomic-sleep] process.type:', process.type);

  // 1. Does the sleep block at all, and for roughly the requested time?
  try {
    const t0 = Date.now();
    sleepSync(40);
    const slept = Date.now() - t0;
    check('sleepSync blocks in the Electron main process', slept >= 35, `${slept}ms for a 40ms sleep`);
  } catch (err) {
    check('sleepSync blocks in the Electron main process', false, `${err.name}: ${err.message}`);
  }

  // 2. The failure mode is a throw from INSIDE the catch block, so exercise the
  //    real retry path with a transient error rather than the sleep alone.
  try {
    let calls = 0;
    const t0 = Date.now();
    renameWithRetry('from', 'to', {
      rename: () => {
        calls++;
        if (calls < 3) { const e = new Error('EPERM (injected)'); e.code = 'EPERM'; throw e; }
      },
    });
    check('the retry path survives here', calls === 3, `${calls} attempts in ${Date.now() - t0}ms`);
  } catch (err) {
    check('the retry path survives here', false, `${err.name}: ${err.message}`);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  setTimeout(() => app.exit(failures ? 1 : 0), 200);
});
