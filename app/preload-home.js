'use strict';
/**
 * Jiandu Home's bridge (plan documentation/PLAN_PROJECT_HUB.md H-PR2). Two members and no more: hear the payload main pushes, and send
 * one ask. Main decides everything (app/home-controller.js validates each ask) and gates the channel on the Home window's own
 * webContents, so no other page can use it. `onModel` replaces rather than accumulates its listener (the convention in app/preload.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

let listener = null;
ipcRenderer.on('home:model', (_e, payload) => { if (listener) listener(payload); });

contextBridge.exposeInMainWorld('home', {
  onModel: (fn) => { listener = typeof fn === 'function' ? fn : null; ipcRenderer.send('home:ready'); },
  act: (msg) => ipcRenderer.send('home:act', msg),
});
