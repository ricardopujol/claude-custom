'use strict';
/**
 * Kill the probe Electrons a dead probe left behind (BACKLOG #74 B).
 *
 *   node verify/reap-probes.js            report what it would kill (dry run)
 *   node verify/reap-probes.js --kill     kill it
 *
 * Only ledger entries (host/pid-ledger.js, written by verify/lib/launch-electron.js) are ever considered. One is
 * killed only if the pid is running with the START TIME the ledger recorded (a reused pid is a different process) and
 * its launcher is gone. The tree is killed BY PID through host/kill-tree.js's killProven, which re-proves the start time
 * on a held process handle in the same step (no window for the pid to change owner); no process is ever named, and a
 * process whose start time cannot be read is left alone. Lines whose process is gone or replaced are dropped.
 *
 * A process already exiting ignores the kill, so one that is still listed afterwards keeps its line for the next run.
 */
const ledger = require('../host/pid-ledger');
const { startTimes: realStartTimes } = require('../host/proc-start');
const { killProven } = require('../host/kill-tree');

async function reap({ file = ledger.defaultLedgerFile(), startTimes = realStartTimes, kill = killProven, dryRun = true, stillRunning, now = Date.now(), minAgeMs = 0, ledgerDeadlineMs } = {}) {
  const entries = ledger.readLedger(file);
  const result = { entries: entries.length, verified: true, wouldKill: [], killed: [], failed: [], dropped: [], ledger: { ok: true } };
  if (entries.length === 0) return result;

  const pids = new Set();
  for (const e of entries) { pids.add(e.pid); if (e.launcher) pids.add(e.launcher.pid); }
  const starts = await startTimes([...pids]);
  if (starts === null) { result.verified = false; return result; }

  const targets = ledger.selectReapable(entries, starts, { now, minAgeMs });
  result.wouldKill = targets.map(e => e.pid);
  if (dryRun) return result;

  // kill(pid, start) proves the start again on a held handle and kills in the same step (host/kill-tree.js killProven,
  // PR #130 review, Dexter #2). 'mismatch': the pid is another process now, nothing killed, the line is stale.
  // 'failed' / 'unknown': nothing is known to have died, the line stays whatever the re-check says.
  const outcome = new Map();
  for (const e of targets) {
    try { outcome.set(e.pid, kill(e.pid, e.start)); } catch (err) {
      console.log(`[reap] kill ${e.pid} failed: ${err && err.message}`);
      outcome.set(e.pid, 'failed');
    }
  }
  // What is still running afterwards keeps its line. Default: ask again, by the same proof.
  const left = stillRunning
    ? await stillRunning(targets.map(e => e.pid))
    : await (async () => {
      // Unknown is not "killed" (PR #130 review, Dexter #6): a failed query (null) or an unreadable start (null in the
      // map) counts as still running, so the line stays for the next run.
      const again = await startTimes(targets.map(e => e.pid));
      return new Set(targets.filter(e => again === null || (again.has(e.pid) && (again.get(e.pid) === null || again.get(e.pid) === e.start))).map(e => e.pid));
    })();
  const mismatched = [];
  const gone = [];
  for (const e of targets) {
    const o = outcome.get(e.pid);
    if (o === 'mismatch') mismatched.push(e);
    else if (o === 'failed' || o === 'unknown' || left.has(e.pid)) result.failed.push(e.pid);
    else { result.killed.push(e.pid); gone.push(e); }
  }

  const stale = [...ledger.staleEntries(entries, starts), ...mismatched];
  result.dropped = stale.map(e => e.pid);
  // By (pid, start), appended under the ledger lock, then compacted (host/pid-ledger.js). A failure here comes after the
  // kills, so it is reported with them, never thrown (PR #130 review, Dexter #5, Miguel M2 / S5).
  const removed = ledger.removeEntries(file, [...gone, ...stale], { deadlineMs: ledgerDeadlineMs });
  result.ledger = removed.ok ? ledger.compact(file, { deadlineMs: ledgerDeadlineMs }) : removed;
  return result;
}

module.exports = { reap };

if (require.main === module) {
  const kill = process.argv.includes('--kill');
  reap({ dryRun: !kill }).then((r) => {
    if (!r.ledger.ok) console.log(`the ledger could not be updated (${r.ledger.error}); the next run prunes what is gone`);
    if (!r.verified) { console.log('could not read process start times; nothing was touched'); process.exit(2); }
    console.log(`${r.entries} ledger entr${r.entries === 1 ? 'y' : 'ies'}; ` +
      (kill ? `killed ${r.killed.length} [${r.killed.join(', ')}], still running ${r.failed.length} [${r.failed.join(', ')}]`
        : `would kill ${r.wouldKill.length} [${r.wouldKill.join(', ')}] (run with --kill)`) +
      `; dropped ${r.dropped.length} stale`);
  }).catch((err) => { console.error(`reap failed: ${err && err.message}`); process.exit(2); });
}
