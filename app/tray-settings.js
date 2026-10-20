'use strict';
/**
 * The tray's three install-wide switches (BACKLOG #119 A8), kept in the same `chrome-global` record as the window chrome
 * (app/window-chrome-bridge.js). That bridge reads and writes only its two keys and keeps the rest of the record when it
 * saves, so these ride along without touching it.
 *
 *   trayIcon        the tray icon exists while the app runs.   Default ON  (only a real false turns it off)
 *   minimiseOnClose closing the window hides it to the tray.   Default OFF (only a real true turns it on)
 *   startMinimised  the window starts hidden, in the tray.     Default OFF (only a real true turns it on)
 *
 * A file that can't be read gives the defaults to READ (a normal close, a visible window: the behaviour from before the tray
 * existed) and refuses a WRITE, so a busy file can't be overwritten with a record built from a guess.
 *
 * Main-process only (required, never a page <script>).
 */

const { CHROME_KEY } = require('./window-chrome-bridge');

const GET_CHANNEL = 'tray:getSettings';
const SET_CHANNEL = 'tray:setSetting';
const TRAY_DEFAULTS = Object.freeze({ trayIcon: true, minimiseOnClose: false, startMinimised: false });
const KEYS = Object.freeze(Object.keys(TRAY_DEFAULTS));

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function settingsOf(rec) {
  const r = isRecord(rec) ? rec : {};
  return { trayIcon: r.trayIcon !== false, minimiseOnClose: r.minimiseOnClose === true, startMinimised: r.startMinimised === true };
}

/** The record, or null when the file can't be read right now. A missing file is a real answer: nothing was ever set. */
function readRecord(store) {
  try {
    if (typeof store.readState === 'function') {
      const st = store.readState(CHROME_KEY);
      if (st.status === 'ok') return st.value;
      return st.status === 'missing' ? {} : null;
    }
    return store.read(CHROME_KEY, {});
  } catch { return null; }
}

function readTraySettings(store) {
  if (!store) return { ...TRAY_DEFAULTS };
  const rec = readRecord(store);
  return rec === null ? { ...TRAY_DEFAULTS } : settingsOf(rec);
}

/** Saves one switch; answers all three, or null when the key or value isn't one, the file is unreadable, or the write failed. */
function writeTraySetting(store, key, value) {
  if (!KEYS.includes(key) || typeof value !== 'boolean' || !store) return null;
  if (readRecord(store) === null) return null;
  try {
    return settingsOf(store.update(CHROME_KEY, {}, prev => ({ ...(isRecord(prev) ? prev : {}), [key]: value })));
  } catch (err) {
    console.error(`[main] could not save the tray ${key} setting:`, err && err.message);
    return null;
  }
}

/** `isSender(sender)`: one of this window's own views. `onChange(settings)`: main applies it (the icon appears or goes). */
function registerTrayHandlers({ ipcMain, store, isSender, onChange }) {
  const fromWindow = e => !!e && typeof isSender === 'function' && isSender(e.sender) === true;
  ipcMain.handle(GET_CHANNEL, e => (fromWindow(e) ? readTraySettings(store) : null));
  ipcMain.handle(SET_CHANNEL, (e, key, value) => {
    if (!fromWindow(e)) return null;
    const saved = writeTraySetting(store, key, value);
    if (saved && typeof onChange === 'function') {
      try { onChange(saved); } catch (err) { console.error('[main] tray onChange threw:', err && err.message); }
    }
    return saved;
  });
}

module.exports = { readTraySettings, writeTraySetting, registerTrayHandlers, TRAY_DEFAULTS, GET_CHANNEL, SET_CHANNEL };
