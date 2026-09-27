'use strict';
/**
 * Favourites: pure decisions only. See app/models-favourites.js's header for
 * why persistence and DOM writes are deliberately kept out of this module.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  emptyFavourites, normalizeFavourites, isFavourite, toggleFavourite,
  partitionFavourites, pinFavouritesFirst,
} = require('../app/models-favourites');

// --- normalizeFavourites -------------------------------------------------------

test('normalizeFavourites of garbage is always the empty shape, never a throw', () => {
  for (const raw of [undefined, null, 42, 'x', [], [1], true, { openrouter: 'not-array' }]) {
    assert.deepStrictEqual(normalizeFavourites(raw), emptyFavourites(), JSON.stringify(raw));
  }
});

test('normalizeFavourites keeps only non-empty strings, deduped, in first-seen order', () => {
  const out = normalizeFavourites({
    openrouter: ['a/b', '', 42, null, 'a/b', 'c/d'],
    claude: ['opus', 'opus', 'sonnet'],
  });
  assert.deepStrictEqual(out, { openrouter: ['a/b', 'c/d'], claude: ['opus', 'sonnet'] });
});

test('property: normalizeFavourites is idempotent over arbitrary JSON', () => {
  fc.assert(fc.property(fc.jsonValue(), (raw) => {
    const once = normalizeFavourites(raw);
    assert.deepStrictEqual(normalizeFavourites(once), once);
  }));
});

// --- isFavourite ----------------------------------------------------------------

test('isFavourite is true only for a listed id under the matching kind', () => {
  const fav = { openrouter: ['a/b'], claude: ['opus'] };
  assert.strictEqual(isFavourite(fav, 'openrouter', 'a/b'), true);
  assert.strictEqual(isFavourite(fav, 'openrouter', 'x/y'), false);
  assert.strictEqual(isFavourite(fav, 'claude', 'opus'), true);
  // Cross-kind: the same string under the wrong kind is not a favourite.
  assert.strictEqual(isFavourite(fav, 'claude', 'a/b'), false);
});

test('isFavourite refuses an unknown kind and a non-string id, rather than guessing', () => {
  const fav = { openrouter: ['a/b'], claude: ['opus'] };
  assert.strictEqual(isFavourite(fav, 'ollama', 'a/b'), false);
  assert.strictEqual(isFavourite(fav, 'openrouter', null), false);
  assert.strictEqual(isFavourite(fav, 'openrouter', ''), false);
  assert.strictEqual(isFavourite(null, 'openrouter', 'a/b'), false);
});

// --- toggleFavourite --------------------------------------------------------------

test('toggleFavourite adds an absent id and removes a present one', () => {
  const empty = emptyFavourites();
  const added = toggleFavourite(empty, 'openrouter', 'a/b');
  assert.deepStrictEqual(added, { openrouter: ['a/b'], claude: [] });
  const removed = toggleFavourite(added, 'openrouter', 'a/b');
  assert.deepStrictEqual(removed, { openrouter: [], claude: [] });
});

test('toggleFavourite never mutates its input', () => {
  const before = { openrouter: ['a/b'], claude: [] };
  const snapshot = JSON.parse(JSON.stringify(before));
  toggleFavourite(before, 'openrouter', 'c/d');
  assert.deepStrictEqual(before, snapshot);
});

test('toggleFavourite is a no-op (beyond normalizing) for an unknown kind or bad id', () => {
  const fav = { openrouter: ['a/b'], claude: ['opus'] };
  assert.deepStrictEqual(toggleFavourite(fav, 'ollama', 'x'), normalizeFavourites(fav));
  assert.deepStrictEqual(toggleFavourite(fav, 'openrouter', ''), normalizeFavourites(fav));
  assert.deepStrictEqual(toggleFavourite(fav, 'openrouter', null), normalizeFavourites(fav));
});

test('toggling twice is the identity', () => {
  const fav = { openrouter: ['a/b'], claude: [] };
  assert.deepStrictEqual(toggleFavourite(toggleFavourite(fav, 'openrouter', 'c/d'), 'openrouter', 'c/d'), normalizeFavourites(fav));
});

test('the OTHER kind is untouched by a toggle', () => {
  const fav = { openrouter: ['a/b'], claude: ['opus'] };
  const after = toggleFavourite(fav, 'claude', 'sonnet');
  assert.deepStrictEqual(after.openrouter, ['a/b']);
  assert.deepStrictEqual(after.claude, ['opus', 'sonnet']);
});

// --- partitionFavourites / pinFavouritesFirst --------------------------------------

test('partitionFavourites splits items by favourite id, preserving relative order in each half', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const { favourites, rest } = partitionFavourites(items, ['c', 'a'], (m) => m.id);
  assert.deepStrictEqual(favourites.map((m) => m.id), ['a', 'c']);
  assert.deepStrictEqual(rest.map((m) => m.id), ['b', 'd']);
});

test('partitionFavourites with no favourites puts everything in rest, in order', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const { favourites, rest } = partitionFavourites(items, [], (m) => m.id);
  assert.deepStrictEqual(favourites, []);
  assert.deepStrictEqual(rest.map((m) => m.id), ['a', 'b']);
});

test('partitionFavourites tolerates a non-array items/favouriteIds and a missing idOf', () => {
  assert.deepStrictEqual(partitionFavourites(null, null), { favourites: [], rest: [] });
  assert.deepStrictEqual(partitionFavourites(['a', 'b'], ['a']), { favourites: ['a'], rest: ['b'] });
});

test('pinFavouritesFirst concatenates favourites ahead of the rest, stably', () => {
  const items = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(pinFavouritesFirst(items, ['c'], (x) => x), ['c', 'a', 'b', 'd']);
  assert.deepStrictEqual(pinFavouritesFirst(items, [], (x) => x), items);
});

test('property: pinFavouritesFirst is a permutation of the input, never drops or duplicates', () => {
  fc.assert(fc.property(
    fc.array(fc.string(), { minLength: 0, maxLength: 20 }),
    fc.array(fc.string(), { minLength: 0, maxLength: 10 }),
    (items, favIds) => {
      const out = pinFavouritesFirst(items, favIds, (x) => x);
      assert.deepStrictEqual([...out].sort(), [...items].sort());
    },
  ));
});

test('property: every favourited-and-present item sorts ahead of every non-favourited one', () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 20 }),
    fc.array(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 10 }),
    (items, favIds) => {
      const out = pinFavouritesFirst(items, favIds, (x) => x);
      const favSet = new Set(favIds);
      let seenNonFav = false;
      for (const x of out) {
        if (favSet.has(x)) assert.ok(!seenNonFav, `${x} is favourited but sorted after a non-favourite`);
        else seenNonFav = true;
      }
    },
  ));
});
