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
 * regenerable.
 *
 * Its own module, not inline in main.js, for the same reason
 * app/clipboard-bridge.js is: it can be tested without booting Electron, and
 * a probe can register the SHIPPED handlers rather than a copy.
 *
 * `add a bridge method, don't widen an existing one to arbitrary keys`
 * (BACKLOG E #5): this is why `favourites:get`/`favourites:set` are new
 * channels rather than teaching `look:setDim` to accept any key -- a generic
 * "set arbitrary store key" handler reachable from the page would let a
 * compromised renderer overwrite `look-global` itself.
 *
 * `favourites:set`, NOT `favourites:toggle` (Dexter, PR #60 review, Finding
 * 6). Two Electron main processes share this one store file, and a TOGGLE
 * computed against the store's CURRENT value inverts the user's intent the
 * moment a second window's view is even slightly stale: window B, still
 * showing an empty star because it hasn't heard about window A's favourite
 * yet, sends "toggle X" meaning "add it" and instead REMOVES the favourite A
 * just added. Sending the desired end state (`on: true/false`) makes every
 * click idempotent -- "make X starred" can never un-star it, whichever
 * window's click the store sees last.
 *
 * "Whichever window's click the store sees last" is about ONE id, not a
 * cross-window lock: `store.update` is still an unlocked read-modify-write
 * (host/store.js), so two windows starring DIFFERENT ids in the same instant
 * can still lose one of them (Dexter, PR #60 review, Finding 8 -- deferred,
 * correctly Low: the data is regenerable and nothing is corrupted). This
 * module fixes WHICH value a single click writes, not whether two
 * simultaneous writers can race.
 */

const { normalizeFavourites, setFavourite, KINDS } = require('./models-favourites');

const FAVOURITES_KEY = 'model-favourites-global';
const GET_CHANNEL = 'favourites:get';
const SET_CHANNEL = 'favourites:set';

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
 * Registers `favourites:get` and `favourites:set` on `ipcMain`, gated to
 * `win`'s own webContents -- the same `fromWindow`-shaped boundary every
 * other main-process handler uses (secrets:*, clipboard:read, look:*): a
 * handler that answers anyone is not a boundary, even for state this
 * low-stakes. Consistency, not because a starred model is a secret.
 */
function registerFavouriteHandlers({ ipcMain, store, win, isSender }) {
  // `isSender` (worktree tabs): the window is a shell of tab views, so "from
  // this window" means "from one of its views". Absent, the old rule.
  const fromWindow = (e) => !!e && (typeof isSender === 'function'
    ? isSender(e.sender) === true
    : !!(win && e.sender === win.webContents));

  ipcMain.handle(GET_CHANNEL, (e) => (fromWindow(e) ? readFavourites(store) : emptyFavourites()));

  ipcMain.handle(SET_CHANNEL, (e, kind, id, on) => {
    if (!fromWindow(e)) return null;
    // Dexter, PR #60 round 2, N5: `on` used to be truth-coerced (`!!on`)
    // inside setFavourite, so the literal string `'false'` -- truthy in
    // JavaScript -- STARRED the model instead of leaving it unstarred. Only
    // the renderer sends this today, and it always sends a real boolean, but
    // the channel itself must refuse the ambiguous case rather than silently
    // doing the opposite of what was asked.
    if (KINDS.indexOf(kind) === -1 || typeof id !== 'string' || !id || typeof on !== 'boolean') return null;
    let next = null;
    try {
      store.update(FAVOURITES_KEY, {}, (prev) => {
        next = setFavourite(prev, kind, id, on);
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
  readFavourites, registerFavouriteHandlers, FAVOURITES_KEY, GET_CHANNEL, SET_CHANNEL,
};
