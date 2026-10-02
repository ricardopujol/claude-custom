'use strict';
/**
 * Main's half of the window-chrome settings (layout pass L2,
 * documentation/PLAN_LAYOUT_L2.md):
 *
 *   statusInHeader   BACKLOG #27: the CLI's status row moves into each tab's
 *                    header. host/status-relay.js reads THIS FILE on every
 *                    status fire (`--quiet-when`), so it goes live with no
 *                    session restart.
 *   framelessWindow  BACKLOG #28: no OS title bar; the tab strip is the top
 *                    row. A frame can't change on an open window, so main.js
 *                    reads it when it creates the next one.
 *
 * ELECTRON MAIN OWNS THEM, as it owns `look-global` and `avatar-global`
 * (avatar-bridge.js has the reasoning): install-wide personal preferences. Its
 * own key, `chrome-global`, in the same store.
 *
 * Both default OFF, and only a real boolean `true` turns one on: a missing or
 * corrupt record must never hide the user's title bar or status row. Setters
 * take the DESIRED state and refuse anything that isn't a boolean (the string
 * 'false' is truthy; favourites-bridge, Dexter PR #60 F6/N5).
 *
 * Its own module so it can be tested without booting Electron.
 */

const fs = require('fs');

const CHROME_KEY = 'chrome-global';
const GET_CHANNEL = 'chrome:getSettings';
const SET_STATUS_CHANNEL = 'chrome:setStatusInHeader';
const SET_FRAMELESS_CHANNEL = 'chrome:setFrameless';
const PUSH_CHANNEL = 'chrome-settings';
const OFF = Object.freeze({ statusInHeader: false, framelessWindow: false });

function settingsOf(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ...OFF };
  return { statusInHeader: rec.statusInHeader === true, framelessWindow: rec.framelessWindow === true };
}

function readChromeSettings(store) {
  try {
    return settingsOf(store.read(CHROME_KEY, {}));
  } catch {
    return { ...OFF };
  }
}

const same = (a, b) => !!a && !!b && a.statusInHeader === b.statusInHeader && a.framelessWindow === b.framelessWindow;

// `isSender` and `send` as in avatar-bridge: the window is a shell of tab
// views, so "from this window" means "from one of its views", and a push goes
// to every view.
function registerChromeHandlers({ ipcMain, store, sync = {}, isSender, send }) {
  const fromWindow = (e) => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readChromeSettings(store) : { ...OFF }));

  const setter = (key) => (e, value) => {
    if (!fromWindow(e)) return null;
    if (typeof value !== 'boolean') return null;
    let next;
    try {
      next = settingsOf(store.update(CHROME_KEY, {}, (prev) => ({
        ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}), [key]: value,
      })));
    } catch (err) {
      console.error(`[main] could not save the ${key} setting:`, err && err.message);
      return null;
    }
    // The watcher must know what the views were just told, or a later change
    // back would compare equal to stale memory and never be pushed (Dexter N2).
    sync.last = next;
    try { send(PUSH_CHANNEL, next); } catch { /* window is going away */ }
    return next;
  };
  ipcMain.handle(SET_STATUS_CHANNEL, setter('statusInHeader'));
  ipcMain.handle(SET_FRAMELESS_CHANNEL, setter('framelessWindow'));
}

/**
 * Follows a change made by ANOTHER project window (another Electron main
 * sharing this store file), as avatar-bridge's watchImagesEnabled does: polls
 * the file and pushes when the settings differ from the last ones this window
 * was told. An unreadable or corrupt read is skipped, never pushed as OFF.
 * Returns stop().
 */
function watchChromeSettings({
  store, file, intervalMs = 500, watchFile = fs.watchFile, unwatchFile = fs.unwatchFile, sync = {}, send,
}) {
  sync.last = readChromeSettings(store);
  const listener = () => {
    if (typeof store.readState === 'function') {
      const st = store.readState(CHROME_KEY);
      if (st.status !== 'ok' && st.status !== 'missing') return;
    }
    const now = readChromeSettings(store);
    if (same(now, sync.last)) return;
    sync.last = now;
    try { send(PUSH_CHANNEL, now); } catch { /* window is going away */ }
  };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

module.exports = {
  readChromeSettings, registerChromeHandlers, watchChromeSettings,
  CHROME_KEY, GET_CHANNEL, SET_STATUS_CHANNEL, SET_FRAMELESS_CHANNEL, PUSH_CHANNEL,
};
