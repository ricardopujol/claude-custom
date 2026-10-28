'use strict';
/**
 * The watchdog process of host/bounded-shutdown.js (BACKLOG #121; PR #217 Dexter F5, Miguel 2). It watches one host pid and ends it
 * when the bound runs out. Two things a bare `pid` + wall clock got wrong:
 *   - the clock is MONOTONIC (process.hrtime), so a clock step can't cut a healthy stop short;
 *   - it only ever kills through kill-tree's killProven, which proves the pid is still the host it was armed for (the host's start
 *     time, compared on a held process handle in the same call as the kill). A reused pid ('mismatch') or a host that already left
 *     ('gone') is never killed. With no start time, or a proof that couldn't be judged ('unknown', 'failed'), it kills nothing and
 *     says so in host.log: killing a stranger is worse than leaving a hung host, which the next host judges stale or live by pid.
 */

const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

/** The pure part: tick() says 'wait' or 'exit'. Everything it touches is injected. */
function createWatchdog({ pid, boundMs, start = null, log = () => {}, now = monotonicMs, alive, killProven } = {}) {
  const deadline = now() + boundMs;
  return {
    tick() {
      if (!alive(pid)) return 'exit';
      if (now() < deadline) return 'wait';
      log(`[host] shutdown: the shutdown did not finish within ${boundMs} ms; exiting anyway`);
      let outcome = 'unproven';
      if (typeof start === 'string' && start) {
        try { outcome = killProven(pid, start); } catch { outcome = 'unknown'; }
      }
      if (outcome === 'mismatch') log(`[host] shutdown: pid ${pid} is no longer this host (reused); left alone`);
      else if (outcome !== 'killed' && outcome !== 'gone') log(`[host] shutdown: could not prove pid ${pid} is this host (${outcome}); left alone`);
      return 'exit';
    },
  };
}

function main(argv) {
  const [pid, boundMs, logFile, start] = [Number(argv[0]), Number(argv[1]), argv[2], argv[3]];
  const fs = require('fs');
  const { killProven } = require('./kill-tree');
  const wd = createWatchdog({
    pid, boundMs, start: start || null,
    log: (line) => { if (logFile) { try { fs.appendFileSync(logFile, line + '\n'); } catch { /* best effort */ } } },
    alive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
    killProven,
  });
  const timer = setInterval(() => { if (wd.tick() === 'exit') { clearInterval(timer); process.exit(0); } }, 100);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { createWatchdog, monotonicMs };
