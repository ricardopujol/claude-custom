'use strict';
/**
 * BACKLOG E #5 -- reconciling an incoming `models` reply with what the panel
 * already shows.
 *
 * Dexter, PR #60 review, Findings 1 and 4. The renderer used to treat every
 * `models` message as authoritative and simply overwrite `catalogue` /
 * `catalogueMeta` with whatever arrived (app/renderer.js, old line 2544).
 * That is exactly wrong for two real sequences this feature now creates on
 * purpose by asking more often (the boot warm-up, a tab reopen, and a
 * Refresh click can all have a request in flight at once):
 *
 *   F1: a forced refresh fails with no usable disk cache (the cache was never
 *       written, or a Windows rename lost the race -- host/openrouter.js's
 *       own header documents this exact failure). The reply is
 *       `{models: [], source: 'none', stale: true}`. Applied naively, 445
 *       on-screen rows the user was just looking at vanish into an empty
 *       "could not reach OpenRouter" panel -- the ONE thing this whole
 *       feature exists to prevent, just moved from the disk cache (which
 *       already gets this right) into the renderer (which didn't).
 *
 *   F4: two requests can be in flight at once (a tab-open's non-forced ask
 *       and a Refresh's forced one, or the boot warm-up and either of those),
 *       and their replies can arrive in EITHER order. Whichever lands LAST
 *       wins today, so a slow, stale answer can clobber a fresh one that
 *       already rendered.
 *
 * THE RULE, both findings at once: a reply only replaces what is shown if it
 * is not older than it (`fetchedAt` ordering), and a reply with NO rows never
 * blanks out rows already on screen -- it only updates the staleness banner,
 * because "no answer" is never evidence that the list is actually empty.
 *
 * Pure: no DOM, no clock, no network. renderer.js owns calling this from the
 * `'models'` message handler and writing the result to `catalogue` /
 * `catalogueMeta`.
 *
 * WRAPPED IN AN IIFE for the trap this codebase has already paid for twice:
 * renderer.html loads these as plain <script> tags sharing ONE global scope
 * -- see test/renderer-scope.test.js.
 */
(function (root) {

/**
 * `state` is `{ rows, meta }` -- `rows` the array currently shown, `meta`
 * `{ source, fetchedAt, stale, error }` or `null` before the first reply ever
 * arrives. `reply` is the raw `models` message (`{ models, source, fetchedAt,
 * stale, error }`).
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
  };

  const replyFetchedAt = Number.isFinite(replyMeta.fetchedAt) ? replyMeta.fetchedAt : null;
  const prevFetchedAt = prevMeta && Number.isFinite(prevMeta.fetchedAt) ? prevMeta.fetchedAt : null;

  // F1: a reply with NO rows must never blank out rows already on screen. It
  // still updates the banner -- always STALE, since "nothing came back" is
  // never grounds to call the list current -- and keeps the error the reply
  // gave, so the reason reaches the user. The rows' own provenance timestamp
  // (`prevFetchedAt`) is kept too: it is still true information about how old
  // THOSE rows are, and a failed refresh does not change that.
  if (replyRows.length === 0 && prevRows.length > 0) {
    return {
      rows: prevRows,
      meta: {
        source: prevMeta ? prevMeta.source : replyMeta.source,
        fetchedAt: prevFetchedAt,
        stale: true,
        error: replyMeta.error,
      },
    };
  }

  // F4: a reply strictly OLDER than what is already shown loses, whichever
  // request it happens to answer. Only reached with non-empty rows, or with
  // an empty state to begin with (nothing to protect), so this never blocks
  // the very first reply -- including the very first one being empty, which
  // is a real "could not reach OpenRouter" the user must still be told.
  if (prevFetchedAt !== null && replyFetchedAt !== null && replyFetchedAt < prevFetchedAt) {
    return { rows: prevRows, meta: prevMeta };
  }

  return { rows: replyRows, meta: replyMeta };
}

/**
 * Should a still-outstanding Refresh click's `pending` flag clear on this
 * reply? Dexter, Finding 4 (second half): `pending` used to clear on ANY
 * `models` message, so an unrelated, older, already-in-flight request's
 * answer landing before the forced one re-enabled the button while the
 * forced fetch was still running -- a second click then started a THIRD
 * concurrent request, exactly what the pending flag exists to prevent.
 *
 * No wire-protocol change (no request ids) needed: a definitive failure
 * (empty rows) always resolves whatever attempt is outstanding, and a
 * successful reply resolves it only if its `fetchedAt` is not older than the
 * moment the click fired -- a reply from a request that started BEFORE the
 * click cannot be that click's answer.
 *
 * `requestedAt`: `Date.now()` at the moment Refresh was clicked, or `null`/
 * not-a-number if nothing is pending (always clears, harmlessly, since the
 * caller only acts on this when `pending` is already true).
 */
function shouldClearPending(requestedAt, reply) {
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return true;
  const rows = reply && Array.isArray(reply.models) ? reply.models : [];
  if (rows.length === 0) return true;
  const fetchedAt = reply && Number.isFinite(reply.fetchedAt) ? reply.fetchedAt : null;
  if (fetchedAt === null) return true;
  return fetchedAt >= requestedAt;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeCatalogueReply, shouldClearPending };
} else {
  root.mergeCatalogueReply = mergeCatalogueReply;
  root.shouldClearPending = shouldClearPending;
}

})(typeof window !== 'undefined' ? window : globalThis);
