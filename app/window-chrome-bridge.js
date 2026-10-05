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
 * statusInHeader defaults ON (BACKLOG #67): only a real boolean `false` turns
 * it off, so a missing record means the row is hidden and the header shows the
 * fields. framelessWindow still defaults OFF and needs a real `true`: a
 * missing record must never hide the user's title bar. Setters take the
 * DESIRED state and refuse anything that isn't a boolean (the string 'false'
 * is truthy; favourites-bridge, Dexter PR #60 F6/N5).
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

const DEFAULTS = Object.freeze({ statusInHeader: true, framelessWindow: false });

function settingsOf(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ...DEFAULTS };
  return { statusInHeader: rec.statusInHeader !== false, framelessWindow: rec.framelessWindow === true };
}

// For createWindow: a frame must be decided now, and the framed window is the
// safe answer when the file can't say.
function readChromeSettings(store) {
  const known = readChromeState(store);
  return known || { ...DEFAULTS };
}

/**
 * The settings, or null when the file can't be read right now (busy under an
 * antivirus scan, or corrupt). Null is UNKNOWN, never OFF (Dexter L2 #1): the
 * relay reads the same file on its own, so a main that guessed OFF could hide
 * the header fields while the relay quiets the CLI row, and the fields would
 * show nowhere. Missing is a real answer: nothing was ever set.
 */
function readChromeState(store) {
  try {
    if (typeof store.readState === 'function') {
      const st = store.readState(CHROME_KEY);
      if (st.status === 'ok') return settingsOf(st.value);
      if (st.status === 'missing') return { ...DEFAULTS };
      return null;
    }
    return settingsOf(store.read(CHROME_KEY, {}));
  } catch {
    return null;
  }
}

const same = (a, b) => !!a && !!b && a.statusInHeader === b.statusInHeader && a.framelessWindow === b.framelessWindow;

// `isSender` and `send` as in avatar-bridge: the window is a shell of tab
// views, so "from this window" means "from one of its views", and a push goes
// to every view.
function registerChromeHandlers({ ipcMain, store, sync = {}, isSender, send }) {
  const fromWindow = (e) => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  // Null when the file can't be read: the page keeps "unknown" and asks again.
  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readChromeState(store) : { ...OFF }));

  const setter = (key) => (e, value) => {
    if (!fromWindow(e)) return null;
    if (typeof value !== 'boolean') return null;
    // Dexter L2 #2: an unreadable or corrupt file would merge into `{}` and
    // silently reset the OTHER setting. Refuse; the page re-reads and the
    // person can click again.
    if (readChromeState(store) === null) return null;
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
 * was told. An unreadable or corrupt read is never pushed as OFF, and it is
 * RETRIED (Dexter L2 #1): watchFile fires once per change, so a change whose
 * one poll found the file busy would otherwise never be seen. The decision
 * uses the value that read returned, never a second read. Returns stop().
 */
function watchChromeSettings({
  store, file, intervalMs = 500, watchFile = fs.watchFile, unwatchFile = fs.unwatchFile, sync = {}, send,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); },
}) {
  sync.last = readChromeState(store);
  let retrying = false;
  let stopped = false;
  const listener = () => {
    if (stopped) return;
    const now = readChromeState(store);
    if (now === null) {
      if (!retrying) {
        retrying = true;
        setTimer(() => { retrying = false; listener(); }, intervalMs);
      }
      return;
    }
    if (same(now, sync.last)) return;
    sync.last = now;
    try { send(PUSH_CHANNEL, now); } catch { /* window is going away */ }
  };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => { stopped = true; unwatchFile(file, listener); };
}

/**
 * Where a tab view starts. Focus mode lays the view over the strip -- but in a
 * frameless window the strip is the only title bar: covering it left nothing
 * to drag, minimise or close the window with, since focus mode also hides the
 * page's own header (Dexter L2 #3). So frameless keeps the strip.
 */
function viewTop({ focusMode, frameless, stripHeight }) {
  return focusMode === true && frameless !== true ? 0 : stripHeight;
}

module.exports = {
  readChromeSettings, registerChromeHandlers, watchChromeSettings, viewTop,
  CHROME_KEY, GET_CHANNEL, SET_STATUS_CHANNEL, SET_FRAMELESS_CHANNEL, PUSH_CHANNEL,
};
