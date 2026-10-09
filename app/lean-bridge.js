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
 *   lean:faces   (send)    a tab view's working agents, for the strip's portraits (app/lean-faces.js sanitises them); main keeps one list per
 *                          view and pushes the window's whole set to the strip as `lean-faces` whenever it changes
 *
 * `isView` / `isStrip` say who a sender is, as in app/playback-bridge.js: a handler that answers anyone is not a
 * boundary. A tab view going away calls `dropOwner` so its night cannot keep the window lean for ever.
 * Its own module so it can be tested without booting Electron.
 */
const { createLean } = require('./lean-state');
const { createFaces } = require('./lean-faces');

const GET_CHANNEL = 'lean:get';
const SET_CHANNEL = 'lean:set';
const NIGHT_CHANNEL = 'lean:night';
const PUSH_CHANNEL = 'lean-state';
const FACES_CHANNEL = 'lean:faces';
const FACES_PUSH = 'lean-faces';

function registerLeanHandlers({ ipcMain, isView, isStrip, push, pushFaces = () => {}, lean = createLean(), faces = createFaces() }) {
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

  const announceFaces = (changed) => {
    if (!changed) return;
    try { pushFaces(faces.flat()); } catch { /* the window is going away */ }
  };
  ipcMain.on(FACES_CHANNEL, (e, list) => {
    if (!e || !view(e.sender)) return;
    announceFaces(faces.set(e.sender.id, list));
  });

  return {
    view: () => lean.view(),
    faces: () => faces.flat(),
    dropOwner: (owner) => { announce(lean.nightEnded(owner)); announceFaces(faces.drop(owner)); },
  };
}

module.exports = { registerLeanHandlers, GET_CHANNEL, SET_CHANNEL, NIGHT_CHANNEL, PUSH_CHANNEL, FACES_CHANNEL, FACES_PUSH };
