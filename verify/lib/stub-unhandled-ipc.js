'use strict';
/**
 * For a probe whose own little main process (a "stand-in", not app/main.js) loads the real app/renderer.html with the real
 * app/preload.js: answer every channel the preload can call that the stand-in did not register itself, with null.
 *
 * WHY. A channel nobody answers is not a harmless gap. `ipcRenderer.invoke` of an unregistered channel logs "No handler
 * registered" and rejects, and `ipcRenderer.sendSync` of one BLOCKS THE RENDERER FOR ABOUT 30 SECONDS (measured on
 * verify/probe-avatar-roster.js, BACKLOG #75: `resources:chipOn` held the page's first script run for 30 s, so the probe's
 * first 30 s wait timed out and the layout was not ready). The renderer gained such channels one PR at a time and a hand-kept
 * list in each stand-in rotted. This reads the channel names out of the preload itself, so a channel added tomorrow is covered.
 *
 * It stubs only what is still unanswered: call it AFTER registering the real bridges (registerAvatarHandlers ...). A stub
 * answers null (invoke) or sets returnValue = null (sendSync), which every caller already treats as "main has no answer".
 */
const fs = require('fs');

const INVOKE = /ipcRenderer\.invoke\(\s*'([^']+)'/g;
const SYNC = /ipcRenderer\.sendSync\(\s*'([^']+)'/g;

const namesOf = (source, re) => [...new Set([...String(source).matchAll(re)].map(m => m[1]))];

/** { invoke: [channel...], sync: [channel...] } the preload source calls. */
function channelsIn(source) {
  return { invoke: namesOf(source, INVOKE), sync: namesOf(source, SYNC) };
}

/**
 * @param {object} ipcMain   Electron's ipcMain (or anything with handle / on / listenerCount)
 * @param {string} preloadFile  absolute path of the preload the page uses
 * @returns {{ invoke: string[], sync: string[] }} the channels it stubbed (the ones nobody had answered)
 */
function stubUnhandledIpc(ipcMain, preloadFile) {
  const { invoke, sync } = channelsIn(fs.readFileSync(preloadFile, 'utf8'));
  const stubbed = { invoke: [], sync: [] };
  for (const ch of invoke) {
    try { ipcMain.handle(ch, () => null); stubbed.invoke.push(ch); } catch { /* already answered by a real handler */ }
  }
  for (const ch of sync) {
    if (ipcMain.listenerCount(ch) > 0) continue;
    ipcMain.on(ch, (e) => { e.returnValue = null; });
    stubbed.sync.push(ch);
  }
  return stubbed;
}

module.exports = { channelsIn, stubUnhandledIpc };
