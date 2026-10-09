'use strict';
/**
 * One trial of verify/probe-kill-tree-straddle.js, with every effect injected so a test can break each gate.
 *
 * The gates (PR #135 Dexter 1 and 4):
 *   - The kill happens only while the root is provably unexited, checked in the SAME tick as the kill: a root that ended
 *     during the (blocking) scan has had its pid freed, and a by-pid tree kill would land on a stranger. That trial is
 *     inconclusive, never a count.
 *   - The control counts SLEEPERS only (the spawner carries a different marker), and needs at least one before the
 *     kill. A scan that can only see the spawner proves nothing about survivors.
 */
async function runTrial({ root, exited, scanSleepers, kill, sleep, jitterMs = 0, settleMs = 500, killWaitMs = 5000 }) {
  const before = scanSleepers();
  if (before.length === 0) return { inconclusive: 'the scan saw no sleeper before the kill' };
  await sleep(jitterMs);
  if (root.exitCode !== null || root.signalCode !== null) return { inconclusive: 'the root exited before the kill' };
  kill(root.pid);   // same tick as the check above: no event-loop turn can free the pid in between
  await Promise.race([exited, sleep(killWaitMs)]);
  await sleep(settleMs);
  return { left: scanSleepers().length };
}

module.exports = { runTrial };
