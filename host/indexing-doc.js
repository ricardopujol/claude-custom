'use strict';
/**
 * The indexing assistant's inbox (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)": no model, a verbatim inbox). Pure: strings in, strings out; host/indexing-writer.js reads and writes.
 *
 *   stampOf(ms)                      -> 'YYYY-MM-DD HH:MM' (local time)
 *   entryText(stamp, text, nl)       -> '- STAMP · <first line>' + continuation lines indented two spaces
 *   newlineOf(text)                  -> the file's first line break ('\r\n' or '\n'), add-history.ps1's rule
 *   inboxOf(text)                    -> where the `## Inbox` section is, or { found: false }
 *   ensureInbox(text)                -> { text, added }   the section created right after the status block if missing
 *   planAppend(text, entry)          -> { ok: true, offset, inserted } | { ok: false, reason: 'no-inbox' }
 *   applyInsert(text, plan) / recordOf(plan, entry)   -> the new text / what the journal keeps for Undo
 *   removeEntry(text, record)        -> { ok: true, text } | { ok: false, reason: 'changed' | 'bad-record' }
 *
 * THE ENTRY is Ricardo's words verbatim (only the whole note's outer whitespace trimmed), its first line after
 * `- YYYY-MM-DD HH:MM · `, every further line indented two spaces (a lone \r counts as a line break). So no line of a
 * note starts at column 0: it can't forge a heading, a fence or a `## N.` item for anything that reads the backlog by
 * its column-0 lines, and this file's own parser reads a two-space line after an entry as that entry's continuation.
 *
 * THE SECTION. `## Inbox` (any case, up to three leading spaces, outside fences) runs to the next `#` or `##` heading.
 * Headings take up to three leading spaces, as Markdown does (Dexter F6b, PR #121); fences close only on the same
 * character, at least as long. A missing inbox goes right after the status block: before the first `##` heading, or
 * at the end when there's none. New entries go after the section's last non-blank line, so they stay in typed order.
 *
 * UNDO finds the entry by its exact text inside the inbox, at a line start, as a whole entry (not the first line of a
 * longer one), and takes the occurrence nearest where it was put. Edits elsewhere in the backlog (a session's
 * /sync-docs) don't block it; an edited, moved or filed-away entry does, and then nothing is removed. The heading a
 * first note created stays: Undo removes that note's line, nothing else.
 */

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const INBOX = /^ {0,3}##[ \t]+inbox[ \t]*#*[ \t]*$/i;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const CONTINUATION = /^ {2}/;
const NEWLINES = ['\n', '\r\n'];

const pad = (n) => String(n).padStart(2, '0');

function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function newlineOf(text) {
  if (typeof text !== 'string') return '\n';
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

function entryText(stamp, text, nl) {
  const lines = String(text).trim().split(/\r\n|\r|\n/);
  return `- ${stamp} · ${lines[0]}${nl}` + lines.slice(1).map(l => `  ${l}${nl}`).join('');
}

/** The text's lines: { text (no line break), start, next (offset after its line break), ended (had one) }. */
function linesOf(text) {
  const out = [];
  const re = /\r?\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index), start, next: m.index + m[0].length, ended: true });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), start, next: text.length, ended: false });
  return out;
}

/** A fence tracker: feed it lines, it says whether each one is inside (or opens/closes) a fence. */
function fenceTracker() {
  let open = null;            // { ch, len }
  const feed = (line) => {
    if (open) {
      const c = FENCE_CLOSE.exec(line);
      if (c && c[1][0] === open.ch && c[1].length >= open.len) open = null;
      return true;
    }
    const o = FENCE_OPEN.exec(line);
    if (o) { open = { ch: o[1][0], len: o[1].length }; return true; }
    return false;
  };
  feed.isOpen = () => open !== null;
  return feed;
}

const headingLevel = (line) => { const m = HEADING.exec(line); return m ? m[1].length : 0; };

function inboxOf(text) {
  const src = typeof text === 'string' ? text : '';
  const lines = linesOf(src);
  const fenced = fenceTracker();
  let h = -1;
  for (let i = 0; i < lines.length; i++) {
    if (fenced(lines[i].text)) continue;
    if (INBOX.test(lines[i].text)) { h = i; break; }
  }
  if (h < 0) return { found: false };
  // Inside the section: a two-space line after an entry is that entry's continuation, never a heading or a fence.
  const inner = fenceTracker();
  let inEntry = false;
  let last = lines[h];
  let lastBeforeFence = last;          // where entries go if a fence is still open at the end: before it, not inside
  let end = src.length;
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i].text;
    if (inEntry && CONTINUATION.test(l)) { last = lines[i]; continue; }
    const wasOpen = inner.isOpen();
    if (inner(l)) {
      if (!wasOpen) lastBeforeFence = last;
      inEntry = false;
      last = lines[i];
      continue;
    }
    const level = headingLevel(l);
    if (level > 0 && level <= 2) { end = lines[i].start; break; }
    inEntry = /^- /.test(l);
    if (l.trim() !== '') last = lines[i];
  }
  const after = inner.isOpen() ? lastBeforeFence : last;
  return { found: true, headingStart: lines[h].start, bodyStart: lines[h].next, end, after };
}

