'use strict';
/**
 * The indexing assistant's document side (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Claude's call" 1, 2
 * and 5). Pure: strings in, strings out; host/indexing-writer.js does the reading and writing.
 *
 *   parseBacklog(text)   -> { items: [{ n, title, start, end, dup }] }   the `## N. title` items, in file order
 *   titleLines(text)     -> ['## N. title', ...]                         all the model ever sees of the backlog
 *   nextItemNumber(text) -> highest `## N.` + 1 (computed here, never by the model)
 *   planInsert(text, spec) -> { ok: true, offset, inserted, n? } | { ok: false, reason }
 *       spec { target: 'new', title, text, date }   a new item at the end of the backlog
 *            { target: N, text, date }              a note at the end of item #N
 *            { target: 'history', kind, text, date } a history entry (add-history.ps1's format), appended
 *   applyInsert(text, plan)   -> the text with the insertion made
 *   recordOf(text, plan)      -> { offset, inserted, prefixHash }   what the journal keeps for Undo
 *   undoInsert(text, record)  -> { ok: true, text } | { ok: false, reason: 'changed' | 'bad-record' }
 *
 * THE WORDING. Ricardo's text is kept verbatim (only its line breaks follow the file's); the model writes only a new
 * item's title. A new item is `## N. <title> (captured DATE, indexing assistant)` then `Ricardo: "<text>"`; a note on
 * #N is `- **Note (DATE, indexing assistant):** <text>` after the item's last non-blank line.
 *
 * AN ITEM runs from its heading to the next `#` or `##` heading (a `###` inside it is part of it), and a heading inside
 * a ``` or ~~~ fence is neither. A number used twice is `dup`: a note can't be put on it, because which one is meant
 * can't be known. nextItemNumber counts EVERY `## N.` line, fenced too, so a new number never collides with anything.
 *
 * EXACT UNDO ("where it was put"): the text before the insertion must hash the same, and the inserted text must still
 * be at that offset. Text added after it (another session appending) doesn't block Undo and is kept.
 */

const crypto = require('crypto');

