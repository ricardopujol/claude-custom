'use strict';
/**
 * Run a command under the machine-wide heavy-work lock (BACKLOG #100 d):
 *
 *   node scripts/with-heavy-lock.js node --test --test-concurrency=2 "test/**\/*.test.js"      (this is `npm test`)
 *
 * Takes the lock (host/heavy-lock.js; waits its turn behind other lanes), runs the command with HEAVY_LOCK_HELD=1 in its
 * environment, and releases on every way out: the command ending (any code), failing to start, SIGINT/SIGTERM (the
 * command's tree is killed by its pid first), or this process exiting. If the lock stays busy the command does not run:
 * it says who holds it and exits 1. If the lock script isn't on this machine it warns once and runs anyway.
 *
 * Already under the lock (HEAVY_LOCK_HELD is set, by an outer wrapper or by someone who took the lock by hand with
 * heavy-lock.ps1 -Acquire): runs the command at once and takes nothing. How to set it by hand: see host/heavy-lock.js.
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
    log(`[heavy-lock] not running: ${err && err.message}`);
    return 1;
  }
  let signalled = 0;
  let child = null;
  const hooks = [];
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const h = () => {
      signalled = code;
      if (child) { try { killFn(child.pid); } catch { /* gone */ } }   // kill-ok(held-handle): the command this process spawned, handle held
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
        child = spawnFn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...env, [heavy.ENV_VAR]: '1' } });
      } catch (err) { log(`[heavy-lock] could not start ${argv[0]}: ${err && err.message}`); return resolve(1); }
      child.on('error', (err) => { log(`[heavy-lock] could not start ${argv[0]}: ${err && err.message}`); resolve(1); });
      child.on('exit', (code, sig) => resolve(code === null || code === undefined ? 1 : code));
    });
    return signalled || result;
  } finally {
    cleanup();
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
