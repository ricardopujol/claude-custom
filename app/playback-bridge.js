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
function registerPlaybackHandlers({ ipcMain, win, powerMonitor, isSender, send, winOf }) {
  if (typeof winOf === 'function') return registerPlaybackForWindows({ ipcMain, powerMonitor, isSender, winOf });
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

/**
 * The several-windows form (`winOf(sender)` names the window of the asking page): the channel is registered ONCE and `watch(win, send)` is
 * called for each window as it is made; each window has its own `last`, a push goes through that window's own `send`, and a battery
 * change re-checks every watched window. Returns `{ watch }`, whose `watch` returns the unwatch function.
 */
function registerPlaybackForWindows({ ipcMain, powerMonitor, isSender, winOf }) {
  const watched = new Map();      // win -> { last, send }
  const fromWindow = (e) => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readPlayback({ win: winOf(e.sender), powerMonitor }) : null));

  const check = (win) => {
    const rec = watched.get(win);
    if (!rec) return;
    const now = readPlayback({ win, powerMonitor });
    if (same(now, rec.last)) return;
    rec.last = now;
    try { rec.send(PUSH_CHANNEL, now); } catch { /* the window is going away */ }
  };
  const checkAll = () => { for (const win of [...watched.keys()]) check(win); };
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    for (const ev of ['on-battery', 'on-ac']) powerMonitor.on(ev, checkAll);
  }

  return {
    watch(win, send) {
      watched.set(win, { last: readPlayback({ win, powerMonitor }), send });
      const events = ['minimize', 'restore', 'show', 'hide'];
      const onEvent = () => check(win);
      if (win && typeof win.on === 'function') for (const ev of events) win.on(ev, onEvent);
      return () => {
        watched.delete(win);
        if (win && typeof win.removeListener === 'function') for (const ev of events) win.removeListener(ev, onEvent);
      };
    },
    watchedCount: () => watched.size,
  };
}

module.exports = { readPlayback, registerPlaybackHandlers, GET_CHANNEL, PUSH_CHANNEL };
