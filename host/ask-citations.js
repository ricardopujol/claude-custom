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
 *
 * `ranges` (optional, Map of file -> [[start, end], ...]) is what the model was actually SHOWN. With it, a citation must also
 * land inside a sent range, and a range is clamped to the one it starts in: a real file at a line the model never saw (the prompt's
 * own example parroted back, a guess) is dropped, not shown as verified (PR #136 Dexter D4).
 */

// path-ish token, a dot-extension, then :line or :line-line. The lookbehind keeps it off the middle of a longer word.
const CITE = /(?<![\w./\\@-])((?:\.{0,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z0-9]{1,8}):(\d{1,7})(?:\s?[-–]\s?(\d{1,7}))?/g;

function normalisePath(p) {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

const escapeRe = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `path:line[-line]` in the text, in order. Paths with a space are matched whole from the index's own names first. */
function candidates(text, files) {
  const out = [];
  let rest = text;
  const spaced = [...files.keys()].filter(f => f.includes(' ')).map(escapeRe);
  if (spaced.length) {
    const re = new RegExp('(?<![\\w./\\\\@-])(' + spaced.join('|') + '):(\\d{1,7})(?:\\s?[-–]\\s?(\\d{1,7}))?', 'g');
    rest = rest.replace(re, (all, f, a, b, at) => { out.push({ at, raw: f, a, b, whole: true }); return ' '.repeat(all.length); });
  }
  for (const m of rest.matchAll(CITE)) {
    // A bare name right after a space that follows a folder-ish word (`docs/other notes.md`) is the tail of a path that was cut
    // at its space: it names no file we can vouch for (PR #136 D6).
    const before = rest.slice(0, m.index);
    const cutPath = /[\\/][^\s\\/]*\s$/.test(before) && !/[\\/]/.test(m[1]);
    out.push({ at: m.index, raw: m[1], a: m[2], b: m[3], cutPath });
  }
  return out.sort((x, y) => x.at - y.at);
}

function extractCitations(text, files, { ranges } = {}) {
  const citations = [];
  const dropped = [];
  if (typeof text !== 'string' || !(files instanceof Map)) return { citations, dropped };
  const seen = new Set();
  const byName = new Map(); // bare file name -> the one indexed path with it, or null when two share it
  for (const f of files.keys()) {
    const name = f.slice(f.lastIndexOf('/') + 1);
    byName.set(name, byName.has(name) ? null : f);
  }
  for (const c of candidates(text, files)) {
    let file = normalisePath(c.raw);
    if (!files.has(file) && !file.includes('/') && !c.cutPath && byName.get(file)) file = byName.get(file);
    const total = files.get(file);
    let a = Number(c.a);
    let b = c.b === undefined ? a : Number(c.b);
    if (b < a) [a, b] = [b, a];
    let end = typeof total === 'number' ? Math.min(b, total) : 0;
    let ok = typeof total === 'number' && !c.cutPath && a >= 1 && a <= total;
    if (ok && ranges) {
      // Inside what the model was shown, and no further than the excerpt it starts in.
      const hit = (ranges.get(file) || []).find(([s, e]) => a >= s && a <= e);
      if (hit) end = Math.min(end, hit[1]); else ok = false;
    }
    if (!ok) {
      const shown = `${c.raw}:${c.a}${c.b === undefined ? '' : '-' + c.b}`;
      if (!dropped.includes(shown)) dropped.push(shown);
      continue;
    }
    const key = `${file}:${a}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ file, line: a, endLine: end });
  }
  return { citations, dropped };
}

module.exports = { extractCitations };
