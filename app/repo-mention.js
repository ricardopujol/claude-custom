'use strict';
/**
 * "@ in prompt" (#32): the text the reader types into the CLI's input box for a file or a line range.
 *
 *   mentionText(rel, range?) -> { ok: true, text } | { ok: false, reason }
 *       `@src/app.js`, `@src/app.js#L40-60`, `@src/app.js#L7`. `rel` is relative to the worktree; backslashes
 *       become forward slashes. `range` is { from, to } in 1-based lines (put the right way round), or
 *       null / undefined for the whole file. A range that is present but not two whole positive numbers is
 *       REFUSED, never typed as the whole file: the person asked for lines and would get more.
 *   rangeOfLines({ fromLine, toLine, empty, toCol0 }) -> { from, to } | null
 *       A selection (1-based lines) as a range. A bare cursor is no range; a selection that ends at column 0
 *       of a line doesn't include that line.
 *
 * What it refuses is what the CLI's `@` can't carry, said in words so the person can see why nothing was
 * typed: a space or tab in the path (the mention ends at it), a `#` (it would be read as the start of the
 * line range), a control character, an absolute path or one that climbs out with `..`.
 *
 * The typing itself is renderer.js's shared typeAndCheck (PR #93) through planTyping({ kind: 'mention' }):
 * it clears a one-line draft, refuses a dialog or a multi-line draft, reads the box back, and NEVER presses
 * Enter. This module only says WHAT to type.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoMention`.
 */
(function (root) {

const isLine = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 1;

function cleanPath(rel) {
  if (typeof rel !== 'string' || rel === '') return { reason: 'no file' };
  if (/[\u0000-\u001f\u007f]/.test(rel)) return { reason: 'a control character in the path' };
  const p = rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (/\s/.test(p)) return { reason: "the CLI's @ can't take a space or tab in a path" };
  if (p.includes('#')) return { reason: 'a # in the path would be read as the start of a line range' };
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
    return { reason: 'not a path inside the worktree' };
  }
  return { path: p };
}

function mentionText(rel, range) {
  const c = cleanPath(rel);
  if (c.reason) return { ok: false, reason: c.reason };
  if (range === undefined || range === null) return { ok: true, text: `@${c.path}` };
  if (typeof range !== 'object' || !isLine(range.from) || !isLine(range.to)) {
    return { ok: false, reason: 'not a valid line range' };
  }
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  return { ok: true, text: `@${c.path}#L${from}${to === from ? '' : `-${to}`}` };
}

function rangeOfLines(sel) {
  if (!sel || typeof sel !== 'object' || sel.empty !== false) return null;
  if (!isLine(sel.fromLine) || !isLine(sel.toLine)) return null;
  let to = sel.toLine;
  if (sel.toCol0 === true && to > sel.fromLine) to -= 1;
  return { from: sel.fromLine, to };
}

const API = { mentionText, rangeOfLines };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoMention = API;

})(typeof window !== 'undefined' ? window : globalThis);
