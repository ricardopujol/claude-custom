'use strict';
/**
 * Shared "don't leave a process behind" bookkeeping for verify/ probes that
 * suspend a real process or spawn a real `claude` session (probe-pause.js,
 * probe-local-model.js).
 *
 * Written for Miguel's PR #61 review, H1: a probe's own `finally` block is
 * not enough. Node's default SIGINT handling terminates the process
 * immediately and does NOT run pending `finally` blocks, so an operator
 * pressing Ctrl+C while a probe has a real process suspended (the documented
 * ~20s window in probe-pause.js) skips cleanup entirely -- the target stays
 * suspended forever and any live paid session is abandoned with nothing left
 * to supervise it. This registry is the thing that runs INSTEAD of the
 * skipped `finally`, on SIGINT, on an uncaught exception, and on an
 * unhandled promise rejection alike.
 *
 * Kept intentionally free of any particular probe's suspend/resume mechanism
 * (NtSuspendProcess is probe-pause.js's own concern) -- a caller supplies
 * `resumeFn(pid)`; this module only tracks WHICH pids need it and WHEN to
 * call it.
 *
 * `resumeFn`'s CONTRACT (Dexter, PR #61 review round 2, finding 4): it must
 * return a truthy value on a CONFIRMED successful resume, and a falsy value
 * (not a throw) on failure. The first version of this module ignored the
 * return value entirely -- probe-pause.js's real resumeFn wraps `ntAction`,
 * which reports failure via `{code: 1, ...}` and never throws, so a failed
 * emergency resume was silently reported as "resumed" and the pid was
 * deleted from the registry regardless. A throw is still handled (treated as
 * failure), for a resumeFn that does throw.
 */
const { killPidTree } = require('../../host/kill-tree');

// A registry is a small piece of mutable state one probe process owns for
// its own lifetime -- not shared across probes, not persisted. A factory
// (rather than module-level singletons) so a test can create an isolated one
// per test case instead of fighting global state between tests.
function createHygieneRegistry({ killFn = killPidTree } = {}) {
  const suspendedPids = new Set();
  const spawnedTrees = new Set();
  let resumeFn = null;
  let installed = false;

  function emergencyCleanup(reason) {
    const suspended = [...suspendedPids];
    const trees = [...spawnedTrees];
    console.error(`\n[cleanup:${reason}] resuming ${suspended.length} suspended pid(s), ` +
      `killing ${trees.length} spawned tree(s)`);
    const resumed = [];
    const failedToResume = [];
    for (const pid of suspended) {
      let ok = false;
      try { ok = !!(resumeFn && resumeFn(pid)); } catch (err) {
        console.error(`[cleanup:${reason}] resume ${pid} THREW: ${err.message}`);
      }
      if (ok) {
        resumed.push(pid);
        // Only cleared on a CONFIRMED success -- this is finding 4's other
        // half. Deleting unconditionally meant a resume that failed (or was
        // itself interrupted mid-attempt by the very Ctrl+C that triggered
        // this cleanup) still vanished from the registry, so nothing would
        // retry it. Left registered, a second SIGINT (or the next uncaught
        // exception) tries again.
        suspendedPids.delete(pid);
      } else {
        failedToResume.push(pid);
        console.error(`[cleanup:${reason}] resume ${pid} FAILED -- left registered as suspended, ` +
          'process may remain frozen; will retry on the next cleanup');
      }
    }
    for (const pid of trees) {
      try { killFn(pid); } catch (err) { console.error(`[cleanup:${reason}] kill ${pid} failed: ${err.message}`); }
      spawnedTrees.delete(pid);
    }
    return { resumed, failedToResume, killed: trees };
  }

  const registry = {
    setResumeFn(fn) { resumeFn = fn; },
    registerSuspended(pid) { suspendedPids.add(pid); },
    clearSuspended(pid) { suspendedPids.delete(pid); },
    registerSpawnedTree(pid) { spawnedTrees.add(pid); },
    unregisterSpawnedTree(pid) { spawnedTrees.delete(pid); },
    isInstalled() { return installed; },
    install() {
      if (installed) return;
      installed = true;
      const onSignal = () => { emergencyCleanup('SIGINT'); process.exit(130); };
      const onUncaught = (err) => { console.error(err); emergencyCleanup('uncaughtException'); process.exit(1); };
      const onRejection = (err) => { console.error(err); emergencyCleanup('unhandledRejection'); process.exit(1); };
      process.on('SIGINT', onSignal);
      process.on('uncaughtException', onUncaught);
      process.on('unhandledRejection', onRejection);
      registry._uninstall = () => {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('uncaughtException', onUncaught);
        process.removeListener('unhandledRejection', onRejection);
        installed = false;
      };
    },
    // Exercised directly by tests: the point is to prove the cleanup LOGIC
    // resumes every registered pid and kills every registered tree, without
    // a test having to actually deliver SIGINT to its own process (which node
    // ends up handling, but node:test's own process ends up handling it too).
    _emergencyCleanup: emergencyCleanup,
    _suspendedPids: suspendedPids,
    _spawnedTrees: spawnedTrees,
  };
  return registry;
}

module.exports = { createHygieneRegistry, killPidTree };
