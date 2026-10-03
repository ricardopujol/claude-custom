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
 *   fileTargetText(answer), fileRefusedText(path, why): the same two lines
 *       for a local file path (#37): whether a click opens it or only shows
 *       it in Explorer, and why nothing opened.
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

// #37: a local path. `answer` is main's ({ action, isDir, name }); the words
// say what a click will do BEFORE it's done, above all when it won't open.
function fileTargetText(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.name !== 'string' || answer.name === '') return null;
  if (answer.action === 'open') {
    return cap(answer.isDir === true ? `Opens folder ${answer.name} in Explorer`
      : `Opens ${answer.name} in its default app`, TEXT_MAX);
  }
  if (answer.action === 'reveal') return cap(`Shows ${answer.name} in Explorer (it could run, so it isn't opened)`, TEXT_MAX);
  return null;
}

function fileRefusedText(p, why) {
  const shown = typeof p === 'string' && p !== '' ? p : 'that file';
  if (why === 'gone') return cap(`Not opened: ${shown} isn't there any more`, TEXT_MAX);
  if (why === 'refused') return cap(`Not opened: ${shown} (not a local path this tab can open)`, TEXT_MAX);
  if (typeof why === 'string' && why !== '') return cap(`Not opened: ${shown} (${why})`, TEXT_MAX);
  return cap(`Not opened: ${shown}`, TEXT_MAX);
}

const api = { shouldOpen, targetText, refusedText, fileTargetText, fileRefusedText, REPEAT_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.linkClick = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
