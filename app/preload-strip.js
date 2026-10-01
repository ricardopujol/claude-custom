'use strict';
/**
 * The tab strip page's bridge (PR 2, worktree tabs). The strip is the window's
 * OWN page; the tabs' pages are separate views with app/preload.js.
 *
 * Four members and no more: three ways to ask main for something (select a
 * tab, close a tab, open a tab's context menu) and one way to hear the model
 * main pushes. The strip decides nothing -- main answers every one of these
 * from host/tab-lifecycle.js and app/tab-model.js. Every channel is gated on
 * `event.sender === win.webContents` in main, so a tab's page cannot use them.
 *
 * `onModel` replaces rather than accumulates its listener (the convention in
 * app/preload.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strip', {
  select: (key) => ipcRenderer.send('strip:select', key),
  close: (key) => ipcRenderer.send('strip:close', key),
  contextMenu: (key) => ipcRenderer.send('strip:contextMenu', key),
  onModel: (fn) => (ipcRenderer.removeAllListeners('strip-model'), ipcRenderer.on('strip-model',
    (_e, payload) => {
      try { fn(payload); } catch (err) { console.error('[preload-strip] model listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('strip-model')),
});
