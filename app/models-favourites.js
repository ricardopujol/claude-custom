'use strict';
/**
 * BACKLOG E #5, step 3 -- favourites: a star on an OpenRouter row or a Claude
 * choice, pinned to the top of its own list.
 *
 * Pure decisions only, for the reason app/top-bar-display.js and its siblings
 * exist: persistence (app/favourites-bridge.js, main-process IPC) and DOM
 * writes (renderer.js) both belong somewhere they cannot be unit tested at
 * this grain. Everything here is inputs in, a new value or a reordered array
 * out -- no DOM, no IPC, no clock.
 *
 * TWO KINDS, ONE SHAPE. 'openrouter' rows are keyed by the OpenRouter model
 * id (`google/gemini-2.5-pro`); 'claude' choices are keyed by the alias
 * top-bar-display.js's MODEL_CHOICES already uses ('fable', 'opus',
 * 'sonnet', 'haiku'). They are stored as two separate lists rather than one merged set
 * so an OpenRouter id that happens to collide with a future Claude alias
 * (or vice versa) can never cross-favourite the wrong picker.
 *
 * PERSISTED GLOBALLY, not per project (Ricardo's call, BACKLOG E #5 #3): see
 * app/favourites-bridge.js for why this rides in the Electron-main store
 * next to `look-global` rather than through the host.
 *
 * WRAPPED IN AN IIFE for the trap app/career-display.js and its siblings
 * already paid for: renderer.html loads these as plain <script> tags sharing
 * ONE global scope -- see test/renderer-scope.test.js, which enforces the
 * exact `(function (root) {` prefix below so its skip-regex can find this
 * file.
 */
(function (root) {

// Exported (Miguel, PR #60 review, S3): app/favourites-bridge.js used to keep
// its own literal copy of this list, which is exactly the kind of thing that
// silently drifts the day a third kind is added to one file and not the
// other.
const KINDS = Object.freeze(['openrouter', 'claude']);

function emptyFavourites() {
  return { openrouter: [], claude: [] };
}

/**
 * Whatever arrives -- a fresh store (`{}`), garbage JSON, or a well-formed
 * value -- into exactly `{ openrouter: string[], claude: string[] }`, deduped
 * and in first-seen order. TOTAL: never throws, and idempotent, so re-running
 * it over its own output is always a no-op (the same property host/look.js's
 * sanitizeLook guarantees for the same reason -- a sanitizer that is not
 * idempotent is a sanitizer that can drift on every read).
 */
function normalizeFavourites(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clean = (v) => {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const out = [];
    for (const id of v) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  return { openrouter: clean(src.openrouter), claude: clean(src.claude) };
}

/** Is `id` favourited under `kind`? An unknown kind or a non-string id is never a favourite. */
function isFavourite(favourites, kind, id) {
  if (KINDS.indexOf(kind) === -1 || typeof id !== 'string' || !id) return false;
  const fav = normalizeFavourites(favourites);
  return fav[kind].includes(id);
}

/**
 * Add `id` if it is absent, remove it if present. Returns a NEW object --
 * `favourites` is never mutated, so a caller holding the old value still sees
 * the old value. An unrecognised `kind` or a non-string/empty `id` returns
 * the input unchanged (normalized), rather than throwing or silently
 * favouriting the wrong list.
 */
function toggleFavourite(favourites, kind, id) {
  const fav = normalizeFavourites(favourites);
  if (KINDS.indexOf(kind) === -1 || typeof id !== 'string' || !id) return fav;
  const list = fav[kind];
  const has = list.includes(id);
  const nextList = has ? list.filter((x) => x !== id) : [...list, id];
  return { ...fav, [kind]: nextList };
}

/**
 * Set `id`'s favourited state to EXACTLY `on`, idempotently -- never flip
 * whatever the store currently holds.
 *
 * Dexter, PR #60 review, Finding 6: two Electron main processes (two windows)
 * share one store file, and each window's `modelFavourites` is only as fresh
 * as its last read (at load, or its last own write's reply). A TOGGLE sent
 * over IPC is computed against the STORE'S current value, not the value the
 * user actually saw when they clicked -- so window B, still showing an empty
 * star because it hasn't heard about window A's favourite yet, can send
 * "toggle X" meaning "add it" and instead REMOVE the very favourite A just
 * added, inverting the user's intent rather than losing to it. Sending the
 * desired end state instead makes every click idempotent: "make X starred"
 * can never accidentally un-star it, whichever window's click lands last.
 *
 * Same total/never-throws contract as `toggleFavourite`: an unrecognised
 * `kind` or a non-string/empty `id` returns the input unchanged (normalized).
 */
function setFavourite(favourites, kind, id, on) {
  const fav = normalizeFavourites(favourites);
  if (KINDS.indexOf(kind) === -1 || typeof id !== 'string' || !id) return fav;
  const list = fav[kind];
  const has = list.includes(id);
  const wants = !!on;
  if (has === wants) return fav;
  const nextList = wants ? [...list, id] : list.filter((x) => x !== id);
  return { ...fav, [kind]: nextList };
}

/**
 * Split `items` into the ones `idOf` maps to a favourited id, and the rest --
 * BOTH IN THEIR ORIGINAL RELATIVE ORDER. This is the one primitive both
 * favourites features build on: the OpenRouter panel renders `favourites` as
 * its own section at the very top of the whole list (ahead of the
 * provider grouping, so a star is never buried inside its provider's own
 * alphabetical/price position); the Claude choices menu concatenates them
 * back together via `pinFavouritesFirst` below, since it has no grouping to
 * preserve.
 */
function partitionFavourites(items, favouriteIds, idOf) {
  const favs = new Set(Array.isArray(favouriteIds) ? favouriteIds : []);
  const list = Array.isArray(items) ? items : [];
  const of = typeof idOf === 'function' ? idOf : (x) => x;
  const favourites = [];
  const rest = [];
  for (const item of list) {
    (favs.has(of(item)) ? favourites : rest).push(item);
  }
  return { favourites, rest };
}

/**
 * `items` with every favourited one moved to the front, STABLE otherwise: the
 * relative order within "favourited" and within "the rest" is untouched. A
 * favourite must only ever PROMOTE a row, never re-sort the list underneath
 * it -- the same rule app/models.js's `sortModels` states for price ties.
 */
function pinFavouritesFirst(items, favouriteIds, idOf) {
  const { favourites, rest } = partitionFavourites(items, favouriteIds, idOf);
  return [...favourites, ...rest];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KINDS, emptyFavourites, normalizeFavourites, isFavourite, toggleFavourite, setFavourite,
    partitionFavourites, pinFavouritesFirst,
  };
} else {
  // KINDS is NOT published to the browser global scope: nothing in the
  // renderer needs it (the two kind strings are literals at each call site
  // already), and `KINDS` is generic enough that publishing it risks
  // colliding with the next module that wants the same name. Only
  // favourites-bridge.js (a `require()`r, via the branch above) needs it.
  root.emptyFavourites = emptyFavourites;
  root.normalizeFavourites = normalizeFavourites;
  root.isFavourite = isFavourite;
  root.toggleFavourite = toggleFavourite;
  root.setFavourite = setFavourite;
  root.partitionFavourites = partitionFavourites;
  root.pinFavouritesFirst = pinFavouritesFirst;
}

})(typeof window !== 'undefined' ? window : globalThis);
