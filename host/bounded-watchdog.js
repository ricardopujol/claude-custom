'use strict';
/**
 * The watchdog process of host/bounded-shutdown.js (BACKLOG #121; PR #217 Dexter F5, Miguel 2, round 2 N1). It watches one host pid
 * and ends it when the bound runs out. Things a bare `pid` + wall clock got wrong:
 *   - the clock is MONOTONIC (process.hrtime), so a clock step can't cut a healthy stop short;
 *   - it only ever kills through kill-tree's killProven, which proves the pid is still the host it was armed for (the host's start
 *     time, compared on a held process handle in the same call as the kill). A reused pid ('mismatch') or a host that already left
 *     ('gone') is never killed;
 *   - a proof that couldn't be judged ('unknown', 'failed') or a start time not known yet is RETRIED, MAX_PROOF_ATTEMPTS times,
 *     RETRY_MS apart, because the load that makes a stop slow also makes one PowerShell query time out (round 2 N1). Only after
 *     the last attempt does it leave the host alone and say so in host.log;
 *   - the host's start time may be unknown to the host itself (its boot query timed out), so the watchdog reads it too, at boot,
 *     while the host is alive, and only from its own parent (process.ppid === pid), so it can't be handed a stranger.
 */

const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

const MAX_PROOF_ATTEMPTS = 5;
const RETRY_MS = 2000;

/**
 * The pure part: tick() says 'wait' or 'exit'. Everything it touches is injected. `start` is a FILETIME string, or a function that
 * returns one (or null while still unknown) so the watchdog can learn it after it was armed.
 */
function createWatchdog({ pid, boundMs, start = null, log = () => {}, now = monotonicMs, alive, killProven, retryMs = RETRY_MS, maxAttempts = MAX_PROOF_ATTEMPTS } = {}) {
  const startNow = () => { const s = typeof start === 'function' ? start() : start; return typeof s === 'string' && s ? s : null; };
  const deadline = now() + boundMs;
  let attempts = 0;
  let nextTry = deadline;
  return {
    tick() {
      if (!alive(pid)) return 'exit';
      const t = now();
      if (t < deadline || t < nextTry) return 'wait';
      if (attempts === 0) log(`[host] shutdown: the shutdown did not finish within ${boundMs} ms; exiting anyway`);
      attempts += 1;
      let outcome = 'unproven';
      const s = startNow();
      if (s) {
        try { outcome = killProven(pid, s); } catch { outcome = 'unknown'; }
      }
      if (outcome === 'killed' || outcome === 'gone') return 'exit';
      if (outcome === 'mismatch') { log(`[host] shutdown: pid ${pid} is no longer this host (reused); left alone`); return 'exit'; }
      if (attempts < maxAttempts) { nextTry = t + retryMs; return 'wait'; }
      log(`[host] shutdown: could not prove pid ${pid} is this host (${outcome}) after ${attempts} tries; left alone`);
      return 'exit';
    },
  };
}

function main(argv) {
  const [pid, boundMs, logFile, startArg] = [Number(argv[0]), Number(argv[1]), argv[2], argv[3]];
  const fs = require('fs');
  const { killProven } = require('./kill-tree');
  let start = startArg || null;
  if (!start && process.ppid === pid) {   // the host didn't know its own start time: ask for it now, while it is alive
    require('./proc-start').startTimes([pid]).then((m) => { const s = m && m.get(pid); if (typeof s === 'string') start = s; }).catch(() => {});
  }
  const wd = createWatchdog({
    pid, boundMs, start: () => start,
    log: (line) => { if (logFile) { try { fs.appendFileSync(logFile, line + '\n'); } catch { /* best effort */ } } },
    alive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
    killProven,
  });
  const timer = setInterval(() => { if (wd.tick() === 'exit') { clearInterval(timer); process.exit(0); } }, 100);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { createWatchdog, monotonicMs, MAX_PROOF_ATTEMPTS, RETRY_MS };
