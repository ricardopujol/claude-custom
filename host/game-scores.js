'use strict';
/**
 * The wait games' best scores (BACKLOG #41), kept install-wide in the same store as the other window-wide UI state: one best per
 * game, shared by every project window, shown in the Games panel's title. `read()` always returns all three games, each a whole
 * number from 0: a missing file, a corrupt one, a value that isn't a plain count, or a store that throws all mean "no best yet" for
 * that game, never an error and never a confident wrong number. `submit(game, score)` raises a best and never lowers one.
 *
 * Another project window is another main process on the same file, so a raise is read-modify-write under the store's
 * cross-process lock (a lost raise would cost someone their record); the write itself is the store's temp-and-rename.
 */
const KEY = 'wait-games';
const GAMES = Object.freeze(['stack', 'merge', 'pipeline']);
const MAX_SCORE = 1000000;     // nothing a 45-second round can reach; a damaged file's 1e306 is not a record

const isCount = v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_SCORE;
const empty = () => Object.fromEntries(GAMES.map(g => [g, 0]));

/** What a stored value means: every game's best, 0 where the file has nothing usable. */
function clean(raw) {
  const out = empty();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const g of GAMES) if (isCount(raw[g])) out[g] = raw[g];
  return out;
}

function createScoreStore(store, key = KEY) {
  const read = () => {
    try { return clean(store.read(key, {})); } catch { return empty(); }
  };
  return {
    read,
    /**
     * -> the bests after the call, or null when `game` isn't one of ours, `score` isn't a whole number from 0, or the write failed.
     * A score that doesn't beat the best leaves the file alone and answers with the bests as they are.
     */
    submit(game, score) {
      if (!GAMES.includes(game) || !isCount(score)) return null;
      try {
        const best = read();
        if (score <= best[game]) return best;     // not a record: no lock, no write
        const run = () => {
          const now = read();
          if (score <= now[game]) return now;
          const next = { ...now, [game]: score };
          store.write(key, next);
          return next;
        };
        return typeof store.withLock === 'function' ? store.withLock(key, run) : run();
      } catch { return null; }
    },
  };
}

module.exports = { createScoreStore, clean, GAMES, KEY, MAX_SCORE };
