'use strict';
/**
 * The only channel between the window and the main process.
 *
 * It exists for one reason: an OS notification raised by the RENDERER depends
 * on the page's notification permission and cannot flash the taskbar or focus
 * the window. Raised by MAIN it does both, and needs no permission at all.
 *
 * Deliberately one-way and one-purpose. contextIsolation stays on; nothing from
 * Node reaches page scripts.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  attention: (surfaces) => ipcRenderer.send('attention', surfaces),

  // FF4. Main raises and clears the finished-task cue, because only main knows
  // whether the window is focused -- the page cannot tell "you are looking at
  // me" from "I am merely visible". One boolean, one direction.
  // IDEMPOTENT. Miguel, PR #33, A4: this is the bridge's first `ipcRenderer.on`
  // and therefore sets the convention for the next one. Two calls used to
  // register two listeners and ten would trip Node's MaxListeners warning.
  // Replacing rather than accumulating is right for a cue with exactly one
  // owner; it also returns a disposer, so a future caller with two has a way
  // out that is not "reload the window".
  //
  // (No leak on reload: the preload re-executes in a fresh context and the old
  // ipcRenderer listeners die with the old one. The reload problem was the
  // cue being LOST, which main now restores on did-finish-load.)
  onAttentionCue: (fn) => (ipcRenderer.removeAllListeners('attention-cue'), ipcRenderer.on('attention-cue',
    (_e, on) => {
      // LOGGED, not swallowed. Miguel, A3: the old comment claimed this kept
      // a bad listener from killing the bridge, which it cannot -- the bridge
      // is established at load and a throwing listener cannot un-expose it.
      // What the catch actually buys is that one throwing listener does not
      // abort emit()'s loop over the others, and there is exactly one. So the
      // comment claimed a protection the code does not provide against a
      // failure that cannot happen, while the empty block delivered a real
      // cost: a renderer bug in the cue became invisible.
      try { fn(!!on); } catch (err) { console.error('[preload] attention-cue listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('attention-cue')),

  // The real filesystem path behind a dropped File.
  //
  // `File.path` WAS REMOVED IN ELECTRON 32 -- this app is on 33 -- so the old
  // one-liner every drag-and-drop snippet on the internet still shows returns
  // undefined here, silently. `webUtils.getPathForFile` is the replacement and
  // it only exists in the preload: with contextIsolation on, page scripts
  // cannot reach it, which is the whole reason this crosses the bridge.
  //
  // Returns '' rather than throwing for anything that is not a real file (a
  // dragged URL, a text selection), so the caller filters instead of crashing.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },

  // Ctrl+V (BACKLOG #12, #8). Main reads the OS clipboard and answers
  // { text, hasImage } -- see app/clipboard-bridge.js. Read-only: nothing is
  // ever written to the clipboard through this.
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  // The secret store. Every call crosses into main, where the vault lives --
  // the window never holds the file, the key, or more than one secret at a
  // time, and the host (which owns the pty) never sees any of it at all.
  secrets: {
    available: () => ipcRenderer.invoke('secrets:available'),
    list: (query) => ipcRenderer.invoke('secrets:list', query),
    add: (entry) => ipcRenderer.invoke('secrets:add', entry),
    remove: (id) => ipcRenderer.invoke('secrets:remove', id),
    reveal: (id) => ipcRenderer.invoke('secrets:reveal', id),
    copy: (id) => ipcRenderer.invoke('secrets:copy', id),

    // The lock. The password travels INWARD only -- the user types it here and
    // main derives from it. Nothing about the key ever comes back out.
    lockState: () => ipcRenderer.invoke('secrets:lockState'),
    setKey: (key) => ipcRenderer.invoke('secrets:setKey', key),
    unlock: (key) => ipcRenderer.invoke('secrets:unlock', key),
    lock: () => ipcRenderer.invoke('secrets:lock'),
    removeKey: () => ipcRenderer.invoke('secrets:removeKey'),
    melt: () => ipcRenderer.invoke('secrets:melt'),
  },

  // Focus, for the unfocused-window dim. Same replace-don't-accumulate
  // convention as onAttentionCue. `dim` rides along so the page never has to
  // ask for it separately at the moment it needs it.
  onWindowFocus: (fn) => (ipcRenderer.removeAllListeners('window-focus'), ipcRenderer.on('window-focus',
    (_e, state) => {
      try { fn({ focused: !!(state && state.focused), dim: state && state.dim }); } catch (err) {
        console.error('[preload] window-focus listener threw', err);
      }
    }), () => ipcRenderer.removeAllListeners('window-focus')),

  // The install-wide unfocused dim (the project-scoped look goes to the host).
  look: {
    getDim: () => ipcRenderer.invoke('look:getDim'),
    setDim: (value) => ipcRenderer.invoke('look:setDim', value),
  },

  // Model favourites (BACKLOG E #5, #3): a star on an OpenRouter row or a
  // Claude choice, persisted install-wide -- see app/favourites-bridge.js.
  // Its own two channels, not a widened look:setDim: a generic "set any key"
  // handler reachable from the page could overwrite look-global itself.
  favourites: {
    get: () => ipcRenderer.invoke('favourites:get'),
    toggle: (kind, id) => ipcRenderer.invoke('favourites:toggle', kind, id),
  },
});
