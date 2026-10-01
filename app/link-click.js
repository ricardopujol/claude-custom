'use strict';
/**
 * A link clicked in the terminal (fix/terminal-links): which clicks open it,
 * and what the line under the pointer says about it.
 *
 *   shouldOpen(event, uri, last, now) -> { open, last }
 *       Only a plain left click opens a link, once. xterm 5.5's Linkifier
 *       calls the link handler on EVERY mouseup over a link, whatever the
 *       button and however many clicks (PR #81 Dexter F2): a double-click
 *       opened two browser tabs and a right-click opened one. `last` is the
 *       link opened last ({ uri, at }); the same one again within REPEAT_MS
 *       is a repeat, not a new click.
 *   targetText(uri)  -> 'Opens <the real address>' for the hover line, or null.
 *       Shown before the click (Ricardo, 2026-10-01): a link's visible text
 *       can differ from where it goes, and nothing else shows the target now
 *       that the confirm() is gone (PR #81 Dexter F1, Miguel #2).
 *   refusedText(uri) -> the words when main refused to open it (Dexter F5).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `linkClick`.
 */
(function (root) {

const REPEAT_MS = 1000;
const TEXT_MAX = 300;

const cap = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function shouldOpen(event, uri, last, now) {
  const keep = { open: false, last: last || null };
  if (!event || typeof event !== 'object' || event.button !== 0) return keep;
  if (typeof event.detail === 'number' && event.detail > 1) return keep;
  if (typeof uri !== 'string' || uri === '') return keep;
  if (last && last.uri === uri && now - last.at < REPEAT_MS) return keep;
  return { open: true, last: { uri, at: now } };
}

function targetText(uri) {
  if (typeof uri !== 'string' || uri === '') return null;
  return cap(`Opens ${uri}`, TEXT_MAX);
}

function refusedText(uri) {
  const shown = typeof uri === 'string' && uri !== '' ? cap(uri, TEXT_MAX) : 'that link';
  return `Not opened: ${shown} (only plain http and https links open in the browser)`;
}

const api = { shouldOpen, targetText, refusedText, REPEAT_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.linkClick = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
