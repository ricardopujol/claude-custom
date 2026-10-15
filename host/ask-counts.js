'use strict';
/**
 * The Ask explainer's two counts (BACKLOG #33 gamification): questions it answered and places you opened from it. One explainer per
 * person, so one install-wide file, `.harness/state/ask-counts.json`, shared by every project window (no split by model or project).
 *
 *   createAskCounts({ store })
 *     .read()          -> { questions, places } | null     (null: not readable yet, never 0: `Number(null)` is 0)
 *     .addQuestion()   -> { ok: true, counts } | { ok: false, reason, counts }
 *     .addPlace()      -> same
 *
 * Treated like the medals' file (host/medals.js): a count can't be recomputed, so an edit never writes over a file it could not read
 * (`unreadable`), a file from a NEWER version is shown but not edited (`newer-version`), every other key is written back verbatim, the
 * read-modify-write runs inside the store's cross-process lock (two windows can be open) and a failed write is reported. A count only
 * ever goes up. A MISSING file is a real "nothing yet" (0 and 0); a held or damaged one is unknown, and `read()` then answers the last
 * good set (null if there never was one).
 */

const STORE_KEY = 'ask-counts';
const VERSION = 1;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v);

/** { questions, places } for a parsed file, or null when it isn't a usable one. */
function countsOf(value) {
  if (!isObject(value) || !isCount(value.questions) || !isCount(value.places)) return null;
  return { questions: value.questions, places: value.places };
}

function createAskCounts({ store } = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.write !== 'function' || typeof store.withLock !== 'function') {
    throw new Error('createAskCounts: a store with readState, write and withLock is required');
  }
  let lastGood = null;

  /** { raw, counts, editable } for a readable file (a missing one is an empty, editable file), or { error }. */
  function load() {
    let state;
    try { state = store.readState(STORE_KEY); } catch { return { error: 'unreadable' }; }
    if (state.status === 'missing') return { raw: { version: VERSION, questions: 0, places: 0 }, counts: { questions: 0, places: 0 }, editable: true };
    if (state.status !== 'ok') return { error: 'unreadable' };
    const counts = countsOf(state.value);
    const v = state.value && state.value.version;
    if (!counts || (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 1))) return { error: 'unreadable' };
    return { raw: state.value, counts, editable: v === undefined || v <= VERSION };
  }

  function read() {
    const r = load();
    if (r.error) return lastGood;
    lastGood = r.counts;
    return lastGood;
  }

  function bump(field) {
    let result;
    try {
      result = store.withLock(STORE_KEY, () => {
        const r = load();
        if (r.error) return { ok: false, reason: r.error };
        if (!r.editable) return { ok: false, reason: 'newer-version' };
        const next = { ...r.raw, version: r.raw.version === undefined ? VERSION : r.raw.version, [field]: r.counts[field] + 1 };
        try { store.write(STORE_KEY, next); } catch { return { ok: false, reason: 'write-failed' }; }
        return { ok: true };
      });
    } catch { return { ok: false, reason: 'busy', counts: read() }; }
    return { ...result, counts: read() };
  }

  return { read, addQuestion: () => bump('questions'), addPlace: () => bump('places') };
}

module.exports = { createAskCounts, countsOf, STORE_KEY, VERSION };
