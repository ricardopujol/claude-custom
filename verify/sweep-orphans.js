'use strict';
/**
 * Stop the hosts a dead verify/ probe left behind (BACKLOG #169).
 *
 *   node verify/sweep-orphans.js            report what it would stop (dry run, the default)
 *   node verify/sweep-orphans.js --stop     stop it (takes the machine's heavy-work lock first, so no probe is mid-spawn)
 *   node verify/sweep-orphans.js --dir <path>   read another folder's hosts/ (default: this checkout's .harness)
 *
 * Only hosts whose identity file carries a probe's mark (host/probe-mark.js), whose own pid is proven by its recorded start
 * time, whose parent AND launching probe are both gone, and that no window is attached to, are ever stopped; every proof is in
 * verify/lib/orphan-sweep.js. A host without the mark, a person's live window, a host its probe is still using and a host
 * something has adopted are left alone, and each is said once. Nothing is matched by name. Electron roots a probe launched are
 * verify/reap-probes.js's (the ledger); this is for the hosts.
 *
 * WHICH FOLDER. One folder per run: the .harness of the checkout this script lives in. Run from a lane it reads only that lane's
 * hosts; run from dev\ it reads dev's .harness (where a person's live windows are too, but they carry no mark, so they are only
 * counted). A sweep run from one lane never sees another lane's hosts unless `--dir` points at them. Which probes are covered: every
 * verify/ script that starts a host or an Electron (test/probe-mark-coverage.test.js pins it); a host an older build started has no
 * mark and is never touched.
 *
 * Exit: 0 nothing wrong; 1 a stop failed (or the lock code itself threw: a bug, its stack is printed); 2 refused (bad
 * arguments, or the process table could not be read); 3 nothing was stopped but some running marked host could not be
 * proven either way (it is listed as "left"); 75 NOT RUN: --stop could not take the heavy lock (busy, machine too loaded,
 * or the lock script failed), nothing was swept, and the last line is the lock's own NOT RUN line (host/heavy-lock.js
 * notRunLine, the same contract as scripts/with-heavy-lock.js; #237 Miguel S5). Retry later.
 */
const path = require('path');
const { sweep } = require('./lib/orphan-sweep');

async function main(argv = process.argv.slice(2), {
  log = console.log, sweepFn = sweep, acquireLock = null, env = process.env,
} = {}) {
  const stop = argv.includes('--stop');
  const i = argv.indexOf('--dir');
  let dir = path.join(__dirname, '..', '.harness');
  if (i >= 0) {
    const value = argv[i + 1];
    // A forgotten path must not fall back to the checkout's own folder (and `--dir --stop` must not read a folder named "--stop").
    if (!value || value.startsWith('--')) { log('--dir needs a folder path; nothing was read or touched'); return 2; }
    dir = path.resolve(value);
  }
  let lock = null;
  if (stop) {
    // A probe holds this lock for its whole run, so while we hold it none is mid-spawn or about to adopt a host we are judging.
    const heavy = require('../host/heavy-lock');
    const acquire = acquireLock || heavy.acquire;
    try { lock = acquire({ label: 'sweep-orphans --stop', env, log }); } catch (err) {
      // Only the lock's own refusal is NOT RUN; anything else is a bug in the lock code (#237 Miguel M4, S5).
      if (!(err instanceof heavy.HeavyLockError)) {
        log(`[heavy-lock] the lock code itself failed (a bug, not a busy lock); nothing was stopped: ${(err && err.stack) || err}`);
        return 1;
      }
      log(`the heavy-work lock is not free (${err.message}); nothing was stopped. Run it again when it is.`);
      log(heavy.notRunLine(err));   // the last line
      return heavy.NOT_RUN_EXIT;
    }
  }
  let r;
  try { r = await sweepFn({ dir, dryRun: !stop }); } finally { if (lock && typeof lock.release === 'function') lock.release(); }
  if (r.unknown) { log('the process table could not be read; nothing was touched'); return 2; }
  const unprovenPids = new Set((r.unproven || []).map(u => u.pid));
  log(`${r.files} identity file${r.files === 1 ? '' : 's'} in ${path.join(dir, 'hosts')}: ${r.marked} marked, ${r.unmarked} unmarked (never touched), ${r.unreadable} unreadable`);
  for (const l of r.left) log(`  left   pid ${l.pid} port ${l.port}: ${l.why}${unprovenPids.has(l.pid) ? '  [RUNNING, could not be proven]' : ''}`);
  for (const w of r.wouldStop) log(`  ${stop ? 'orphan' : 'would stop'} pid ${w.pid} port ${w.port}: ${w.why}`);
  for (const s of r.stopped) log(`  stopped pid ${s.pid} port ${s.port}`);
  for (const f of r.failed) log(`  FAILED  pid ${f.pid} port ${f.port}: ${f.outcome}`);
  const doubt = (r.unproven || []).length;
  if (r.wouldStop.length === 0) {
    if (doubt > 0) log(`${doubt} running marked host${doubt === 1 ? '' : 's'} could not be proven either way (listed above); nothing stopped`);
    else log('no orphaned probe hosts; nothing stopped');
  } else if (!stop) log(`${r.wouldStop.length} would be stopped (run with --stop)`);
  else log(`stopped ${r.stopped.length}, failed ${r.failed.length}`);
  if (r.failed.length) return 1;
  return r.wouldStop.length === 0 && doubt > 0 ? 3 : 0;
}

module.exports = { main };

if (require.main === module) main().then((code) => { process.exitCode = code; });
