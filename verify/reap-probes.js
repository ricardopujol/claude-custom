'use strict';
/**
 * Kill the probe Electrons a dead probe left behind (BACKLOG #74 B).
 *
 *   node verify/reap-probes.js            report what it would kill (dry run)
 *   node verify/reap-probes.js --kill     kill it
 *
 * Only ledger entries (host/pid-ledger.js, written by verify/lib/launch-electron.js) are ever considered. One is
 * killed only if the pid is running with the START TIME the ledger recorded (a reused pid is a different process) and
 * its launcher is gone. The tree is killed BY PID (host/kill-tree.js); no process is ever named, and a process whose
 * start time cannot be read is left alone. Lines whose process is gone or replaced are dropped.
 *
 * A process already exiting ignores the kill, so one that is still listed afterwards keeps its line for the next run.
 */
const ledger = require('../host/pid-ledger');
const { startTimes: realStartTimes } = require('../host/proc-start');
const { killPidTree } = require('../host/kill-tree');

async function reap({ file = ledger.defaultLedgerFile(), startTimes = realStartTimes, kill = killPidTree, dryRun = true, stillRunning, now = Date.now(), minAgeMs = 0 } = {}) {
  const entries = ledger.readLedger(file);
  const result = { entries: entries.length, verified: true, wouldKill: [], killed: [], failed: [], dropped: [] };
  if (entries.length === 0) return result;

  const pids = new Set();
  for (const e of entries) { pids.add(e.pid); if (e.launcher) pids.add(e.launcher.pid); }
  const starts = await startTimes([...pids]);
  if (starts === null) { result.verified = false; return result; }

  const targets = ledger.selectReapable(entries, starts, { now, minAgeMs });
  result.wouldKill = targets.map(e => e.pid);
  if (dryRun) return result;

  for (const e of targets) {
    try { kill(e.pid); } catch (err) { console.log(`[reap] kill ${e.pid} failed: ${err && err.message}`); }
  }
  // What is still running afterwards keeps its line. Default: ask again, by the same proof.
  const left = stillRunning
    ? await stillRunning(targets.map(e => e.pid))
    : await (async () => {
      const again = await startTimes(targets.map(e => e.pid));
      return new Set(targets.filter(e => again && again.has(e.pid) && again.get(e.pid) === e.start).map(e => e.pid));
    })();
  for (const e of targets) (left.has(e.pid) ? result.failed : result.killed).push(e.pid);

  const stale = ledger.staleEntries(entries, starts).map(e => e.pid);
  result.dropped = stale;
  ledger.removePids(file, [...result.killed, ...stale]);
  return result;
}

module.exports = { reap };

if (require.main === module) {
  const kill = process.argv.includes('--kill');
  reap({ dryRun: !kill }).then((r) => {
    if (!r.verified) { console.log('could not read process start times; nothing was touched'); process.exit(2); }
    console.log(`${r.entries} ledger entr${r.entries === 1 ? 'y' : 'ies'}; ` +
      (kill ? `killed ${r.killed.length} [${r.killed.join(', ')}], still running ${r.failed.length} [${r.failed.join(', ')}]`
        : `would kill ${r.wouldKill.length} [${r.wouldKill.join(', ')}] (run with --kill)`) +
      `; dropped ${r.dropped.length} stale`);
  });
}
