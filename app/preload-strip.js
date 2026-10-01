'use strict';
/**
 * The tab strip page's bridge (PR 2, worktree tabs). The strip is the window's
 * OWN page; the tabs' pages are separate views with app/preload.js.
 *
 * Seven members and no more: six ways to ask main for something and one way to
 * hear the model main pushes. PR 2: select a tab, close a tab, open a tab's
 * context menu. PR 3: open the `+` menu (New branch… / Reopen), submit the
 * branch form, and cancel it. The strip decides nothing -- main answers every
 * one of these from host/tab-lifecycle.js and app/tab-shell.js. Every channel
 * is gated on `event.sender === win.webContents` in main, so a tab's page
 * cannot use them.
 *
 * `onModel` replaces rather than accumulates its listener (the convention in
 * app/preload.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strip', {
  select: (key) => ipcRenderer.send('strip:select', key),
  close: (key) => ipcRenderer.send('strip:close', key),
  contextMenu: (key) => ipcRenderer.send('strip:contextMenu', key),
  plus: () => ipcRenderer.send('strip:plus'),
  create: (branch) => ipcRenderer.send('strip:create', branch),
  cancelCreate: () => ipcRenderer.send('strip:cancelCreate'),
  onModel: (fn) => (ipcRenderer.removeAllListeners('strip-model'), ipcRenderer.on('strip-model',
    (_e, payload) => {
      try { fn(payload); } catch (err) { console.error('[preload-strip] model listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('strip-model')),
});
