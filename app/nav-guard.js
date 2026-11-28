'use strict';
/**
 * A page with a preload bridge never navigates (PR #204 Miguel B1). It is loaded once with loadFile, and nothing in it changes
 * window.location; so every navigation the page or a click starts is refused, whatever started it. Without this, an
 * <a href> that got into the DOM (a Markdown diagram's link was the case) replaced the harness UI with a remote page in
 * the same webContents, with the preload bridge attached to whatever loaded. Every tab page and Jiandu Home use it.
 *
 * A <webview> is never attached either (PR #263 Miguel G10): inert while `webviewTag` is off, but a later switch must not open a
 * second way in. The canvas and preview views refuse it on their own (app/canvas-views.js, app/preview-views.js).
 *
 * loadFile / loadURL / reload called from main do not raise these events, so the app's own loads are unaffected.
 *
 *   guardNavigation(wc, log?, { who }?) -> the events it guards. `who` names the window in the log line (PR #263 Miguel G9):
 *   "a tab page" by default, "Jiandu Home" for Home, so a refusal is looked for in the right place.
 */
const EVENTS = ['will-navigate', 'will-frame-navigate', 'will-redirect'];
const WEBVIEW = 'will-attach-webview';

const clip = (s) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);

function guardNavigation(wc, log = (...a) => console.error(...a), { who = 'a tab page' } = {}) {
  for (const ev of EVENTS) {
    wc.on(ev, (event, url) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const target = typeof url === 'string' ? url : event && typeof event.url === 'string' ? event.url : '';
      log(`[main] ${who} tried to navigate (${ev}) and was refused: ${clip(target)}`);
    });
  }
  wc.on(WEBVIEW, (event, _prefs, params) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const src = params && typeof params.src === 'string' ? params.src : '';
    log(`[main] ${who} tried to attach a webview and was refused: ${clip(src)}`);
  });
  return [...EVENTS, WEBVIEW];
}

module.exports = { guardNavigation, EVENTS, WEBVIEW };
