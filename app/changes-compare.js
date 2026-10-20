'use strict';
/**
 * The Changes panel's side-by-side Compare (BACKLOG #119 A3). app/repo-linediff.js decides how two texts line up (the same
 * longest-common-subsequence alignment the reader's conflict Compare uses; no second diff library). This file is what the Changes view adds:
 *
 *   sideBySide(rows)            diffLines rows -> [{ kind: 'same'|'change'|'del'|'add', left: {no,text}|null, right: {no,text}|null }]
 *                               a removed run is paired with the added run beside it, line for line ('change'); what is left over stands alone
 *   fold(paired, opts)          unchanged stretches longer than the context fold to their edges: { kind: 'gap', hidden, note? } rows
 *   hunkStarts(rows)            the index of the first row of each run of changes (the `j` / `k` keys)
 *   nextHunk / prevHunk(starts, from)   the next / previous start, wrapping; `from` null means "nothing selected yet"
 *   commentText(path, line, text)  { ok, text } `In <path>:<line> — <comment>`, ONE line, or { ok: false, reason }
 *   stackText(list)             { ok, text, count } several comments joined on ONE line, within what the prompt can be typed with
 *   buildRows(doc, rows)        the DOM rows (a fake document is enough to test it)
 *
 * WHY ONE LINE. A comment is TYPED into the CLI's input box and read back (renderer.js typeAndCheck), and that read-back, like the
 * typing gate in app/top-bar-display.js, only knows one-line text: a CR submits, and `\` + Enter is the CLI's newline (measured,
 * verify/probe-panel-line-input.js). So a stack of comments is one line, joined with "; ", and each begins "In <path>:<line> —".
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `changesCompare`.
 */
(function (root) {

const CONTEXT = 3;
const MAX_ROWS = 4000;
// The most the prompt is typed with (app/top-bar-display.js COMMENT_LINE holds the same limit).
const MAX_STACK_CHARS = 1990;
const SEP = '; ';
const DASH = '—';

function sideBySide(rows) {
  const out = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.min(dels.length, adds.length);
    for (let i = 0; i < n; i += 1) out.push({ kind: 'change', left: { no: dels[i].diskNo, text: dels[i].text }, right: { no: adds[i].mineNo, text: adds[i].text } });
    for (let i = n; i < dels.length; i += 1) out.push({ kind: 'del', left: { no: dels[i].diskNo, text: dels[i].text }, right: null });
    for (let i = n; i < adds.length; i += 1) out.push({ kind: 'add', left: null, right: { no: adds[i].mineNo, text: adds[i].text } });
    dels = [];
    adds = [];
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.kind === 'del') dels.push(r);
    else if (r.kind === 'add') adds.push(r);
    else { flush(); out.push({ kind: 'same', left: { no: r.diskNo, text: r.text }, right: { no: r.mineNo, text: r.text } }); }
  }
  flush();
  return out;
}

function fold(paired, { context = CONTEXT, maxRows = MAX_ROWS } = {}) {
  const rows = Array.isArray(paired) ? paired : [];
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (out.length >= maxRows) {
      out.push({ kind: 'gap', hidden: rows.length - i, note: 'the rest is not shown' });
      return out;
    }
    if (rows[i].kind !== 'same') { out.push(rows[i]); i += 1; continue; }
    let j = i;
    while (j < rows.length && rows[j].kind === 'same') j += 1;
    const head = i === 0 ? 0 : context;
    const tail = j === rows.length ? 0 : context;
    if (j - i <= head + tail + 1) { for (let k = i; k < j; k += 1) out.push(rows[k]); }
    else {
      for (let k = i; k < i + head; k += 1) out.push(rows[k]);
      out.push({ kind: 'gap', hidden: j - i - head - tail });
      for (let k = j - tail; k < j; k += 1) out.push(rows[k]);
    }
    i = j;
  }
  return out;
}

const isChange = (r) => r.kind === 'change' || r.kind === 'del' || r.kind === 'add';

function hunkStarts(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) if (isChange(rows[i]) && (i === 0 || !isChange(rows[i - 1]))) out.push(i);
  return out;
}

function nextHunk(starts, from) {
  if (!Array.isArray(starts) || starts.length === 0) return null;
  if (!Number.isInteger(from)) return starts[0];
  const n = starts.find(s => s > from);
  return n === undefined ? starts[0] : n;
}

function prevHunk(starts, from) {
  if (!Array.isArray(starts) || starts.length === 0) return null;
  if (!Number.isInteger(from)) return starts[starts.length - 1];
  for (let i = starts.length - 1; i >= 0; i -= 1) if (starts[i] < from) return starts[i];
  return starts[starts.length - 1];
}

// ---- the comment ----

const HAS_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const STRIP_CONTROL = /\p{Cc}/gu;

function commentText(path, line, text) {
  if (typeof path !== 'string' || path === '' || HAS_CONTROL.test(path)) return { ok: false, reason: 'no file to comment on' };
  if (!Number.isInteger(line) || line < 1) return { ok: false, reason: 'no line to comment on' };
  if (typeof text !== 'string') return { ok: false, reason: 'no comment' };
  let t = text.replace(/\s+/g, ' ').replace(STRIP_CONTROL, '');
  t = t.trim().replace(/\\+$/, '').trim();               // a trailing backslash + Enter is the CLI's newline
  if (t === '') return { ok: false, reason: 'the comment is empty' };
  const line1 = `In ${path}:${line} ${DASH} ${t}`;
  if (line1.length > MAX_STACK_CHARS) return { ok: false, reason: 'the comment is too long' };
  return { ok: true, text: line1 };
}

function stackText(list) {
  const items = (Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s !== '');
  if (items.length === 0) return { ok: false, reason: 'no comments to type' };
  const text = items.join(SEP);
  if (text.length > MAX_STACK_CHARS) return { ok: false, reason: 'the comments are too long to type in one go; type some, then add the rest' };
  return { ok: true, text, count: items.length };
}

// ---- the DOM ----

function buildRows(doc, rows) {
  const el = (tag, cls, text) => { const e = doc.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const body = (t) => (t === '' ? ' ' : t);
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (r.kind === 'gap') return el('div', 'sbs-row gap', r.note ? r.note : `${r.hidden} unchanged lines`);
    const row = el('div', `sbs-row ${r.kind}`);
    row.append(
      el('span', 'sbs-no', r.left ? String(r.left.no) : ''),
      el('span', `sbs-l${r.left ? '' : ' empty'}`, r.left ? body(r.left.text) : ''),
      el('span', 'sbs-no', r.right ? String(r.right.no) : ''),
      el('span', `sbs-r${r.right ? '' : ' empty'}`, r.right ? body(r.right.text) : ''),
    );
    const act = el('span', 'sbs-act');
    if (r.right) {
      row.dataset.line = String(r.right.no);
      const b = el('button', 'sbs-btn', '+');
      b.type = 'button';
      b.title = 'Comment on this line (Ctrl+/)';
      b.setAttribute('aria-label', `Comment on line ${r.right.no}`);
      b.dataset.act = 'comment';
      b.dataset.line = String(r.right.no);
      act.append(b);
    }
    row.append(act);
    return row;
  });
}

const API = { sideBySide, fold, hunkStarts, nextHunk, prevHunk, commentText, stackText, buildRows, MAX_STACK_CHARS, CONTEXT, MAX_ROWS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.changesCompare = API;

})(typeof window !== 'undefined' ? window : globalThis);
