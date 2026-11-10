'use strict';
/**
 * The chat view's find, as pure rules (BACKLOG #203). Ctrl+F searches from the BOTTOM up: the newest match first, Enter goes
 * up to an older one, Shift+Enter down to a newer one. The order is an option ('bottom-up', the default, or 'top-down', which
 * reverses the keys), so the old order stays one word away.
 *
 * The chat view had no find of its own when this was written (it is a DOM view; Electron has no find menu here and the
 * code never calls findInPage), so this is the rule set a find bar plugs into: matches in document order, which one is
 * current, and where Enter / Shift+Enter move it. No DOM here. Wrapped in an IIFE like the other plain-script modules
 * (they share one global scope).
 */
(function (root) {

const DEFAULT_ORDER = 'bottom-up';
const orderOf = (order) => (order === 'top-down' ? 'top-down' : DEFAULT_ORDER);

// Every non-overlapping match of `query` in `text`, in document order. Anything that isn't a non-empty string is no match.
function findMatches(text, query, { caseSensitive = false } = {}) {
  if (typeof text !== 'string' || typeof query !== 'string' || !text || !query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (hay.length !== text.length) return findMatchesSlow(text, query, caseSensitive);   // a case change that moved offsets
  const out = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) out.push({ start: at, end: at + needle.length });
  return out;
}
// Lowercasing can change a string's length ('İ' becomes two code units): compare window by window instead, so offsets stay the text's own.
function findMatchesSlow(text, query, caseSensitive) {
  const fold = (s) => (caseSensitive ? s : s.toLowerCase());
  const want = fold(query);
  const out = [];
  for (let at = 0; at + query.length <= text.length;) {
    if (fold(text.slice(at, at + query.length)) === want) { out.push({ start: at, end: at + query.length }); at += query.length; } else at += 1;
  }
  return out;
}

// The match a fresh search lands on: the last for bottom-up, the first for top-down, -1 with nothing found.
function firstIndex(count, order) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  return orderOf(order) === 'top-down' ? 0 : count - 1;
}

// Where Enter (shift false) or Shift+Enter (shift true) moves from `index`, wrapping round. Bottom-up: Enter goes to an older
// match (a lower index), Shift+Enter to a newer one. Top-down is the reverse. No current match (-1) starts at firstIndex.
function stepIndex({ index, count, shift = false, order } = {}) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (!Number.isInteger(index) || index < 0) return firstIndex(count, order);
  const here = Math.min(index, count - 1);   // the chat shrank under the old index
  const older = orderOf(order) === 'bottom-up';
  const delta = (older ? !shift : shift) ? -1 : 1;
  return (here + delta + count) % count;
}

// Ctrl+F on keydown only (a held key repeats: the caller decides what a repeat does).
function isFindKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyF';
}

const api = { DEFAULT_ORDER, findMatches, firstIndex, stepIndex, isFindKey };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatFind = api;

})(typeof window !== 'undefined' ? window : globalThis);
