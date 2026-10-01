'use strict';
/**
 * The tab strip page's bridge (PR 2, worktree tabs). The strip is the window's
 * OWN page; the tabs' pages are separate views with app/preload.js.
 *
 * Five members and no more: four ways to ask main for something (select a
 * tab, close a tab, open a tab's context menu, open the ▾ menu of running
 * sessions -- which resolves when that menu closes) and one way to hear the
 * model main pushes. The strip decides nothing -- main answers every one of these
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
  background: () => ipcRenderer.invoke('strip:background'),
  onModel: (fn) => (ipcRenderer.removeAllListeners('strip-model'), ipcRenderer.on('strip-model',
    (_e, payload) => {
      try { fn(payload); } catch (err) { console.error('[preload-strip] model listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('strip-model')),
});
