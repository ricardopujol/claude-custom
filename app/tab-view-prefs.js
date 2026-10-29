'use strict';
/**
 * The web preferences of a tab's page, in ONE place so the app (app/main.js createTabView) and the verify/ probes that stand a tab page up
 * use the very same ones: a probe that wrote its own measured its own setting, not the app's (PR #224, Miguel I4).
 */
function tabViewWebPreferences(preload) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    preload,
    // BACKLOG #156: the knock for a held message (app/peer-cue.js) plays while nobody has touched this page, in a tab that may be hidden.
    autoplayPolicy: 'no-user-gesture-required',
  };
}

module.exports = { tabViewWebPreferences };