function ensureInbox(text) {
  const src = typeof text === 'string' ? text : '';
  if (inboxOf(src).found) return { text: src, added: false };
  const nl = newlineOf(src);
  const block = `## Inbox${nl}`;
  const lines = linesOf(src);
  const fenced = fenceTracker();
  const before = (i) => {
    const prevBlank = i === 0 || lines[i - 1].text.trim() === '';
    const at = lines[i].start;
    return { text: src.slice(0, at) + (prevBlank ? '' : nl) + block + nl + src.slice(at), added: true };
  };
  let opener = -1;
  for (let i = 0; i < lines.length; i++) {
    const wasOpen = fenced.isOpen();
    if (fenced(lines[i].text)) { if (!wasOpen && fenced.isOpen()) opener = i; continue; }
    if (headingLevel(lines[i].text) === 2) return before(i);
  }
  // A fence never closed would swallow an inbox put after it: the inbox goes before that fence.
  if (fenced.isOpen()) return before(opener);
  if (src === '') return { text: block, added: true };
  let tail = src.endsWith('\n') ? '' : nl;
  const lastLine = lines[lines.length - 1];
  if (lastLine.text.trim() !== '') tail += nl;
  return { text: src + tail + block, added: true };
}

function planAppend(text, entry) {
  const src = typeof text === 'string' ? text : '';
  const box = inboxOf(src);
  if (!box.found) return { ok: false, reason: 'no-inbox' };
  const nl = newlineOf(src);
  const lead = box.after.ended ? '' : nl;
  // A next line that starts with two spaces (an indented heading) would read as this entry's continuation: a blank
  // line after the entry keeps it what it was.
  const sep = CONTINUATION.test(src.slice(box.after.next, box.after.next + 2)) ? nl : '';
  return { ok: true, offset: box.after.next, inserted: lead + entry + sep };
}

const applyInsert = (text, plan) => text.slice(0, plan.offset) + plan.inserted + text.slice(plan.offset);

function recordOf(plan, entry) {
  const at = plan.inserted.indexOf(entry);
  const lead = plan.inserted.slice(0, at);
  const sep = plan.inserted.slice(at + entry.length);
  return { entry, offset: plan.offset + lead.length, lead, sep };
}

function removeEntry(text, record) {
  const r = record && typeof record === 'object' ? record : {};
  const sep = r.sep === undefined ? '' : r.sep;
  if (typeof r.entry !== 'string' || r.entry === '' || !Number.isInteger(r.offset) || r.offset < 0
    || !(r.lead === '' || NEWLINES.includes(r.lead)) || !(sep === '' || NEWLINES.includes(sep))) {
    return { ok: false, reason: 'bad-record' };
  }
  const src = typeof text === 'string' ? text : '';
  const box = inboxOf(src);
  if (!box.found) return { ok: false, reason: 'changed' };
  let best = -1;
  for (let i = src.indexOf(r.entry, box.bodyStart); i >= 0 && i + r.entry.length <= box.end; i = src.indexOf(r.entry, i + 1)) {
    const atLineStart = i === 0 || src[i - 1] === '\n';
    // A whole entry: the next line isn't its continuation.
    const complete = !CONTINUATION.test(src.slice(i + r.entry.length, i + r.entry.length + 2));
    if (atLineStart && complete && (best < 0 || Math.abs(i - r.offset) < Math.abs(best - r.offset))) best = i;
  }
  if (best < 0) return { ok: false, reason: 'changed' };
  let start = best;
  let end = best + r.entry.length;
  // The separating blank line goes back out only while it still follows this entry; once a later entry was put in
  // between, it separates that one.
  if (sep !== '' && src.slice(end, end + sep.length) === sep) end += sep.length;
  if (r.lead !== '' && end === src.length && src.slice(start - r.lead.length, start) === r.lead) start -= r.lead.length;
  return { ok: true, text: src.slice(0, start) + src.slice(end) };
}

module.exports = {
  stampOf, entryText, newlineOf, inboxOf, ensureInbox, planAppend, applyInsert, recordOf, removeEntry,
};
