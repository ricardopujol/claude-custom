'use strict';
/**
 * Main's half of lean mode (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md): the window-level state
 * (app/lean-state.js) behind three IPC channels, and the push of every change to the tab pages and the strip.
 *
 *   lean:get     (invoke)  a tab view or the strip asks the state
 *   lean:set     (send)    the ☾ Lean button / Back to normal: a boolean, from a tab view or the strip
 *   lean:night   (send)    a tab view reports its session's /bedtime night: the night's start (ms), or null when it
 *                          ended. The night is the HOST's word (host/bedtime-state.js), forwarded by the page; a page
 *                          whose socket merely dropped says nothing.
 *   lean-state   (push)    the state, whenever it actually changed
 *
 * `isView` / `isStrip` say who a sender is, as in app/playback-bridge.js: a handler that answers anyone is not a
 * boundary. A tab view going away calls `dropOwner` so its night cannot keep the window lean for ever.
 * Its own module so it can be tested without booting Electron.
 */
const { createLean } = require('./lean-state');

const GET_CHANNEL = 'lean:get';
const SET_CHANNEL = 'lean:set';
const NIGHT_CHANNEL = 'lean:night';
const PUSH_CHANNEL = 'lean-state';

function registerLeanHandlers({ ipcMain, isView, isStrip, push, lean = createLean() }) {
  const view = (s) => typeof isView === 'function' && isView(s) === true;
  const strip = (s) => typeof isStrip === 'function' && isStrip(s) === true;
  const announce = (changed) => {
    if (!changed) return;
    try { push(lean.view()); } catch { /* the window is going away */ }
  };

  ipcMain.handle(GET_CHANNEL, (e) => (e && (view(e.sender) || strip(e.sender)) ? lean.view() : null));
  ipcMain.on(SET_CHANNEL, (e, on) => {
    if (!e || !(view(e.sender) || strip(e.sender)) || typeof on !== 'boolean') return;
    announce(lean.setByHand(on));
  });
  ipcMain.on(NIGHT_CHANNEL, (e, startedAt) => {
    if (!e || !view(e.sender)) return;
    const owner = e.sender.id;
    if (startedAt === null) announce(lean.nightEnded(owner));
    else if (typeof startedAt === 'number') announce(lean.nightStarted(owner, startedAt));
  });

  return {
    view: () => lean.view(),
    dropOwner: (owner) => announce(lean.nightEnded(owner)),
  };
}

module.exports = { registerLeanHandlers, GET_CHANNEL, SET_CHANNEL, NIGHT_CHANNEL, PUSH_CHANNEL };
