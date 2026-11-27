'use strict';
/**
 * Who a push reaches, with several project windows in one process (single-instance PR 2).
 *
 *   pushToAll(channel, value)   every live tab view of EVERY window: install-wide settings (the avatar toggle, window chrome, fonts, presets)
 *   pushToProject(pw)           a sender for ONE window's views only: that project's layout and tree, its playback state
 *
 * `registry` is app/project-registry.js; a window offers forEachView(fn) over its live views. Pure: no Electron.
 */

function createPushers(registry) {
  const toViews = (pw, channel, value) => pw.forEachView((v) => v.webContents.send(channel, value));
  return {
    pushToAll: (channel, value) => registry.forEach((pw) => toViews(pw, channel, value)),
    pushToProject: (pw) => (channel, value) => toViews(pw, channel, value),
  };
}

module.exports = { createPushers };
