'use strict';
/**
 * The rows one long path spans, as one string (#37).
 *
 *   block(getRow, y, cols, { maxRows = 8 }) -> { text, cellAt, breaks }
 *       getRow(y) -> { cells: [{ chars, width }] } | null   (y: 0-based buffer row)
 *       text    the logical block containing row y, rows joined
 *       cellAt  for each UTF-16 index of text: { y, x } (0-based), or null for a
 *               virtual space that isn't on screen
 *       breaks  offsets in text where two rows met: extra places a path may end
 *               (app/file-path-parse.js)
 *
 * MEASURED, not assumed (verify/probe-file-link-rows.js, 2026-10-02): Claude
 * Code draws through Ink, which breaks rows ITSELF. xterm's isWrapped is noise
 * there (true on a row that starts a new block), so it is not read at all.
 *   - A row continues the one above when both are non-blank, it has no marker,
 *     and its indent equals the text start above (indent + marker + spaces:
 *     2 after "● ", 5 after "  ⎿  ").
 *   - A full row (last non-blank at x >= cols - 2) was broken mid-word: joined
 *     with nothing between. Otherwise Ink broke at a space and dropped it: one
 *     virtual space goes between. Every join is a break, so a wrong guess costs
 *     an extra candidate ending, never a wrong link.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `terminalRows`.
 */
(function (root) {

const MARKER = /^(?:[●⎿❯!*•-]|\d{1,3}\.) +/;

// One buffer row -> its text, the cell x of each UTF-16 unit, and its shape.
function readRow(getRow, y, cols) {
  const row = getRow(y);
  if (!row || !Array.isArray(row.cells)) return null;
  let text = '';
  const xs = [];
  const widths = [];
  const n = Math.min(row.cells.length, cols);
  for (let x = 0; x < n; x++) {
    const c = row.cells[x] || {};
    if (c.width === 0) continue;                 // the tail of a wide char
    const chars = typeof c.chars === 'string' && c.chars !== '' ? c.chars : ' ';
    for (let i = 0; i < chars.length; i++) { xs.push(x); widths.push(c.width === 2 ? 2 : 1); }
    text += chars;
  }
  const end = text.replace(/\s+$/, '').length;   // exclusive: last non-blank + 1
  if (end === 0) return { blank: true };
  const indent = text.length - text.trimStart().length;
  const m = MARKER.exec(text.slice(indent));
  const startIdx = indent + (m ? m[0].length : 0);
  return {
    blank: false, text, xs, end, indent,
    indentX: xs[indent], marker: !!m,
    textStartX: startIdx < xs.length ? xs[startIdx] : cols,
    full: xs[end - 1] + widths[end - 1] - 1 >= cols - 2,
  };
}

const continues = (upper, lower) => !!upper && !!lower && !upper.blank && !lower.blank
  && !lower.marker && lower.indentX === upper.textStartX;

function block(getRow, y, cols, { maxRows = 8 } = {}) {
  const empty = { text: '', cellAt: [], breaks: [] };
  if (typeof getRow !== 'function' || !Number.isInteger(y) || !Number.isInteger(cols) || cols < 1) return empty;
  const rows = new Map();
  const at = (r) => {
    if (!rows.has(r)) rows.set(r, r < 0 ? null : readRow(getRow, r, cols));
    return rows.get(r);
  };
  const first = at(y);
  if (!first || first.blank) return empty;

  let top = y, bottom = y;
  while (top > y - maxRows && continues(at(top - 1), at(top))) top--;
  while (bottom < y + maxRows && continues(at(bottom), at(bottom + 1))) bottom++;

  let text = '';
  const cellAt = [];
  const breaks = [];
  for (let r = top; r <= bottom; r++) {
    const row = at(r);
    if (r > top) {
      breaks.push(text.length);
      if (!at(r - 1).full) { text += ' '; cellAt.push(null); }
    }
    const from = r === top ? 0 : row.indent;
    text += row.text.slice(from, row.end);
    for (let i = from; i < row.end; i++) cellAt.push({ y: r, x: row.xs[i] });
  }
  return { text, cellAt, breaks };
}

const api = { block };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.terminalRows = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
