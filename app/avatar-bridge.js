'use strict';
/**
 * Main's half of the avatar settings (BACKLOG C #13 and #18):
 *
 *   avatar:pick        the OS file picker for a portrait (a face's hover pencil,
 *                      the Style tab's "Choose file..."). Returns a path, which
 *                      the renderer sends to the host as an ordinary
 *                      `portrait set` / `set-global` message -- the host's
 *                      uploader still copies it into the app's data folder.
 *   avatar:get / :set  the install-wide "show agent images" toggle.
 *
 * ELECTRON MAIN OWNS THE TOGGLE, exactly as it owns `look-global` and the model
 * favourites (app/favourites-bridge.js has the reasoning): it is a personal UI
 * preference with no per-project meaning, so it never round-trips through a
 * host. Its own key in the same store, regenerable.
 *
 * `set` takes the DESIRED state and refuses anything that is not a boolean:
 * the string 'false' is truthy in JavaScript, and a toggle that flips whatever
 * it finds inverts a click when a second window is stale (favourites-bridge,
 * Dexter PR #60 F6/N5).
 *
 * Its own module so it can be tested without booting Electron.
 */

const fs = require('fs');
const { MEDIA_EXTENSIONS } = require('../host/portraits');

const AVATAR_KEY = 'avatar-global';
const GET_CHANNEL = 'avatar:getImagesEnabled';
const SET_CHANNEL = 'avatar:setImagesEnabled';
const PICK_CHANNEL = 'avatar:pick';
const PUSH_CHANNEL = 'avatar-images';
const NAMES_GET_CHANNEL = 'avatar:getRosterNames';
const NAMES_SET_CHANNEL = 'avatar:setRosterNames';
const NAMES_PUSH_CHANNEL = 'avatar-roster-names';

/**
 * Whether agent images are shown. ON unless the store holds a real boolean
 * `false`: a missing, corrupt or unreadable record must never silently strip
 * every face (and only an explicit user choice may turn them off).
 */
function imagesFromRecord(rec) {
  return !(rec && typeof rec === 'object' && rec.imagesEnabled === false);
}

function readImagesEnabled(store) {
  try {
    return imagesFromRecord(store.read(AVATAR_KEY, {}));
  } catch {
    return true;
  }
}

/**
 * BACKLOG #76: which name the roster card shows big, 'role' or 'name' (the
 * persona). Install-wide and kept in this same record, beside `imagesEnabled`.
 * 'role' unless the store holds exactly 'name': a missing or corrupt record
 * must never switch the roster to a different set of names by itself.
 */
function namesFromRecord(rec) {
  return rec && typeof rec === 'object' && rec.rosterNames === 'name' ? 'name' : 'role';
}

function readRosterNames(store) {
  try {
    return namesFromRecord(store.read(AVATAR_KEY, {}));
  } catch {
    return 'role';
  }
}

/**
 * Sets ONE field of the shared avatar record, keeping the others. The two
 * toggles (images, roster names) live in one record, so a write that rebuilt it
 * from `{}` after a failed read would silently reset the other one (PR #141,
 * Dexter F3). `read()` folds "unreadable" and "corrupt" into the fallback, so
 * the decision is made on `readState`: only a record that is `ok` or `missing`
 * may be written over. Throws, with nothing written, otherwise.
 */
function saveField(store, field, value) {
  if (typeof store.readState === 'function') {
    const st = store.readState(AVATAR_KEY);
    if (st.status !== 'ok' && st.status !== 'missing') {
      throw new Error(`the avatar record is ${st.status}; not writing over it`);
    }
  }
  store.update(AVATAR_KEY, {}, (prev) => ({
    ...(prev && typeof prev === 'object' ? prev : {}), [field]: value,
  }));
}

function pickerOptions() {
  return {
    title: 'Choose an agent picture',
    properties: ['openFile'],
    filters: [{ name: 'Pictures, GIFs and video', extensions: MEDIA_EXTENSIONS }],
  };
}

