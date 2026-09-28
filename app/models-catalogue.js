'use strict';
/**
 * BACKLOG E #5 -- reconciling an incoming `models` reply with what the panel
 * already shows.
 *
 * Dexter, PR #60 review (round 1, Findings 1/4; round 2, N1/N2). The
 * renderer used to treat every `models` message as authoritative and simply
 * overwrite `catalogue` / `catalogueMeta` with whatever arrived. That is
 * exactly wrong for the sequences this feature's own extra asking (boot
 * warm-up, tab reopen, Refresh) creates: several requests can be in flight at
 * once, and their replies can arrive in EITHER order, or fail.
 *
 * ROUND 1 fixed the easy half with `fetchedAt` ordering: a reply with no rows
 * never blanks rows already shown, and an older reply never clobbers a
 * fresher one. ROUND 2 (N1/N2) found that `fetchedAt` is THE WRONG SIGNAL for
 * "is this reply older than what I'm holding": a FAILED reply that fell back
 * to a disk cache reports the CACHE's age, not the age of the request that
 * just ran -- so an offline Refresh with a real cache on disk looked
 * "older than the click" and left the button stuck on "Refreshing..."
 * forever (N1), and conversely an unrelated, genuinely OLDER request (the
 * boot warm-up, a stale tab-open still in flight) can still resolve or fail
 * AFTER a newer click was made, and nothing about its DATA says so (N2).
 *
 * THE FIX: `seq`. Every request app/renderer.js sends now carries a fresh,
 * strictly-increasing number; host.js's 'models' branch echoes it back
 * verbatim in the reply, unexamined. Once both sides of a comparison carry a
 * `seq`, that is the ONLY thing this module trusts for "older" -- exact
 * request/reply correlation, not a guess from the data's own timestamp. A
 * message without `seq` (an old shape, a hand-built test, a message from
 * something else that shares this channel) falls back to the round-1
 * `fetchedAt` heuristic, which is what the pre-`seq` tests in this module's
 * test file still pin.
 *
 * Pure: no DOM, no clock, no network. renderer.js owns generating `seq`,
 * calling this from the `'models'` message handler, and writing the result
 * to `catalogue` / `catalogueMeta`.
 *
 * WRAPPED IN AN IIFE for the trap this codebase has already paid for twice:
 * renderer.html loads these as plain <script> tags sharing ONE global scope
 * -- see test/renderer-scope.test.js.
 */
