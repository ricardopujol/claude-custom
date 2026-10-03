'use strict';
/**
 * "Is the host an identity file (.harness/hosts/<port>.json) names still running?" -- the probes' REFUSED check
 * (verify/probe-dock-tree.js, probe-wand.js).
 *
 * A pid alone can't answer it: Windows reuses pids, so a dead probe host's leftover file can name a pid that an
 * unrelated process now owns (found 2026-10-03: another lane's host got a dead host's pid, and the probe refused
 * for nothing). The file records `processStartedAt`; the host is live only if that pid runs AND started then.
 * Same rule as host/session-lock.js, on host/proc-start.js. No `processStartedAt`: the pid alone, as before.
 * When nothing can be learned the answer is "live": refusing wrongly costs a retry, running beside a real host
 * overwrites what it saved.
 */

const fs = require('fs');
const procStart =require('../../host/proc-start');

async function isLiveHost(id, { isAlive = procStart.isAlive, startTimes = procStart.startTimes, exists = fs.existsSync } = {}) {
  if (!id || !Number.isInteger(id.pid) || id.pid <= 0) return false;
  // The refusal protects a real window open on this checkout, and its project folder exists. A folder that is gone
  // (a probe's deleted temp world) can't belong to one, whatever the pid is now (and whether or not it can be asked).
  if (typeof id.cwd === 'string' && id.cwd !== '' && !exists(id.cwd)) return false;
  const alive = isAlive(id.pid);
  if (alive === false) return false;
  if (alive !== true) return true;                                  // can't tell
  if (typeof id.processStartedAt !== 'string' || id.processStartedAt === '') return true;
  const starts = await startTimes([id.pid]);
  if (starts === null) return true;                                 // couldn't ask
  if (!starts.has(id.pid)) return false;                            // gone since the check
  const os = starts.get(id.pid);
  if (os === null) return true;                                     // running, start unreadable
  return os === id.processStartedAt;
}

module.exports = { isLiveHost };
