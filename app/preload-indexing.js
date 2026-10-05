'use strict';
/**
 * The indexing overlay's bridge (backlog #66): app/indexing-overlay.html, the toast and the "N filed" list that main
 * stacks over the tab views (app/indexing-bridge.js). Every channel is answered in main only when it comes from one of
 * the two overlay views, so no other page can use them. Ids and picker values are checked again there.
 *
 * `onState` replaces rather than accumulates its listener (the convention in app/preload.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('indexing', {
  choose: (id, value) => ipcRenderer.invoke('indexing:choose', id, value),
  move: (id, value) => ipcRenderer.invoke('indexing:move', id, value),
  undo: (id) => ipcRenderer.invoke('indexing:undo', id),
  open: (file) => ipcRenderer.send('indexing:open', file),
  dismiss: (seq) => ipcRenderer.send('indexing:dismiss', seq),
  size: (part, height) => ipcRenderer.send('indexing:size', part, height),
  closeList: () => ipcRenderer.send('indexing:closeList'),
  ready: (part) => ipcRenderer.send('indexing:ready', part),
  onState: (fn) => (ipcRenderer.removeAllListeners('indexing-state'), ipcRenderer.on('indexing-state',
    (_e, state) => {
      try { fn(state); } catch (err) { console.error('[preload-indexing] state listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('indexing-state')),
});