const ITEM = /^## (\d{1,6})\. +(.*?)\s*$/;
const ANY_NUMBERED = /^##\s+(\d{1,6})\./;
const ENDS_ITEM = /^#{1,2}(?:\s|$)/;
const FENCE = /^\s{0,3}(?:```|~~~)/;
const HISTORY_KINDS = ['decision', 'learning'];

const hashOf = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const newlineOf = (text) => (typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n');
const isNonEmptyString = (s) => typeof s === 'string' && s.trim() !== '';

/** The text's lines: { text (no line break), start, next (the offset after its line break) }. */
function linesOf(text) {
  const out = [];
  const re = /\r?\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index), start, next: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), start, next: text.length });
  return out;
}

function parseBacklog(text) {
  const src = typeof text === 'string' ? text : '';
  const items = [];
  let open = null;
  let fenced = false;
  for (const line of linesOf(src)) {
    if (FENCE.test(line.text)) { fenced = !fenced; continue; }
    if (fenced || !ENDS_ITEM.test(line.text)) continue;
    if (open) { open.end = line.start; open = null; }
    const m = ITEM.exec(line.text);
    if (m) {
      open = { n: Number(m[1]), title: m[2], start: line.start, end: src.length, dup: false };
      items.push(open);
    }
  }
  const seen = new Map();
  for (const it of items) seen.set(it.n, (seen.get(it.n) || 0) + 1);
  for (const it of items) it.dup = seen.get(it.n) > 1;
  return { items };
}

const titleLines = (text) => parseBacklog(text).items.map(i => `## ${i.n}. ${i.title}`);

function nextItemNumber(text) {
  let max = 0;
  for (const line of linesOf(typeof text === 'string' ? text : '')) {
    const m = ANY_NUMBERED.exec(line.text);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** The note's own lines, in the file's line break, the trailing whitespace of the whole note trimmed. */
const noteLines = (text) => text.trim().split(/\r\n|\r|\n/);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const endsWithNewline = (text) => text.endsWith('\n');
const lastLineBlank = (text) => {
  const lines = linesOf(text);
  return lines.length > 0 && lines[lines.length - 1].text.trim() === '' && endsWithNewline(text);
};

function planNew(text, spec, nl) {
  if (!isNonEmptyString(spec.title)) return { ok: false, reason: 'no-title' };
  const n = nextItemNumber(text);
  let lead = '';
  if (text !== '') {
    if (!endsWithNewline(text)) lead = nl + nl;
    else if (!lastLineBlank(text)) lead = nl;
  }
  const inserted = lead + `## ${n}. ${oneLine(spec.title)} (captured ${spec.date}, indexing assistant)` + nl
    + `Ricardo: "${noteLines(spec.text).join(nl)}"` + nl;
  return { ok: true, offset: text.length, inserted, n };
}

function planNote(text, spec, nl) {
  const matches = parseBacklog(text).items.filter(i => i.n === spec.target);
  if (matches.length === 0) return { ok: false, reason: 'no-item' };
  if (matches.length > 1) return { ok: false, reason: 'dup-item' };
  const item = matches[0];
  const inItem = linesOf(text).filter(l => l.start >= item.start && l.start < item.end && l.text.trim() !== '');
  const last = inItem[inItem.length - 1];               // the heading at least
  const lineBreakMissing = last.next === text.length && !endsWithNewline(text);
  const inserted = (lineBreakMissing ? nl : '') + `- **Note (${spec.date}, indexing assistant):** `
    + noteLines(spec.text).join(nl + '  ') + nl;
  return { ok: true, offset: last.next, inserted };
}

function planHistory(text, spec, nl) {
  if (!HISTORY_KINDS.includes(spec.kind)) return { ok: false, reason: 'bad-kind' };
  const entry = `- ${spec.date} [${spec.kind}] ` + noteLines(spec.text).join(nl + '  ');
  const lead = text !== '' && !endsWithNewline(text) ? nl : '';
  return { ok: true, offset: text.length, inserted: lead + entry + nl };
}

function planInsert(text, spec) {
  const src = typeof text === 'string' ? text : '';
  const s = spec && typeof spec === 'object' ? spec : {};
  const nl = newlineOf(src);
  const targetOk = s.target === 'new' || s.target === 'history' || (Number.isInteger(s.target) && s.target > 0);
  if (!targetOk) return { ok: false, reason: 'bad-target' };
  if (!isNonEmptyString(s.text)) return { ok: false, reason: 'empty' };
  if (s.target === 'new') return planNew(src, s, nl);
  if (s.target === 'history') return planHistory(src, s, nl);
  return planNote(src, s, nl);
}

const applyInsert = (text, plan) => text.slice(0, plan.offset) + plan.inserted + text.slice(plan.offset);

const recordOf = (text, plan) => ({ offset: plan.offset, inserted: plan.inserted, prefixHash: hashOf(text.slice(0, plan.offset)) });

function undoInsert(text, record) {
  const r = record && typeof record === 'object' ? record : {};
  if (!Number.isInteger(r.offset) || r.offset < 0 || !isNonEmptyString(r.inserted) || typeof r.prefixHash !== 'string') {
    return { ok: false, reason: 'bad-record' };
  }
  const src = typeof text === 'string' ? text : '';
  const end = r.offset + r.inserted.length;
  if (end > src.length || src.slice(r.offset, end) !== r.inserted || hashOf(src.slice(0, r.offset)) !== r.prefixHash) {
    return { ok: false, reason: 'changed' };
  }
  return { ok: true, text: src.slice(0, r.offset) + src.slice(end) };
}

module.exports = {
  parseBacklog, titleLines, nextItemNumber, newlineOf, planInsert, applyInsert, recordOf, undoInsert, hashOf, HISTORY_KINDS,
};
