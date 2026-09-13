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
});
