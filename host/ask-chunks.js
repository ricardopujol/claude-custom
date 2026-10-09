'use strict';
/**
 * Splitting a file into chunks for the "ask the repo" index (BACKLOG #33, DESIGN_ASK_REPO.md).
 *
 *   chunkFile(file, text, { maxLines, maxChars, overlap }) -> [{ file, start, end, ownStart, text }]
 *
 * `start`/`end` are 1-based, inclusive line numbers; `text` is exactly those lines joined with "\n". Settings are the
 * ones measured on 2026-10-03 (60 lines / 1500 chars / 10 lines of overlap; the char cap binds first on real source).
 *
 * TWO GUARANTEES, both pinned by test/ask-chunks.test.js as properties:
 *   - every line of the file is inside at least one chunk (retrieval can never be blind to a line), and
 *   - every line is OWNED by exactly one chunk: `ownStart` is the first line the previous chunk did not already cover,
 *     so [ownStart, end] ranges tile the file with no gap and no double count. The overlap exists only so a function cut
 *     at a boundary is whole in at least one chunk.
 *
 * A single line longer than the char cap is its own chunk, whole: line numbers are what citations are made of, so a
 * line is never split.
 */

const DEFAULTS = Object.freeze({ maxLines: 60, maxChars: 1500, overlap: 10 });

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // the final newline ends the last line, it does not start one
  return lines;
}

function chunkFile(file, text, opts = {}) {
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULTS.maxLines));
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const overlap = Math.max(0, Math.floor(opts.overlap ?? DEFAULTS.overlap));
  const lines = splitLines(String(text));
  const n = lines.length;
  const chunks = [];

  // The last line index (0-based, inclusive) a chunk starting at `from` can reach.
  const reach = (from) => {
    let chars = lines[from].length;
    let to = from;
    while (to + 1 < n && to + 1 - from < maxLines && chars + 1 + lines[to + 1].length <= maxChars) {
      to++;
      chars += 1 + lines[to].length;
    }
    return to;
  };

  let prevEnd = -1;   // 0-based index of the last line already covered
  let prevStart = -1;
  while (prevEnd < n - 1) {
    let from = prevEnd < 0 ? 0 : Math.max(prevStart + 1, prevEnd - overlap + 1);
    let to = reach(from);
    // The overlap alone filled the caps: nothing new would be covered. Start clean after the last covered line.
    if (to <= prevEnd) { from = prevEnd + 1; to = reach(from); }
    chunks.push({
      file, start: from + 1, end: to + 1, ownStart: prevEnd + 2, text: lines.slice(from, to + 1).join('\n'),
    });
    prevStart = from;
    prevEnd = to;
  }
  return chunks;
}

module.exports = { chunkFile, splitLines, DEFAULTS };
