'use strict';
/**
 * The ONLY thing the untrusted page in Claude's panel can call (BACKLOG #71). Five functions, each a message that main
 * validates (app/canvas-views.js); everything the page is allowed to do comes down to these.
 *
 *   fetch(url, init)  -> the broker (app/canvas-fetch.js): only a host the person approved for this panel is reached.
 *                        The page does not call this itself: the shim in app/canvas-csp.js replaces `window.fetch` with it.
 *   send(text)        -> a line of text toward the session (a button). Main refuses it unless a real click or Enter/Space press
 *                        arrived at this page a moment ago, so a script cannot press its own button.
 *   shelf()           -> a Promise of the artifact shelf [{ title, url, time }] (read-only: the host fills it from the CLI's own hook).
 *   onShelf(fn)       -> fn(items) whenever the shelf changes; replaces the one listener (a non-function removes it).
 *   open(url)         -> open an address that is EXACTLY on the shelf in the browser, on a real click (the same click as send's).
 *
 * This file requires nothing but `electron` (it runs sandboxed) and copies what it passes on, so no object of the page's
 * own travels to main.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// THE FILE-PICKER GUARD (PR #125 Dexter R2-3, Ricardo 2026-10-08: "block what we can"). This preload runs in EVERY frame
// (nodeIntegrationInSubFrames, app/canvas-views.js), but only the top frame gets the bridge below; a sub-frame gets this guard and nothing else.
// Electron 33 has no file-chooser hook, so the click is stopped before it does anything:
//   - a capture-phase listener on the window, in this isolated world (the page cannot remove it), cancels every click that targets an
//     <input type=file>, however it was made: input.click(), label.click(), dispatchEvent(new MouseEvent('click')), a real click on it;
//   - HTMLInputElement.prototype.showPicker, which opens the chooser without a click, is replaced in the page's own world by one that throws
//     NotAllowedError for a file input.
// NOT COVERED, measured (scratchpad, verify/probe-canvas-sandbox.js "known gap" vectors): a page that writes its own about:blank iframe (this
// preload never runs in it), and a page that calls document.open() (the spec erases the window's listeners). Either can still open one Open
// dialog per real click. Claude's pages keep document.write, so document.open is not neutered.
const isFileInputClick = (e) => {
  const path = e && typeof e.composedPath === 'function' ? e.composedPath() : [e && e.target];
  for (const t of path) if (t && t.tagName === 'INPUT' && String(t.type).toLowerCase() === 'file') return true;
  return false;
};
window.addEventListener('click', (e) => { if (isFileInputClick(e)) e.preventDefault(); }, true);
const SHOW_PICKER_GUARD = "(function () { var p = HTMLInputElement.prototype; var orig = p.showPicker; Object.defineProperty(p, 'showPicker', { value: function showPicker() { "
  + "if (String(this.type).toLowerCase() === 'file') throw new DOMException('Choosing a file is not allowed in this panel.', 'NotAllowedError'); return orig.apply(this, arguments); }, "
  + "configurable: false, writable: false }); })()";
try { webFrame.executeJavaScript(SHOW_PICKER_GUARD); } catch { /* a frame being torn down */ }
const isTopFrame = (() => { try { return window.top === window; } catch { return false; } })();

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

if (isTopFrame) contextBridge.exposeInMainWorld('claudePanel', {
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
