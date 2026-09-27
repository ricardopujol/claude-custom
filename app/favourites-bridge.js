'use strict';
/**
 * Main's half of model favourites (BACKLOG E #5, step 3): a star on any
 * OpenRouter row or Claude choice, persisted GLOBALLY -- not per project --
 * next to the install-wide unfocused-window dim (`look-global`,
 * app/main.js's `UI_KEY`).
 *
 * ELECTRON MAIN OWNS THIS STORE, the same one exception host/store.js's
 * header carves out for `look-global`: a favourite is a personal UI
 * preference with no per-project meaning and no fact only the host knows, so
 * there is no reason to round-trip it through a host at all. Its own key,
 * regenerable, last-writer-wins by design -- two windows starring the same
 * model both land on whichever wrote last, same trade `look-global` makes.
 *
 * Its own module, not inline in main.js, for the same reason
 * app/clipboard-bridge.js is: it can be tested without booting Electron, and
 * a probe can register the SHIPPED handlers rather than a copy.
 *
 * `add a bridge method, don't widen an existing one to arbitrary keys`
 * (BACKLOG E #5): this is why `favourites:get`/`favourites:toggle` are new
 * channels rather than teaching `look:setDim` to accept any key -- a generic
 * "set arbitrary store key" handler reachable from the page would let a
 * compromised renderer overwrite `look-global` itself.
 */

const { normalizeFavourites, toggleFavourite } = require('./models-favourites');

const FAVOURITES_KEY = 'model-favourites-global';
const GET_CHANNEL = 'favourites:get';
const TOGGLE_CHANNEL = 'favourites:toggle';
const KINDS = ['openrouter', 'claude'];

function emptyFavourites() {
  return { openrouter: [], claude: [] };
}

/** The current favourites, read through `store` (host/store.js's shape). */
function readFavourites(store) {
  try {
    return normalizeFavourites(store.read(FAVOURITES_KEY, {}));
  } catch {
    // A store that cannot be read degrades to "no favourites" -- the same
    // shape as a fresh install, never a thrown error that would take a
    // window down over a starred model.
    return emptyFavourites();
  }
}

/**
 * Registers `favourites:get` and `favourites:toggle` on `ipcMain`, gated to
 * `win`'s own webContents -- the same `fromWindow`-shaped boundary every
 * other main-process handler uses (secrets:*, clipboard:read, look:*): a
 * handler that answers anyone is not a boundary, even for state this
 * low-stakes. Consistency, not because a starred model is a secret.
 */
function registerFavouriteHandlers({ ipcMain, store, win }) {
  const fromWindow = (e) => !!(e && win && e.sender === win.webContents);

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readFavourites(store) : emptyFavourites()));

  ipcMain.handle(TOGGLE_CHANNEL, (e, kind, id) => {
    if (!fromWindow(e)) return null;
    if (KINDS.indexOf(kind) === -1 || typeof id !== 'string' || !id) return null;
    let next = null;
    try {
      store.update(FAVOURITES_KEY, {}, (prev) => {
        next = toggleFavourite(prev, kind, id);
        return next;
      });
    } catch (err) {
      console.error('[main] could not save a model favourite:', err && err.message);
      return null;
    }
    return next;
  });
}

module.exports = {
  readFavourites, registerFavouriteHandlers, FAVOURITES_KEY, GET_CHANNEL, TOGGLE_CHANNEL,
};
