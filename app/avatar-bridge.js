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

const { MEDIA_EXTENSIONS } = require('../host/portraits');

const AVATAR_KEY = 'avatar-global';
const GET_CHANNEL = 'avatar:getImagesEnabled';
const SET_CHANNEL = 'avatar:setImagesEnabled';
const PICK_CHANNEL = 'avatar:pick';
const PUSH_CHANNEL = 'avatar-images';

/**
 * Whether agent images are shown. ON unless the store holds a real boolean
 * `false`: a missing, corrupt or unreadable record must never silently strip
 * every face (and only an explicit user choice may turn them off).
 */
function readImagesEnabled(store) {
  try {
    const rec = store.read(AVATAR_KEY, {});
    return !(rec && typeof rec === 'object' && rec.imagesEnabled === false);
  } catch {
    return true;
  }
}

function pickerOptions() {
  return {
    title: 'Choose an agent picture',
    properties: ['openFile'],
    filters: [{ name: 'Pictures, GIFs and video', extensions: MEDIA_EXTENSIONS }],
  };
}

function registerAvatarHandlers({ ipcMain, store, win, dialog }) {
  const fromWindow = (e) => !!(e && win && e.sender === win.webContents);

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readImagesEnabled(store) : true));

  ipcMain.handle(SET_CHANNEL, (e, enabled) => {
    if (!fromWindow(e)) return null;
    if (typeof enabled !== 'boolean') return null;
    try {
      store.update(AVATAR_KEY, {}, (prev) => ({
        ...(prev && typeof prev === 'object' ? prev : {}), imagesEnabled: enabled,
      }));
    } catch (err) {
      console.error('[main] could not save the agent-images toggle:', err && err.message);
      return null;
    }
    try { win.webContents.send(PUSH_CHANNEL, enabled); } catch { /* window is going away */ }
    return enabled;
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

module.exports = {
  readImagesEnabled, registerAvatarHandlers, pickerOptions,
  AVATAR_KEY, GET_CHANNEL, SET_CHANNEL, PICK_CHANNEL, PUSH_CHANNEL,
};
