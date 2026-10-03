'use strict';
/**
 * Is the host that wrote a claim still the host that wrote it? (backlog #44 + #47)
 *
 * A claim file outlives its host, and Windows reuses pids, so the file is only a claim. It is shown only
 * once the launching host is PROVEN alive -- the `exact` proof of host/background-hosts.js: the pid is
 * running and its OS start time (host/proc-start.js startTimes, a FILETIME string) is `hostStartedAt`.
 * No clock is involved, so nothing can fake it, and there is NO wall-clock fallback: a claim without a
 * `hostStartedAt` is never shown.
 *
 * FIVE ANSWERS THAT MUST STAY APART (the same three-way split as host/proc-start.js, plus one):
 *   live      pid running, start time equal           shown
 *   dead      pid not running, or running with ANOTHER start time (a reused pid)   hidden; a producer may delete it
 *   unproven  pid running, but the claim recorded no start time                     hidden, never deleted
 *   unknown   the OS couldn't be asked, or couldn't read that process's start time  hidden unless it was
 *             already proven live (the service keeps that), and NEVER deleted
 * Collapsing "couldn't ask" into "dead" would let a producer delete a live agent's claim because
 * powershell.exe was slow.
 *
 *   judge(claims, startTimes) -> Promise<[{ claim, verdict }]>   one OS query for every pid
 */

const LIVE = 'live';
const DEAD = 'dead';
const UNPROVEN = 'unproven';
const UNKNOWN = 'unknown';

async function judge(claims, startTimes) {
  const list = Array.isArray(claims) ? claims : [];
  if (list.length === 0) return [];
  let starts = null;
  try { starts = await startTimes([...new Set(list.map(c => c.hostPid))]); } catch { starts = null; }
  return list.map((claim) => {
    if (!(starts instanceof Map)) return { claim, verdict: UNKNOWN };
    if (!starts.has(claim.hostPid)) return { claim, verdict: DEAD };
    const os = starts.get(claim.hostPid);
    if (typeof os !== 'string') return { claim, verdict: UNKNOWN };
    if (typeof claim.hostStartedAt !== 'string') return { claim, verdict: UNPROVEN };
    return { claim, verdict: os === claim.hostStartedAt ? LIVE : DEAD };
  });
}

module.exports = { judge, LIVE, DEAD, UNPROVEN, UNKNOWN };
