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
 * 'will-quit' for a main that quits the ordinary way. A second release is a no-op (the lock module's own `done` flag).
 *
 * NOT RUN. A busy slot (or a loaded machine): the reason, the NOT RUN line, and exit 75 (NOT_RUN_EXIT), before any window
 * exists. Any other throw from the lock code is a bug and is thrown as it is.
 */
const { createProcessLock, HeavyLockError, notRunLine, NOT_RUN_EXIT } = require('../../host/heavy-lock');

function takeMainLock({ app, label, createLock = createProcessLock, say = console.error, exitNow = (c) => process.exit(c) } = {}) {
  const lock = createLock({ label });
  let held;
  try { held = lock.ensure(); } catch (err) {
    if (!(err instanceof HeavyLockError)) throw err;
    say(`[heavy-lock] ${label} did not run: ${err.message}`);
    say(notRunLine(err));
    exitNow(NOT_RUN_EXIT);
    return null;
  }
  const release = () => { try { if (held && typeof held.release === 'function') held.release(); } catch { /* the slot is freed regardless */ } };
  if (app && typeof app.on === 'function') app.on('will-quit', release);
  const exit = (code) => {
    release();
    if (app && typeof app.isReady === 'function' && app.isReady()) app.exit(code); else exitNow(code);
  };
  return { held, release, exit };
}

module.exports = { takeMainLock };
