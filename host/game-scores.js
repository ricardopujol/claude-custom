'use strict';
/**
 * The wait games' best scores (BACKLOG #41), kept install-wide in the same store as the other window-wide UI state: one best per
 * game, shared by every project window, shown in the Games panel's title. `read()` always returns all three games, each a whole
 * number from 0: a missing file, a corrupt one, a value that isn't a plain count, or a store that throws all mean "no best yet" for
 * that game, never an error and never a confident wrong number. `submit(game, score)` raises a best and never lowers one, and it never writes over
 * a file it could not read (held, or corrupt): the stored bests survive, and the submit answers null.
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
  // What the file holds and whether that is SAFE TO WRITE OVER. store.read() folds an unreadable file (EBUSY while antivirus holds
  // a freshly renamed one) and a corrupt one into its fallback, which would read as "every best is 0" and let the next record
  // replace real bests. Only a missing file or a good read may be written over: the store's own rule since PR #29 (F1).
  const look = () => {
    try {
      if (typeof store.readState !== 'function') return { writable: true, bests: clean(store.read(key, {})) };
      const st = store.readState(key);
      if (st.status === 'ok') return { writable: true, bests: clean(st.value) };
      return { writable: st.status === 'missing', bests: empty() };
    } catch { return { writable: false, bests: empty() }; }
  };
  const read = () => look().bests;
  return {
    read,
    /**
     * -> the bests after the call, or null when `game` isn't one of ours, `score` isn't a whole number from 0, the file couldn't be
     * read (it is left exactly as it is), or the write failed. A score that doesn't beat the best leaves the file alone and answers
     * with the bests as they are.
     */
    submit(game, score) {
      if (!GAMES.includes(game) || !isCount(score)) return null;
      try {
        const first = look();
        if (!first.writable) return null;
        if (score <= first.bests[game]) return first.bests;     // not a record: no lock, no write
        const run = () => {
          const now = look();                                   // again, inside the lock: another window may have raised it
          if (!now.writable) return null;
          if (score <= now.bests[game]) return now.bests;
          const next = { ...now.bests, [game]: score };
          store.write(key, next);
          return next;
        };
        return typeof store.withLock === 'function' ? store.withLock(key, run) : run();
      } catch { return null; }
    },
  };
}

module.exports = { createScoreStore, clean, GAMES, KEY, MAX_SCORE };
