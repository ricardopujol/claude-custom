'use strict';
/**
 * Quitting has to finish whatever a panel's renderer is doing (PR #122 Dexter R2-1, BACKLOG #74 A).
 *
 * MEASURED (Electron 33, verify/probe-canvas-sandbox.js `print-loop`): a panel page that calls `window.print()` leaves the browser
 * process in a nested wait that never ends (no dialog is ever drawn). The renderer can be killed; the wait stays. `app.exit(0)` and
 * `app.quit()` then return, JavaScript keeps running, and the process never terminates. A page that spins in `for(;;){}` does NOT do
 * this (it exits in under 3 s), so the wedge is the browser's, not the renderer's, and only ending the process ends it.
 *
 * So once the app is really quitting (`will-quit`, after every window is closed and every cleanup handler has run) a timer ends the
 * process if it is still here after the grace period. The timer is unref()ed, so a clean exit is never held up by it.
 */
const QUIT_GRACE_MS = 5000;

// `onFire` (BACKLOG #74 A, app/quit-log.js) is told just before the kill, so a logged run kills exactly as the shipped one does
// (PR #242 Miguel F7): it can't replace the kill, and one that throws doesn't stop it.
function armQuitWatchdog(app, { graceMs = QUIT_GRACE_MS, setTimer = setTimeout, hardKill = () => process.kill(process.pid, 'SIGKILL'), onFire = null } = {}) {
  let armed = false;
  app.on('will-quit', (e) => {
    if (armed || (e && e.defaultPrevented)) return;
    armed = true;
    const fire = () => {
      if (typeof onFire === 'function') { try { onFire(); } catch { /* the kill still happens */ } }
      hardKill();
    };
    const t = setTimer(fire, graceMs);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

module.exports = { armQuitWatchdog, QUIT_GRACE_MS };
