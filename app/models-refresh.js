'use strict';
/**
 * BACKLOG E #5, step 2 -- the OpenRouter catalogue's Refresh button.
 *
 * `host/openrouter.js` already has everything the FRESHNESS half of this
 * needs: `force` re-fetches even a live cache, and a failed refresh keeps the
 * last-known list marked `stale` rather than empty. What was missing was a UI
 * to reach `force`, and a way to stop a second click from firing a second
 * request while the first is still in flight (`renderer.js` already sends
 * `{type:'models', force}` over the open socket -- see `requestModels`).
 *
 * Pure decision only: given whether a refresh is in flight and what the last
 * catalogue answer said, what should the button say and can it be clicked
 * again right now? No DOM, no timer, no network -- renderer.js owns writing
 * this to the actual button and clearing `pending` when the `models` message
 * comes back.
 *
 * WRAPPED IN AN IIFE for the trap this codebase has already paid for twice:
 * renderer.html loads these as plain <script> tags sharing ONE global scope
 * -- see test/renderer-scope.test.js.
 */
(function (root) {

/**
 * `{ disabled, label, title }` for the Refresh button.
 *
 * `pending`: a request is in flight (the click that started it, until the
 * next `models` message clears it) -- disabled, so a slow network round trip
 * cannot be clicked twice into two outstanding requests.
 *
 * `catalogueMeta`: the last `{ source, fetchedAt, stale, error }` this panel
 * received (same shape `renderer.js`'s `catalogueMeta` already holds). Absent
 * (`null`, before the first answer ever arrives) reads as the plain case --
 * there is nothing yet to say is stale or fresh.
 */
function refreshButtonState({ pending, catalogueMeta } = {}) {
  if (pending) {
    return { disabled: true, label: 'Refreshing…', title: 'fetching the latest OpenRouter catalogue' };
  }
  const meta = catalogueMeta && typeof catalogueMeta === 'object' ? catalogueMeta : null;
  if (meta && meta.stale) {
    return {
      disabled: false, label: 'Refresh',
      title: 'prices may be out of date (' + (meta.error || 'offline') + ') — click to try again',
    };
  }
  return {
    disabled: false, label: 'Refresh',
    title: 'force a fresh fetch from OpenRouter, ignoring the cache',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { refreshButtonState };
} else {
  root.refreshButtonState = refreshButtonState;
}

})(typeof window !== 'undefined' ? window : globalThis);
