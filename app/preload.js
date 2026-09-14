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
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  attention: (surfaces) => ipcRenderer.send('attention', surfaces),

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
