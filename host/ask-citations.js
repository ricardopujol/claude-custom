'use strict';
/**
 * Checking the citations in a local model's answer (BACKLOG #33, DESIGN_ASK_REPO.md: "every answer cites file:line").
 *
 *   extractCitations(text, files) -> { citations: [{ file, line, endLine }], dropped: ['file:line', ...] }
 *
 * `files` is a Map of repo-relative path (forward slashes) -> line count, taken from the index. A 3B-7B model invents
 * paths and line numbers now and then; a clickable link to a file that is not there, or to line 4000 of a 90-line file,
 * is worse than no link. So only a citation whose file is in the index and whose line is inside it is returned (the end
 * of a range is clamped to the file); a bare name with no folder (`host.js:12`, a habit of small models) is resolved only when exactly
 * one indexed file has that name; everything else is listed in `dropped` so the panel can say the model cited
 * something that does not exist. Property-tested in test/ask-citations.test.js.
 */

// path-ish token, a dot-extension, then :line or :line-line. The lookbehind keeps it off the middle of a longer word.
const CITE = /(?<![\w./\\@-])((?:\.{0,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z0-9]{1,8}):(\d{1,7})(?:\s?[-–]\s?(\d{1,7}))?/g;

function normalisePath(p) {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

function extractCitations(text, files) {
  const citations = [];
  const dropped = [];
  if (typeof text !== 'string' || !(files instanceof Map)) return { citations, dropped };
  const seen = new Set();
  const byName = new Map(); // bare file name -> the one indexed path with it, or null when two share it
  for (const f of files.keys()) {
    const name = f.slice(f.lastIndexOf('/') + 1);
    byName.set(name, byName.has(name) ? null : f);
  }
  for (const m of text.matchAll(CITE)) {
    let file = normalisePath(m[1]);
    if (!files.has(file) && !file.includes('/') && byName.get(file)) file = byName.get(file);
    const total = files.get(file);
    let a = Number(m[2]);
    let b = m[3] === undefined ? a : Number(m[3]);
    if (b < a) [a, b] = [b, a];
    if (typeof total !== 'number' || a < 1 || a > total) {
      const shown = `${m[1]}:${m[2]}${m[3] === undefined ? '' : '-' + m[3]}`;
      if (!dropped.includes(shown)) dropped.push(shown);
      continue;
    }
    const endLine = Math.min(b, total);
    const key = `${file}:${a}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ file, line: a, endLine });
  }
  return { citations, dropped };
}

module.exports = { extractCitations };
