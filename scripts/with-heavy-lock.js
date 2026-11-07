'use strict';
/**
 * Run a command under the machine-wide heavy-work lock (BACKLOG #100 d):
 *
 *   node scripts/with-heavy-lock.js node --test --test-concurrency=2 "test/**\/*.test.js"      (this is `npm test`)
 *
 * Takes the lock (host/heavy-lock.js; waits its turn behind other lanes), runs the command with HEAVY_LOCK_HELD=1 in its
 * environment, and releases on every way out: the command ending (any code), failing to start, SIGINT/SIGTERM/SIGHUP (the
 * command's tree is killed by its pid first), or this process exiting. If the lock script isn't on this machine it warns
 * once and runs anyway.
 *
 * WAITING. A busy lock is waited for (20 minutes by default, HEAVY_LOCK_WAIT_MINUTES; why 20: host/heavy-lock.js WAIT),
 * with a line about once a minute saying who holds it and how long this run has waited.
 *
 * A throw from the lock code that isn't the lock's own refusal (a HeavyLockError) is a bug here, not a busy lock: its stack
 * is printed and the exit is 1, never 75 (#237 Miguel M4).
 *
 * NOT RUN: EXIT 75. If the lock stays busy (or the machine too loaded, or the lock script fails) the command does NOT
 * run. The reason comes first, and the LAST line is one of
 *   [heavy-lock] lock busy for <n> min, held by <owner>: NOT RUN                 another lane had the slot
 *   [heavy-lock] lock busy for <n> min, held by nobody now but <k> ahead in the queue (the first may be held back
 *     by the load gate: 8 GB free RAM and under 70% CPU): NOT RUN                 earlier tickets were still waiting
 *   [heavy-lock] machine busy after a <n> min wait: the lock is free, but its load gate needs 8 GB free RAM and
 *     under 70% CPU (now <load>): NOT RUN                                         the slot was free, the machine wasn't
 *   [heavy-lock] the lock could not be taken (<why>): NOT RUN                     the lock script failed (the 'error'
 *                                                                                 shape: <why> is its output, one line)
 * The first and third get " (heavy-lock.ps1 ran past its wait and was stopped)" after the "<n> min" part when the script
 * call was killed by its own wait + 1 minute timer (a loaded machine); then an unreadable holder reads "held by a holder
 * its status could not name". The last line is always one physical line starting "[heavy-lock]".
 * and the exit code is 75 (EX_TEMPFAIL, "try again later"; host/heavy-lock.js NOT_RUN_EXIT). Never 1: 1 is what a failing
 * suite exits, and a suite that never ran is not a failing one. Retry it. The load gate's time counts against the same
 * wait (host/heavy-lock.js WAIT). Documented in verify/README.md too.
 * THE RULE IS 75 PLUS THAT LAST LINE, not 75 alone (#237 Dexter 7). A command that ran can exit 75 itself (a nested
 * probe's own NOT RUN); its code passes through unchanged, and the last line is then
 *   [heavy-lock] the command ran under the lock and exited 75 itself: that is its own code (...), not this wrapper's NOT RUN
 *
 * Already under the lock (HEAVY_LOCK_HELD names the live holder of the slot: an outer wrapper or probe sets it to its own
 * identity, a by-hand holder uses the bare "1"): runs the command at once, takes nothing, and the line names that holder.
 * Under another lane's holder it's a stranger's variable: a warning, and the lock is waited for like any run. With nobody
 * holding the slot it's a stale variable: a warning, and the lock is taken for real. The rule: host/heavy-lock.js RE-ENTRANCY.
 */
const { spawn } = require('child_process');
const heavy = require('../host/heavy-lock');
const { killPidTree } = require('../host/kill-tree');

async function main(argv, {
  acquire = heavy.acquire, spawn: spawnFn = spawn, killFn = killPidTree, proc = process, log = console.error, env = process.env,
} = {}) {
  if (!argv.length) { log('usage: node scripts/with-heavy-lock.js <command> [args...]'); return 2; }
  let lock;
  try { lock = acquire({ label: 'npm test', env, log }); } catch (err) {
    // Only the lock's own refusals are NOT RUN. Anything else is a bug in this code: its stack, and 1 (#237 Miguel M4).
    if (!(err instanceof heavy.HeavyLockError)) {
      log(`[heavy-lock] the lock code itself failed (a bug, not a busy lock): ${(err && err.stack) || err}`);
      return 1;
    }
    log(`[heavy-lock] not running: ${err && err.message}`);
    log(heavy.notRunLine(err));   // the last line, in words that can't be read as a failing suite
    return heavy.NOT_RUN_EXIT;
  }
  let signalled = 0;
  let child = null;
  const hooks = [];
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const h = () => {
      signalled = code;
      if (child) { try { killFn(child.pid); } catch { /* gone */ } }   // kill-ok(held-handle): the command this process spawned, handle held
      lock.release();   // now, not after the child's exit event: a closed console gives the process about 10 s (kill first, then free the slot)
    };
    proc.on(sig, h);
    hooks.push([sig, h]);
  }
  const onExit = () => { lock.release(); };
  proc.on('exit', onExit);
  const cleanup = () => {
    for (const [sig, h] of hooks) proc.removeListener(sig, h);
    proc.removeListener('exit', onExit);
    lock.release();
  };
  try {
    const result = await new Promise((resolve) => {
      try {
        // The flag names this run's holder (its own owner when it took the lock, the outer one when re-entrant), so only
        // what it starts is re-entrant under it (#237 Dexter 2). No lock script: nothing to name, the bare form.
        child = spawnFn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...env, [heavy.ENV_VAR]: typeof lock.flag === 'string' ? lock.flag : '1' } });
      } catch (err) { log(`[heavy-lock] could not start ${argv[0]}: ${err && err.message}`); return resolve(1); }
      if (child && child.pid && typeof lock.addWork === 'function') {   // the suite's node: a dead wrapper with this alive is not a dead holder
        // Provisional first (start unknown = alive while the pid runs), then with its start time once that query returns:
        // a hard kill during the 0.5-1.5 s query must not leave the suite unlisted (BACKLOG #112).
        try { lock.addWork(child.pid, null); lock.addWork(child.pid); } catch { /* recorded work is a safety net */ }
      }
      child.on('error', (err) => { log(`[heavy-lock] could not start ${argv[0]}: ${err && err.message}`); resolve(1); });
      child.on('exit', (code) => resolve(code === null || code === undefined ? 1 : code));
    });
    // 75 isn't unique to NOT RUN (#237 Dexter 7): a command that RAN can exit 75 itself (today, a nested probe's own NOT
    // RUN). The code passes through unchanged, and the last line says whose 75 it is.
    if (!signalled && result === heavy.NOT_RUN_EXIT) {
      log(`[heavy-lock] the command ran under the lock and exited ${heavy.NOT_RUN_EXIT} itself: that is its own code (see its output above), not this wrapper's NOT RUN`);
    }
    return signalled || result;
  } finally {
    cleanup();
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
