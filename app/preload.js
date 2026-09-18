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
  },
});
