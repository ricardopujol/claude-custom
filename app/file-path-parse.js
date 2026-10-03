'use strict';
/**
 * Where a local file path sits in a line of terminal text (#37). It OFFERS
 * candidates; it never decides one exists -- main does (app/file-link.js).
 *
 *   findCandidates(text, breaks = [])
 *       -> [{ start, options: [{ end, path, line, col }] }]   sorted by start
 *       Each candidate is one place a path may start; its options are the
 *       places it may end, longest first. A path with spaces in prose has no
 *       reliable end, so every space, every row break (`breaks`, from
 *       app/terminal-rows.js) and every trailing-punctuation strip is offered,
 *       and main answers the first one that exists. `end` covers a `:line`,
 *       `:line:col` or `:line-line` suffix; `path` never includes it.
 *   pickLinks(candidates, answers) -> [{ start, end, answer }]
 *       answers[i] is main's answer for candidates[i] ({ option, ... }) or
 *       null. Earlier start wins an overlap.
 *
 * What is never offered: UNC (\\server\share), device (\\?\, \\.\), rooted
 * (\x) or drive-relative (C:x) paths, and anything inside a URL. Main refuses
 * them too; this keeps them from even being asked about.
 *
 * Relative paths are single tokens (no spaces): a separator plus a dotted last
 * segment (app/link-click.js), or a bare name with a :line (renderer.js:594).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `filePathParse`.
 */
(function (root) {

const MAX_PATH_LENGTH = 1024, MAX_OPTIONS = 8, MAX_CANDIDATES = 32;
// Not in a Windows name: < > : " | ? * and control chars; ` too (legal, but
// it's how markdown quotes a path).
const STOP = /[<>:"|?*`\u0000-\u001f\u007f]/;
const TRAILING = /[.,;!?)\]}'"]+$/;
const SUFFIX = /^:(\d{1,7})(?::(\d{1,7})|-\d{1,7})?(?![\w])/;
const ABS_START = /(?<![\w\\/:.])[A-Za-z]:[\\/](?=[^\\/\s<>:"|?*`])/g;
const REL_TOKEN = /(?<![\w\\/:.\-])(?:\.{1,2}[\\/])?[\w.\-]+(?:[\\/][\w.\-]+)*/g;

function suffixAt(text, i) {
  const m = SUFFIX.exec(text.slice(i, i + 24));
  if (!m) return null;
  return { len: m[0].length, line: Number(m[1]), col: m[2] === undefined ? null : Number(m[2]) };
}

// Endings `ends` (exclusive offsets) -> options, longest first, de-duplicated,
// each also offered with trailing punctuation stripped. `runEnd` is where a
// :line suffix may follow.
function toOptions(text, start, ends, runEnd) {
  const seen = new Set();
  const out = [];
  const add = (e) => {
    const p = text.slice(start, e);
    if (p.length < 4 && /^[A-Za-z]:[\\/]/.test(p)) return;       // a bare drive
    if (e <= start || p.length > MAX_PATH_LENGTH || seen.has(e)) return;
    seen.add(e);
    out.push(e);
  };
  for (const raw of ends) {
    const e = start + text.slice(start, raw).trimEnd().length;
    add(e);
    add(start + text.slice(start, e).replace(TRAILING, '').length);
  }
  out.sort((a, b) => b - a);
  return out.slice(0, MAX_OPTIONS).map((e) => {
    const sfx = e === runEnd ? suffixAt(text, e) : null;
    return { end: sfx ? e + sfx.len : e, path: text.slice(start, e),
      line: sfx ? sfx.line : null, col: sfx ? sfx.col : null };
  });
}

function absoluteAt(text, start, breaks) {
  let j = start + 3;
  while (j < text.length && j - start <= MAX_PATH_LENGTH && !STOP.test(text[j])) j++;
  const ends = [j];
  for (let k = start + 3; k < j; k++) if (text[k] === ' ') ends.push(k);
  for (const b of breaks) if (b > start + 3 && b < j) ends.push(b);
  return toOptions(text, start, ends, j);
}

function relativeAt(text, start, token, breaks) {
  const end = start + token.length;
  const bare = token.replace(TRAILING, '');
  const hasSuffix = bare.length === token.length && suffixAt(text, end) !== null;
  const segs = bare.split(/[\\/]/);
  const last = segs[segs.length - 1];
  const dotted = /[^.]\.[A-Za-z0-9]|^\.[A-Za-z0-9]/.test(last);
  if (!(hasSuffix && dotted) && !(segs.length > 1 && dotted)) return [];
  const ends = [end];
  for (const b of breaks) if (b > start && b < end) ends.push(b);
  return toOptions(text, start, ends, end);
}

function findCandidates(text, breaks = []) {
  if (typeof text !== 'string' || text === '') return [];
  const bs = Array.isArray(breaks) ? breaks.filter(b => Number.isInteger(b)) : [];
  const out = [];
  for (const m of text.matchAll(ABS_START)) {
    const options = absoluteAt(text, m.index, bs);
    if (options.length) out.push({ start: m.index, options });
  }
  for (const m of text.matchAll(REL_TOKEN)) {
    // A token inside a URL (scheme://host/...) is never a local path.
    if (/[a-z][\w+.-]*:\/\/\S*$/i.test(text.slice(0, m.index))) continue;
    const options = relativeAt(text, m.index, m[0], bs);
    if (options.length) out.push({ start: m.index, options });
  }
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_CANDIDATES);
}

function pickLinks(candidates, answers) {
  if (!Array.isArray(candidates) || !Array.isArray(answers)) return [];
  const out = [];
  let taken = -1;
  candidates.forEach((c, i) => {
    const a = answers[i];
    if (!a || typeof a !== 'object' || !Number.isInteger(a.option)) return;
    const o = c && Array.isArray(c.options) ? c.options[a.option] : null;
    if (!o || c.start < taken) return;
    out.push({ start: c.start, end: o.end, answer: a });
    taken = o.end;
  });
  return out;
}

const api = { findCandidates, pickLinks, MAX_PATH_LENGTH };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.filePathParse = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
