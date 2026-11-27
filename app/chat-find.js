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

// Every non-overlapping match of `query` in `text`, in document order, case-insensitive unless asked. ONE path for any text:
// the text is lower-cased character by character with a map back to its own offsets (lower-casing can change a length:
// "İ" gives two code units), so a character elsewhere never changes which matches are found. A match must start and end on a
// character's edge, never inside its lower-case form. Anything that isn't a non-empty string is no match.
function findMatches(text, query, { caseSensitive = false } = {}) {
  if (typeof text !== 'string' || typeof query !== 'string' || !text || !query) return [];
  const fold = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  let hay = '';
  const from = [];   // folded unit -> where its source character starts in `text`
  const to = [];     // folded unit -> where that character ends
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    const f = fold(text.slice(i, i + len));
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + len); }
    hay += f;
    i += len;
  }
  const needle = fold(query);
  if (!needle) return [];
  const out = [];
  for (let at = hay.indexOf(needle); at !== -1;) {
    const last = at + needle.length - 1;
    const onEdges = (at === 0 || from[at] !== from[at - 1]) && (last === hay.length - 1 || from[last + 1] !== from[last]);
    if (onEdges) { out.push({ start: from[at], end: to[last] }); at = hay.indexOf(needle, at + needle.length); } else at = hay.indexOf(needle, at + 1);
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
// An index past the end (the chat shrank) sits beyond the newest match: the next lower index is the last one, with nothing
// skipped, and the next higher one wraps round to the first.
function stepIndex({ index, count, shift = false, order } = {}) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (!Number.isInteger(index) || index < 0) return firstIndex(count, order);
  const lower = (orderOf(order) === 'bottom-up') ? !shift : shift;
  if (index >= count) return lower ? count - 1 : 0;
  return (index + (lower ? -1 : 1) + count) % count;
}

// Ctrl+F on keydown only (a held key repeats: the caller decides what a repeat does). By the key's letter, not its place on
// the board: on a Dvorak layout Ctrl+F is `key` 'f' on another `code`, and the `KeyF` place holds Ctrl+U (Dexter 6).
function isFindKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey
    && typeof e.key === 'string' && e.key.toLowerCase() === 'f';
}

const api = { DEFAULT_ORDER, findMatches, firstIndex, stepIndex, isFindKey };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatFind = api;

})(typeof window !== 'undefined' ? window : globalThis);
