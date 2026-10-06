'use strict';
/**
 * The ONLY thing the untrusted page in Claude's panel can call (BACKLOG #71). Five functions, each a message that main
 * validates (app/canvas-views.js); everything the page is allowed to do comes down to these.
 *
 *   fetch(url, init)  -> the broker (app/canvas-fetch.js): only a host the person approved for this panel is reached.
 *                        The page does not call this itself: the shim in app/canvas-csp.js replaces `window.fetch` with it.
 *   send(text)        -> a line of text toward the session (a button). Main refuses it unless a real click or key press
 *                        arrived at this page a moment ago, so a script cannot press its own button.
 *   shelf()           -> a Promise of the artifact shelf [{ title, url, time }] (read-only: the host fills it from the CLI's own hook).
 *   onShelf(fn)       -> fn(items) whenever the shelf changes; replaces the one listener (a non-function removes it).
 *   open(url)         -> open an address that is EXACTLY on the shelf in the browser, on a real click (the same click as send's).
 *
 * This file requires nothing but `electron` (it runs sandboxed) and copies what it passes on, so no object of the page's
 * own travels to main.
 */
const { contextBridge, ipcRenderer } = require('electron');

function plainInit(init) {
  const out = {};
  if (init === null || typeof init !== 'object') return out;
  if (init.method !== undefined) out.method = String(init.method);
  if (init.headers !== undefined && init.headers !== null && typeof init.headers === 'object') {
    out.headers = {};
    for (const k of Object.keys(init.headers)) out.headers[k] = String(init.headers[k]);
  }
  if (typeof init.body === 'string') out.body = init.body;
  return out;
}

contextBridge.exposeInMainWorld('claudePanel', {
  fetch: (url, init) => ipcRenderer.invoke('canvas:fetch', { url: String(url), init: plainInit(init) }),
  send: (text) => { ipcRenderer.send('canvas:send', { kind: 'send', text: String(text) }); },
  shelf: () => ipcRenderer.invoke('canvas:shelf'),
  onShelf: (fn) => {
    ipcRenderer.removeAllListeners('canvas:shelf');
    if (typeof fn !== 'function') return;
    ipcRenderer.on('canvas:shelf', (_e, items) => { try { fn(items); } catch { /* a page bug is the page's, never the preload's */ } });
  },
  open: (url) => { ipcRenderer.send('canvas:open', { url: String(url) }); },
});
