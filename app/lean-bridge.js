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

/**
 * ONE window's lean state, its faces, and the pushes of every change to that window's own pages (single-instance PR 2: lean stays per
 * window, Q3 default). It touches no ipcMain: registerLeanHandlers registers the channels once and hands each message to the unit of
 * the window it came from.
 */
function createLeanUnit({ push, pushFaces = () => {}, lean = createLean(), faces = createFaces() }) {
  const announce = (changed) => {
    if (!changed) return;
    try { push(lean.view()); } catch { /* the window is going away */ }
  };
  const announceFaces = (changed) => {
    if (!changed) return;
    try { pushFaces(faces.flat()); } catch { /* the window is going away */ }
  };
  return {
    view: () => lean.view(),
    faces: () => faces.flat(),
    dropOwner: (owner) => { announce(lean.nightEnded(owner)); announceFaces(faces.drop(owner)); },
    setByHand: (on) => announce(lean.setByHand(on)),
    night: (owner, startedAt) => {
      if (startedAt === null) announce(lean.nightEnded(owner));
      else if (typeof startedAt === 'number') announce(lean.nightStarted(owner, startedAt));
    },
    setFaces: (owner, list) => announceFaces(faces.set(owner, list)),
  };
}

/**
 * Two forms. With `unitOf(sender)` (several windows): the unit of the window that owns the sender, as `{ unit, isView }`, or null for a
 * page that is not one of ours. Without it (the single form): `isView` / `isStrip` say who a sender is, one unit is made from
 * `lean`/`faces`/`push`/`pushFaces`, and it is what's returned.
 */
function registerLeanHandlers({ ipcMain, unitOf, isView, isStrip, push, pushFaces, lean, faces }) {
  let single = null;
  let resolve = unitOf;
  if (typeof unitOf !== 'function') {
    single = createLeanUnit({ push, pushFaces, lean, faces });
    resolve = (s) => {
      if (typeof isView === 'function' && isView(s) === true) return { unit: single, isView: true };
      if (typeof isStrip === 'function' && isStrip(s) === true) return { unit: single, isView: false };
      return null;
    };
  }
  const of = (e) => (e ? resolve(e.sender) || null : null);

  ipcMain.handle(GET_CHANNEL, (e) => { const r = of(e); return r ? r.unit.view() : null; });
  ipcMain.on(SET_CHANNEL, (e, on) => {
    const r = of(e);
    if (!r || typeof on !== 'boolean') return;
    r.unit.setByHand(on);
  });
  ipcMain.on(NIGHT_CHANNEL, (e, startedAt) => {
    const r = of(e);
    if (!r || !r.isView) return;
    r.unit.night(e.sender.id, startedAt);
  });
  ipcMain.on(FACES_CHANNEL, (e, list) => {
    const r = of(e);
    if (!r || !r.isView) return;
    r.unit.setFaces(e.sender.id, list);
  });

  return single;
}

module.exports = { registerLeanHandlers, createLeanUnit, GET_CHANNEL, SET_CHANNEL, NIGHT_CHANNEL, PUSH_CHANNEL, FACES_CHANNEL, FACES_PUSH };
