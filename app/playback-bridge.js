'use strict';
/**
 * Main's half of "does the background video play" (BACKLOG #34): the two facts
 * only main knows, pushed to every tab view.
 *
 *   minimised / hidden   the window's own state. Main tracks it from events, the
 *                        way it tracks focus (app/main.js: `win.isFocused()` was
 *                        measured lying while minimised) -- but here the page's
 *                        own `visibilitychange` is a second witness, and the page
 *                        plays only when BOTH agree it is on screen.
 *   onBattery            Electron's powerMonitor. A desktop with no battery says
 *                        false; a failed read says null, which is UNKNOWN.
 *
 * The decision itself (app/bg-media-display.js shouldPlay) lives with the page;
 * this only reports the inputs. Read-only: nothing here changes the window.
 *
 * Its own module so it can be tested without booting Electron.
 */

const GET_CHANNEL = 'playback:get';
const PUSH_CHANNEL = 'playback-state';

const bool = (fn) => {
  try {
    const v = fn();
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
};

/** { minimised, hidden, onBattery }, each a boolean or null when it can't be told. */
function readPlayback({ win, powerMonitor } = {}) {
  const live = !!win && !(typeof win.isDestroyed === 'function' && win.isDestroyed());
  return {
    minimised: live && typeof win.isMinimized === 'function' ? bool(() => win.isMinimized()) : null,
    hidden: live && typeof win.isVisible === 'function' ? bool(() => !win.isVisible()) : null,
    onBattery: powerMonitor && typeof powerMonitor.isOnBatteryPower === 'function'
      ? bool(() => powerMonitor.isOnBatteryPower()) : null,
  };
}

const same = (a, b) => !!a && !!b && a.minimised === b.minimised && a.hidden === b.hidden && a.onBattery === b.onBattery;

/**
 * `isSender` and `send` as in avatar-bridge: the window is a shell of tab views,
 * so "from this window" means "from one of its views", and a push goes to every
 * view. A push happens only when the state actually changed.
 */
function registerPlaybackHandlers({ ipcMain, win, powerMonitor, isSender, send }) {
  let last = readPlayback({ win, powerMonitor });
  const fromWindow = (e) => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readPlayback({ win, powerMonitor }) : null));

  const changed = () => {
    const now = readPlayback({ win, powerMonitor });
    if (same(now, last)) return;
    last = now;
    try { send(PUSH_CHANNEL, now); } catch { /* the window is going away */ }
  };
  if (win && typeof win.on === 'function') {
    for (const ev of ['minimize', 'restore', 'show', 'hide']) win.on(ev, changed);
  }
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    for (const ev of ['on-battery', 'on-ac']) powerMonitor.on(ev, changed);
  }
}

module.exports = { readPlayback, registerPlaybackHandlers, GET_CHANNEL, PUSH_CHANNEL };
