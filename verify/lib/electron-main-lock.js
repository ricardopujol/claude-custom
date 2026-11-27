'use strict';
/**
 * The heavy-work lock for a verify/ script that IS an Electron main (verify/shoot.js, shoot-full.js, probe-atomic-sleep.js,
 * run as `npx electron verify/<x>.js`; BACKLOG #179). It can't go through verify/lib/launch-electron (that starts an
 * Electron; this one already is), so it takes the lock here, in the main process, before the app is ready, through
 * host/heavy-lock.js's createProcessLock and labelled with the script's name. Under an outer holder (a run under
 * scripts/with-heavy-lock.js, or a probe that launched this main), HEAVY_LOCK_HELD names that holder and nothing is taken:
 * the lock module's re-entrancy.
 *
 * RELEASE. These mains end with app.exit(code), which skips before-quit and will-quit, and the lock's own process 'exit'
 * listener is not something an Electron main promises to run on app.exit. So `exit(code)` releases FIRST, then exits.
 * createProcessLock's 'exit' and signal handlers stay as the backstop (a process.exit, a throw, Ctrl+C), and so does
 * 'will-quit' for a main that quits the ordinary way. Release runs once, whoever calls it first (exit, will-quit), and a
 * release that throws still lets the exit happen.
 *
 * A CRASH (#243 Miguel I3). A bad or missing input makes these mains reject inside `app.whenReady().then(...)`, and an
 * Electron main doesn't exit on an unhandled rejection: the hidden window's process would live on holding the machine's lock.
 * So an 'unhandledRejection' or 'uncaughtException' says what happened, releases, and exits 1. Installed whether or not the
 * lock was taken (under an outer holder the stuck Electron would still hold up that holder's run).
 *
 * NOT RUN. A busy slot (or a loaded machine): the reason, the NOT RUN line, and exit 75 (NOT_RUN_EXIT), before any window
 * exists. Any other throw from the lock code is a bug and is thrown as it is.
 */
const { createProcessLock, HeavyLockError, notRunLine, NOT_RUN_EXIT } = require('../../host/heavy-lock');

function takeMainLock({ app, label, createLock = createProcessLock, say = console.error, exitNow = (c) => process.exit(c), proc = process } = {}) {
  const lock = createLock({ label });
  let held;
  try { held = lock.ensure(); } catch (err) {
    if (!(err instanceof HeavyLockError)) throw err;
    say(`[heavy-lock] ${label} did not run: ${err.message}`);
    say(notRunLine(err));
    exitNow(NOT_RUN_EXIT);
    return null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (held && typeof held.release === 'function') held.release(); } catch { /* the exit goes ahead; the dead-holder rule frees the slot */ }
  };
  if (app && typeof app.on === 'function') app.on('will-quit', release);
  const exit = (code) => {
    release();
    if (app && typeof app.isReady === 'function' && app.isReady()) app.exit(code); else exitNow(code);
  };
  const crash = (what) => (err) => {
    say(`[${label}] ${what}: ${(err && err.stack) || err}`);
    exit(1);
  };
  if (proc && typeof proc.on === 'function') {
    proc.on('unhandledRejection', crash('unhandled rejection'));
    proc.on('uncaughtException', crash('uncaught exception'));
  }
  return { held, release, exit };
}

module.exports = { takeMainLock };
