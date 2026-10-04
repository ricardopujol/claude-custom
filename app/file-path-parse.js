'use strict';
/**
 * Where a local file path sits in a line of terminal text (#37). It OFFERS
 * candidates; it never decides one exists -- main does (app/file-link.js).
 *
 *   findCandidates(text, breaks = [], { within: [from, to) } = {})
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

// 16 endings: a folder followed by a list of file names can have 8 endings with
// an extension ahead of its real one (PR #92 Dexter r2 N1).
const MAX_PATH_LENGTH = 1024, MAX_OPTIONS = 16, MAX_CANDIDATES = 32;
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

// Which endings to keep when there are more than MAX_OPTIONS (PR #92 Dexter
// F1: keeping the LONGEST dropped a real `C:\proj\notes.md` followed by a long
// sentence). A path ends where its last segment does, so: endings whose last
// segment has an extension first, then the fewest spaces in the last segment,
// then the longest. The kept ones are then offered longest first, because main
// answers the first that exists and the longest real reading is the right one.
const lastSegment = (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
const HAS_EXT = /[^.]\.[A-Za-z0-9]{1,10}$/;
function keepOrder(a, b) {
  // The run's own end (where a backtick, quote, `:line` or the text stopped
  // it) is the strongest boundary there is: always kept.
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const sa = lastSegment(a.path), sb = lastSegment(b.path);
  const ea = HAS_EXT.test(sa) ? 0 : 1, eb = HAS_EXT.test(sb) ? 0 : 1;
  if (ea !== eb) return ea - eb;
  const spaces = (s) => s.split(' ').length - 1;
  if (spaces(sa) !== spaces(sb)) return spaces(sa) - spaces(sb);
  return b.path.length - a.path.length;
}

// Endings `ends` (exclusive offsets) -> options, de-duplicated, each also
// offered with trailing punctuation stripped. `runEnd` is where a :line suffix
// may follow. `glued`: row breaks where two rows met with NOTHING between (a
// full row); Ink may have dropped a space there, so each ending past one is
// also offered with that space put back (PR #92 Dexter F5).
function toOptions(text, start, ends, runEnd, glued = []) {
  const seen = new Set();
  const all = [];
  // A path keeps one separator style; prose after `C:\x\a.md` that names
  // `src/b.js` is not part of it (Dexter r2 N1).
  const mixed = (p) => {
    const sp = p.indexOf(' ');
    if (sp === -1) return false;
    const own = /[\\/]/.exec(p.slice(2));
    const other = own && own[0] === '\\' ? '/' : '\\';
    return !!own && p.slice(sp).includes(other);
  };
  const add = (e, p, pinned = false) => {
    if (p.length < 4 && /^[A-Za-z]:[\\/]/.test(p)) return;       // a bare drive
    if (mixed(p)) return;
    if (e <= start || p.length > MAX_PATH_LENGTH || seen.has(p)) return;
    seen.add(p);
    all.push({ e, path: p, pinned });
  };
  const plain = [];
  for (const raw of ends) {
    const e = start + text.slice(start, raw).trimEnd().length;
    plain.push(e, start + text.slice(start, e).replace(TRAILING, '').length);
  }
  // ends[0] is the run's end: it and its stripped form are pinned.
  plain.forEach((e, i) => add(e, text.slice(start, e), i < 2));
  for (const g of glued) {
    for (const e of plain) if (e > g) add(e, `${text.slice(start, g)} ${text.slice(g, e)}`);
  }
  return all.sort(keepOrder).slice(0, MAX_OPTIONS)
    .sort((a, b) => b.path.length - a.path.length)
    .map(({ e, path }) => {
      const sfx = e === runEnd ? suffixAt(text, e) : null;
      return { end: sfx ? e + sfx.len : e, path, line: sfx ? sfx.line : null, col: sfx ? sfx.col : null };
    });
}

// -> { options, runEnd }: runEnd is how far the path's characters reach.
function absoluteAt(text, start, breaks) {
  let j = start + 3;
  while (j < text.length && j - start <= MAX_PATH_LENGTH && !STOP.test(text[j])) j++;
  const ends = [j];
  for (let k = start + 3; k < j; k++) if (text[k] === ' ') ends.push(k);
  const inside = breaks.filter(b => b > start + 3 && b < j);
  ends.push(...inside);
  const glued = inside.filter(b => text[b] !== ' ');
  return { options: toOptions(text, start, ends, j, glued), runEnd: j };
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

// Where URLs (scheme://...) sit, found in ONE linear pass: a token inside one
// is never a local path. (A regex anchored at each token's start re-scanned
// everything before it: quadratic, PR #92 Miguel I4.)
function urlSpans(text) {
  const spans = [];
  for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 3)) {
    let s = at;
    while (s > 0 && /[\w+.-]/.test(text[s - 1])) s--;
    if (s === at || !/[a-z]/i.test(text[s])) continue;
    let e = at + 3;
    while (e < text.length && !/\s/.test(text[e])) e++;
    spans.push([s, e]);
  }
  return spans;
}

const REL_AT = /^(?:\.{1,2}[\\/])?[\w.\-]+(?:[\\/][\w.\-]+)*/;
const ABS_AT = /^[A-Za-z]:[\\/][^\\/\s<>:"|?*`]/;

// `within: [from, to)`: keep only candidates that touch that span of text
// (the hovered row) BEFORE the cap, so a dense block can't push the hovered
// row's paths past it (PR #92 Miguel I2).
function findCandidates(text, breaks = [], { within } = {}) {
  if (typeof text !== 'string' || text === '') return [];
  const bs = Array.isArray(breaks) ? breaks.filter(b => Number.isInteger(b) && b >= 0 && b < text.length) : [];
  const urls = urlSpans(text);
  const inUrl = (i) => urls.some(([s, e]) => i >= s && i < e);
  const out = [];
  const starts = new Set();
  const add = (start, options) => {
    if (options.length && !starts.has(start)) { starts.add(start); out.push({ start, options }); }
  };
  // Where absolute paths' characters run: a relative path never starts inside
  // one (PR #92 Dexter F4: the second row of a broken `...\dev\` +
  // `app\file-link.js` resolved against the tab and opened ITS file).
  const runs = [];
  const absolute = (at) => {
    if (inUrl(at)) return;                                   // Dexter F7
    const { options, runEnd } = absoluteAt(text, at, bs);
    runs.push([at, runEnd]);
    add(at, options);
  };
  for (const m of text.matchAll(ABS_START)) absolute(m.index);
  // Two rows that met with nothing between glue the second row's path onto
  // the first row's last word, where no start would be seen (Miguel S6).
  for (const b of bs) if (ABS_AT.test(text.slice(b, b + 4))) absolute(b);
  // Inside means inside the path itself: the run's text up to the break has no
  // space in its last segment. A run that went on into prose (spaces after the
  // file name) doesn't swallow a glued relative path there (Dexter r2 N3).
  const inAbsolute = (i) => runs.some(([s, e]) => i > s && i < e && !lastSegment(text.slice(s, i)).includes(' '));
  for (const m of text.matchAll(REL_TOKEN)) {
    if (!inUrl(m.index)) add(m.index, relativeAt(text, m.index, m[0], bs));
  }
  for (const b of bs) {
    if (inUrl(b) || inAbsolute(b)) continue;
    const m = REL_AT.exec(text.slice(b, b + MAX_PATH_LENGTH + 32));
    if (m) add(b, relativeAt(text, b, m[0], bs));
  }
  out.sort((a, b) => a.start - b.start);
  const span = Array.isArray(within) && within.length === 2 && within.every(Number.isInteger) ? within : null;
  const reach = (c) => Math.max(...c.options.map(o => o.end));
  const touching = span ? out.filter(c => c.start < span[1] && reach(c) > span[0]) : out;
  return touching.slice(0, MAX_CANDIDATES);
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

// The caps are main's too (app/file-link.js reads them from here), so the page
// never offers more than main will look at (PR #92 Miguel S1).
const api = { findCandidates, pickLinks, MAX_PATH_LENGTH, MAX_OPTIONS, MAX_CANDIDATES };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.filePathParse = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