(function (root) {

/**
 * `state` is `{ rows, meta }` -- `rows` the array currently shown, `meta`
 * `{ source, fetchedAt, stale, error, seq }` or `null` before the first reply
 * ever arrives. `reply` is the raw `models` message.
 *
 * Returns the next `{ rows, meta }`. TOTAL: a garbage `state` or `reply`
 * degrades to sensible defaults rather than throwing, so a malformed message
 * cannot take the panel down.
 */
function mergeCatalogueReply(state, reply) {
  const prevRows = state && Array.isArray(state.rows) ? state.rows : [];
  const prevMeta = state && state.meta && typeof state.meta === 'object' ? state.meta : null;

  const replyRows = reply && Array.isArray(reply.models) ? reply.models : [];
  const replyMeta = {
    source: reply && reply.source,
    fetchedAt: reply && reply.fetchedAt,
    stale: !!(reply && reply.stale),
    error: (reply && reply.error) || null,
    seq: reply && reply.seq,
  };

  const replyFetchedAt = Number.isFinite(replyMeta.fetchedAt) ? replyMeta.fetchedAt : null;
  const prevFetchedAt = prevMeta && Number.isFinite(prevMeta.fetchedAt) ? prevMeta.fetchedAt : null;
  const replySeq = Number.isFinite(replyMeta.seq) ? replyMeta.seq : null;
  const prevSeq = prevMeta && Number.isFinite(prevMeta.seq) ? prevMeta.seq : null;

  // N2 (round 2): with a `seq` on BOTH sides, that is the whole answer to
  // "older" -- not `fetchedAt`, which for a FAILED reply is the age of a
  // fallback cache, unrelated to how old the REQUEST is. Without a `seq` on
  // one side (an older message shape), fall back to the round-1 `fetchedAt`
  // ordering.
  const haveSeq = replySeq !== null && prevSeq !== null;
  const isOlder = haveSeq
    ? replySeq < prevSeq
    : (prevFetchedAt !== null && replyFetchedAt !== null && replyFetchedAt < prevFetchedAt);

  // F1 + N2: a reply with NO rows must never blank out rows already on
  // screen. An OLDER one (by `seq` when known, else by `fetchedAt`) is a full
  // NO-OP: it answers a request that predates what is already shown, so it
  // is not evidence about the CURRENT data at all, and must not flip an
  // accurate, fresh banner to "stale" over a list it has nothing to do with.
  // A reply at least as new DOES update the banner -- always STALE, since
  // "nothing came back" for a CURRENT attempt is never grounds to call the
  // list current -- and keeps the error, so the reason reaches the user. The
  // rows' own provenance timestamp (`prevFetchedAt`) is kept too: it is still
  // true information about how old THOSE rows are.
  if (replyRows.length === 0 && prevRows.length > 0) {
    if (isOlder) return { rows: prevRows, meta: prevMeta };
    return {
      rows: prevRows,
      meta: {
        source: prevMeta ? prevMeta.source : replyMeta.source,
        fetchedAt: prevFetchedAt,
        stale: true,
        error: replyMeta.error,
        seq: prevSeq,
      },
    };
  }

  // F4: a reply strictly OLDER than what is already shown loses, whichever
  // request it happens to answer. Only reached with non-empty rows, or with
  // an empty state to begin with (nothing to protect), so this never blocks
  // the very first reply -- including the very first one being empty, which
  // is a real "could not reach OpenRouter" the user must still be told.
  if (isOlder) {
    return { rows: prevRows, meta: prevMeta };
  }

  return { rows: replyRows, meta: replyMeta };
}

/**
 * Should a still-outstanding Refresh click's `pending` flag clear on this
 * reply?
 *
 * `pendingSeq`: the `seq` app/renderer.js's Refresh click sent, or `null`/
 * not-a-number if nothing is pending (always clears, harmlessly, since the
 * caller only acts on this when `pending` is already true).
 */
function shouldClearPending(pendingSeq, reply) {
  if (typeof pendingSeq !== 'number' || !Number.isFinite(pendingSeq)) return true;

  const replySeq = reply && reply.seq;
  // N1/N2 (round 2): with an id to go on, that is ALL that matters, exactly
  // matched -- a different `seq` means a different request answered,
  // whatever the reply's own data looks like. This is what actually
  // distinguishes N1 (a FAILED forced reply, `stale`+`error`, but IS this
  // click's own answer) from N2 (an unrelated OLDER request's reply, which
  // can also be empty/stale, but is NOT this click's answer).
  if (Number.isFinite(replySeq)) return replySeq === pendingSeq;

  // No `seq` on this reply (an older message shape, or a hand-built test):
  // fall back to the round-1 data-shaped heuristic. Dexter, round 2, N1: a
  // FAILED forced request -- `stale: true` with a real `error` -- is a
  // definitive answer REGARDLESS of its `fetchedAt`, because a failure that
  // fell back to a disk cache reports the CACHE's age, not the age of the
  // attempt that just ran. Treating an old `fetchedAt` as "this must be some
  // other, older request" left the Refresh button stuck on "Refreshing..."
  // forever on the single most common failure path Refresh has: offline,
  // with a cache already on disk.
  const rows = reply && Array.isArray(reply.models) ? reply.models : [];
  if (rows.length === 0) return true;
  if (reply && reply.stale && reply.error) return true;
  const fetchedAt = reply && Number.isFinite(reply.fetchedAt) ? reply.fetchedAt : null;
  if (fetchedAt === null) return true;
  return fetchedAt >= pendingSeq;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeCatalogueReply, shouldClearPending };
} else {
  root.mergeCatalogueReply = mergeCatalogueReply;
  root.shouldClearPending = shouldClearPending;
}

})(typeof window !== 'undefined' ? window : globalThis);
