'use strict';
/**
 * A tab's page never navigates (PR #204 Miguel B1). It is loaded once with loadFile, and nothing in it changes
 * window.location; so every navigation the page or a click starts is refused, whatever started it. Without this, an
 * <a href> that got into the DOM (a Markdown diagram's link was the case) replaced the harness UI with a remote page in
 * the same webContents, with the preload bridge attached to whatever loaded.
 *
 * loadFile / loadURL / reload called from main do not raise these events, so the app's own loads are unaffected.
 *
 *   guardNavigation(wc, log?) -> the events it guards
 */
const EVENTS = ['will-navigate', 'will-frame-navigate', 'will-redirect'];

function guardNavigation(wc, log = (...a) => console.error(...a)) {
  for (const ev of EVENTS) {
    wc.on(ev, (event, url) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      let target = typeof url === 'string' ? url : event && typeof event.url === 'string' ? event.url : '';
      if (target.length > 200) target = `${target.slice(0, 200)}...`;
      log(`[main] a tab page tried to navigate (${ev}) and was refused: ${target}`);
    });
  }
  return EVENTS.slice();
}

module.exports = { guardNavigation, EVENTS };
