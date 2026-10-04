'use strict';
/**
 * The tab strip page's bridge (PR 2, worktree tabs). The strip is the window's
 * OWN page; the tabs' pages are separate views with app/preload.js.
 *
 * Eleven members and no more: nine ways to ask main for something and two ways
 * to hear what main pushes (the model, and the accent colour: a #rrggbb, or
 * null when the selected tab hasn't reported one). Layout pass L2: minimise and
 * close the window (only drawn when it's frameless). PR 2: select a tab, close
 * a tab, open a tab's context menu. PR 3: open the `+` menu (New branch… / Reopen), submit the
 * branch form, and cancel it. Windowless sessions PR 2: open the ▾ menu of
 * running sessions, which resolves when that menu closes. The strip decides
 * nothing -- main answers every one of these from host/tab-lifecycle.js and
 * app/tab-shell.js. Every channel is gated on `event.sender === win.webContents`
 * in main, so a tab's page cannot use them.
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
  background: () => ipcRenderer.invoke('strip:background'),
  onModel: (fn) => (ipcRenderer.removeAllListeners('strip-model'), ipcRenderer.on('strip-model',
    (_e, payload) => {
      try { fn(payload); } catch (err) { console.error('[preload-strip] model listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('strip-model')),
  // The selected tab's accent (#64), so the strip wears the colour the person chose.
  onAccent: (fn) => (ipcRenderer.removeAllListeners('strip-accent'), ipcRenderer.on('strip-accent',
    (_e, hex) => {
      try { fn(hex); } catch (err) { console.error('[preload-strip] accent listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('strip-accent')),
  // Layout pass L2 (#28): a frameless window's own buttons. Not `close`, which
  // already means "close a tab". Close is today's window close: the sessions
  // keep running in their detached hosts.
  winMinimize: () => ipcRenderer.send('strip:winMinimize'),
  winClose: () => ipcRenderer.send('strip:winClose'),
});
