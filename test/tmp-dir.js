'use strict';
/**
 * A temp directory that CLEANS ITSELF UP.
 *
 * WHY THIS EXISTS, and it is the most expensive test-hygiene defect this repo has
 * had. Mortimer, PR #42, measuring the mutation gate:
 *
 *   - 27 test files called `fs.mkdtempSync` and NONE removed the directory.
 *   - One run of the 31-file mutation command leaked **230 directories**.
 *   - With `coverageAnalysis: "off"` every mutant re-runs the whole command, so a
 *     full 2,330-mutant gate would create roughly **536,000 directories** in the
 *     machine-wide `%TEMP%`.
 *   - NTFS makes each `mkdtempSync` slower as that directory grows, so THE TESTS
 *     THROTTLED THE INSTRUMENT MEASURING THEM.
 *
 * Measured, four ways:
 *
 *   | the same command, run start vs. 1h33m in        | 4.1s -> 91.6s  (22x)  |
 *   | same command, bloated %TEMP% vs. a fresh one    | 91.6s -> 10.8s (8.5x) |
 *   | mkdtempSync microbenchmark, bloated vs. fresh   | 452ms -> 31ms  (15x)  |
 *   | directories left by ONE command run             | 230                   |
 *
 * AND IT CORRUPTED THE SCORE UPWARD WHILE IT RAN. Stryker counts a timeout as
 * KILLED. Timeouts went 0 -> 10 -> 24 as throughput collapsed from 30 to 2
 * mutants/min -- nothing to do with the mutants, everything to do with the
 * slowdown crossing the 60s ceiling. A run left alone would have printed a
 * flattering number inflated by an amount that grows with its own runtime, which
 * is the worst failure mode available: it looks like data.
 *
 * The `command` runner also counts any non-zero exit as a kill, so 90-second
 * suite runs are exactly the condition that turns a flake into a false KILL
 * attributed to whichever mutant was running. Two independent score-inflating
 * paths, both from this one leak.
 *
 * So: use `tmpDir(prefix)` instead of `fs.mkdtempSync(path.join(os.tmpdir(), ...))`.
 * Directories are removed when the test process exits. `node --test` runs each
 * file in its own process, so that is per-file and needs no per-test wiring.
 *
 * A hard crash can still skip the handler -- this reduces the leak rather than
 * making it impossible, and saying so is the point: the alternative was
 * unbounded.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const created = [];
let registered = false;

function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // Best effort, and deliberately silent. A directory we cannot remove must
      // not fail the suite -- on Windows an antivirus scanner holds handles for
      // a moment, which is the same adversary host/atomic-write.js retries for.
    }
  }
}

/**
 * Make a temp directory that will be removed when this process exits.
 * Same signature shape as the `mkdtempSync` call it replaces: pass the prefix.
 */
function tmpDir(prefix = 'cc-') {
  if (!registered) {
    // `exit` only, not `SIGINT`/`SIGTERM`: adding those would change how the
    // suite responds to Ctrl-C, which is not this helper's business.
    process.on('exit', cleanup);
    registered = true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

module.exports = { tmpDir, cleanup };