// `isSender` and `send` (worktree tabs): the window is a shell of tab views, so
// "from this window" means "from one of its views", and a push goes to every
// view. Absent, the old single-page rule and `win.webContents.send`.
function registerAvatarHandlers({ ipcMain, store, win, dialog, sync = {}, isSender, send }) {
  const fromWindow = (e) => !!e && (typeof isSender === 'function'
    ? isSender(e.sender) === true
    : !!(win && e.sender === win.webContents));
  const push = typeof send === 'function' ? send : (ch, v) => win.webContents.send(ch, v);

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readImagesEnabled(store) : true));

  ipcMain.handle(SET_CHANNEL, (e, enabled) => {
    if (!fromWindow(e)) return null;
    if (typeof enabled !== 'boolean') return null;
    try {
      saveField(store, 'imagesEnabled', enabled);
    } catch (err) {
      console.error('[main] could not save the agent-images toggle:', err && err.message);
      return null;
    }
    // The watcher must know what this window was just told, or a later change
    // back would compare equal to its stale memory and never be pushed (Dexter N2).
    sync.last = enabled;
    try { push(PUSH_CHANNEL, enabled); } catch { /* window is going away */ }
    return enabled;
  });

  ipcMain.handle(NAMES_GET_CHANNEL, (e) => (fromWindow(e) ? readRosterNames(store) : 'role'));

  ipcMain.handle(NAMES_SET_CHANNEL, (e, mode) => {
    if (!fromWindow(e)) return null;
    if (mode !== 'role' && mode !== 'name') return null;
    try {
      saveField(store, 'rosterNames', mode);
    } catch (err) {
      console.error('[main] could not save the roster names toggle:', err && err.message);
      return null;
    }
    sync.lastNames = mode;
    try { push(NAMES_PUSH_CHANNEL, mode); } catch { /* window is going away */ }
    return mode;
  });

  ipcMain.handle(PICK_CHANNEL, async (e) => {
    if (!fromWindow(e)) return null;
    try {
      const r = await dialog.showOpenDialog(win, pickerOptions());
      return r && !r.canceled && Array.isArray(r.filePaths) && typeof r.filePaths[0] === 'string'
        ? r.filePaths[0] : null;
    } catch (err) {
      console.error('[main] the picture picker failed:', err && err.message);
      return null;
    }
  });
}

/**
 * The toggle is install-wide but every project window is its own Electron main
 * (Dexter F3, PR #64): a change made by ANOTHER main lands in the shared store
 * file and never reaches this window's renderer, whose videos keep playing.
 * Polls the store file (fs.watchFile survives the store's temp+rename writes)
 * and pushes when the value differs from the last one this window was told.
 * Returns stop(). A window that has gone away is not an error.
 */
function watchImagesEnabled({
  store, file, win, intervalMs = 500, watchFile = fs.watchFile, unwatchFile = fs.unwatchFile, sync = {}, send,
}) {
  const push = typeof send === 'function' ? send : (ch, v) => win.webContents.send(ch, v);
  sync.last = readImagesEnabled(store);
  sync.lastNames = readRosterNames(store);
  const listener = () => {
    // A read that FAILED (EBUSY under an antivirus scan) or found a corrupt file
    // says nothing about the user's choice: skip it and let the next poll try,
    // instead of pushing the fresh-install default of "on" (Dexter N2).
    // ONE read feeds both values (PR #141, Dexter F4): two separate reads could
    // disagree about whether the file was readable, and a failed second read
    // would revert the roster names to their default.
    let rec;
    if (typeof store.readState === 'function') {
      const st = store.readState(AVATAR_KEY);
      if (st.status === 'missing') rec = {};
      else if (st.status === 'ok') rec = st.value;
      else return;
    } else {
      try { rec = store.read(AVATAR_KEY, {}); } catch { rec = {}; }
    }
    const now = imagesFromRecord(rec);
    if (now !== sync.last) {
      sync.last = now;
      try { push(PUSH_CHANNEL, now); } catch { /* window is going away */ }
    }
    // The roster names mode (#76) lives in the same record, so the same poll follows it.
    const names = namesFromRecord(rec);
    if (names !== sync.lastNames) {
      sync.lastNames = names;
      try { push(NAMES_PUSH_CHANNEL, names); } catch { /* window is going away */ }
    }
  };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

module.exports = {
  readImagesEnabled, readRosterNames, registerAvatarHandlers, pickerOptions, watchImagesEnabled,
  AVATAR_KEY, GET_CHANNEL, SET_CHANNEL, PICK_CHANNEL, PUSH_CHANNEL,
  NAMES_GET_CHANNEL, NAMES_SET_CHANNEL, NAMES_PUSH_CHANNEL,
};
