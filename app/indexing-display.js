'use strict';
/**
 * The indexing assistant's display (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)": a field in the strip, Enter appends the note verbatim to the project's backlog `## Inbox`, Undo in a
 * 10 s toast and in the "N filed" list).
 *
 * Two pages draw it. The strip (app/tab-strip.html) has the field, the project chip and the counter; the overlay
 * (app/indexing-overlay.html, a small view main stacks over the tab views, which cover everything under the strip) has
 * the toast and the list. The decisions are the pure functions below; the painters only draw them.
 *
 *   counterText(counts)        '3 filed' | '1 not filed' | '2 filed · 1 not filed'
 *   reasonText(reason)         why a note isn't filed, in words
 *   toastModel(row) / resultToast(result) / toastMs(kind)   the toast
 *   listRow(row)               one line of the list
 *
 * Somebody's words (the note, file names) only ever go in through textContent.
 *
 * WRAPPED IN AN IIFE: plain <script> files share one global scope (CLAUDE.md's first trap). One name leaves it:
 * `indexingDisplay`.
 */
(function (root) {

const num = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

function counterText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const parts = [];
  if (num(c.filed) > 0) parts.push(`${num(c.filed)} filed`);
  if (num(c.unfiled) > 0) parts.push(`${num(c.unfiled)} not filed`);
  return parts.length ? parts.join(' · ') : '0 filed';
}

const REASONS = {
  'no-backlog': 'This project has no backlog file',   // held by an older build; a new note creates the file and files it
  'no-docs': 'This project has no documentation folder',
  'no-backlog-ambiguous': 'Several backlog files in documentation',
  'many-build-logs': 'Two build logs in documentation',
  conflict: 'The backlog kept changing; it tries again',
  busy: 'The backlog was busy; it tries again',
  'write-failed': "The backlog couldn't be written; it tries again",
  gone: "That note isn't in the journal any more",
};

function reasonText(reason) {
  if (reason === null || reason === undefined) return 'Not filed yet';
  return Object.prototype.hasOwnProperty.call(REASONS, reason) ? REASONS[reason] : 'Not filed';
}

const firstLine = (text) => String(typeof text === 'string' ? text : '').split(/\r\n|\r|\n/)[0];

/** "Created the backlog and filed your note", naming the folder and the .gitignore entry too when this note made them. */
function createdLine(r) {
  const parts = [];
  if (r.createdFolder === true) parts.push('documentation\\');
  parts.push('the backlog');
  if (r.createdIgnore === true) parts.push('its .gitignore entry');
  if (parts.length === 1) return 'Created the backlog and filed your note';
  const what = parts.length === 2 ? parts.join(' and ') : `${parts[0]}, ${parts[1]} and ${parts[2]}`;
  return `Created ${what}, and filed your note`;
}

function toastModel(row) {
  const r = row && typeof row === 'object' ? row : {};
  const note = firstLine(r.text);
  if (r.state === 'filed') {
    const line = r.createdBacklog === true ? createdLine(r) : 'Added to the inbox';
    return { kind: 'added', line, note, undo: r.undoable === true, copy: false };
  }
  if (r.state === 'undone') return { kind: 'undone', line: 'Undone. Removed from the inbox.', note, undo: false, copy: false };
  return { kind: 'unfiled', line: `Not filed: ${reasonText(r.reason)}`, note, undo: false, copy: true };
}

const RESULT_LINES = {
  'not-filed': "That note isn't in the inbox.",
  'other-project': 'That note belongs to another project.',
  'bad-record': "Can't undo: that note's place isn't this project's backlog.",
};

/** What a failed Undo says; null when it worked (the note's own state tells the rest). */
function resultToast(result) {
  if (!result || result.ok === true) return null;
  if (result.reason === 'changed') {
    return typeof result.file === 'string'
      ? { kind: 'cant-undo', line: "Can't undo: the inbox changed since.", open: result.file }
      : { kind: 'cant-undo', line: "Can't undo: the inbox changed since." };
  }
  const line = RESULT_LINES[result.reason] || `Couldn't undo: ${reasonText(result.reason)}.`;
  return { kind: 'error', line };
}

// The design's Undo window is 10 s; anything else said once stays as long. Undone only confirms.
const toastMs = (kind) => (kind === 'undone' ? 2_500 : 10_000);

function timeOf(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function listRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  let where;
  if (r.state === 'filed') where = r.undoable === true ? 'In the inbox' : 'In the inbox (changed since)';
  else if (r.state === 'undone') where = 'Undone';
  else where = `Not filed: ${reasonText(r.reason)}`;
  return {
    text: typeof r.text === 'string' ? r.text : '',
    time: timeOf(r.at),
    where,
    undo: r.state === 'filed' && r.undoable === true,
    copy: r.state === 'unfiled',
  };
}

function short(text, max = 64) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

// --- the painters (verify/probe-indexing-strip.js runs them in a real window) -----------------------------------------

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(doc, text, cls, onClick) {
  const b = el(doc, 'button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** The strip's field, chip and counter (app/tab-strip.html). */
function mountStrip(doc, bridge) {
  const input = doc.getElementById('index-note');
  const chip = doc.getElementById('index-chip');
  const count = doc.getElementById('index-count');
  const form = doc.getElementById('index');
  if (!input || !chip || !count || !form || !bridge || typeof bridge.indexSubmit !== 'function') return false;
  form.addEventListener('submit', (ev) => ev.preventDefault());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); input.blur(); bridge.indexLeave(); return; }
    if (ev.key !== 'Enter' || ev.isComposing) return;
    ev.preventDefault();
    const v = input.value;
    if (v.trim() === '') return;
    Promise.resolve(bridge.indexSubmit(v)).then((r) => {
      if (r && r.ok && input.value === v) input.value = '';
    }, () => {});
  });
  input.addEventListener('focus', () => bridge.indexFocus(true));
  input.addEventListener('blur', () => bridge.indexFocus(false));
  chip.addEventListener('click', () => bridge.indexChip());
  count.addEventListener('click', () => bridge.indexList());
  bridge.onIndex((state) => paintStrip(doc, state));
  bridge.onIndexFocus(() => { input.focus(); input.select(); });
  return true;
}

function paintStrip(doc, state) {
  const s = state && typeof state === 'object' ? state : {};
  const chip = doc.getElementById('index-chip');
  const count = doc.getElementById('index-count');
  const label = typeof s.label === 'string' && s.label !== '' ? s.label : 'this project';
  chip.textContent = label;
  chip.title = `Adds to ${label}'s backlog inbox. Click to switch project.`;
  count.textContent = counterText(s.counts);
  count.setAttribute('aria-expanded', String(s.listOpen === true));
  const c = s.counts && typeof s.counts === 'object' ? s.counts : {};
  count.classList.toggle('pending', num(c.unfiled) > 0);
}

/** The toast or the list (app/indexing-overlay.html?part=toast|list). */
function mountOverlay(doc, bridge, part) {
  const rootEl = doc.getElementById('root');
  if (!rootEl || !bridge || typeof bridge.onState !== 'function') return false;
  let state = null;
  let timerKey = null;
  let timer = null;
  const report = () => {
    const h = rootEl.firstElementChild ? Math.ceil(rootEl.getBoundingClientRect().height) : 0;
    bridge.size(part, h);
  };
  if (typeof doc.defaultView.ResizeObserver === 'function') new doc.defaultView.ResizeObserver(report).observe(rootEl);
  doc.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state) return;
    if (part === 'list') bridge.closeList();
    else if (state.toast) bridge.dismiss(state.toast.seq);
  });
  const accent = (hex) => {
    if (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) doc.documentElement.style.setProperty('--accent', hex);
    else doc.documentElement.style.removeProperty('--accent');
  };
  bridge.onState((s) => {
    state = s;
    accent(s && s.accent);
    rootEl.replaceChildren();
    const node = part === 'list' ? listNode(doc, s, bridge) : toastNode(doc, s, bridge);
    if (node) rootEl.appendChild(node);
    if (part === 'toast') {
      const kind = node ? node.dataset.kind : null;
      const key = s && s.toast && kind ? `${s.toast.seq}:${kind}` : null;
      if (key !== timerKey) {
        clearTimeout(timer);
        timerKey = key;
        if (kind) { const seqNow = s.toast.seq; timer = setTimeout(() => bridge.dismiss(seqNow), toastMs(kind)); }
      }
    }
    report();
  });
  bridge.ready(part);
  return true;
}

const rowsOf = (s) => (s && s.snapshot && Array.isArray(s.snapshot.list) ? s.snapshot.list : []);

function toastNode(doc, s, bridge) {
  if (!s || !s.toast) return null;
  const row = rowsOf(s).find(n => n.id === s.toast.id) || null;
  const failed = resultToast(s.toast.result);
  const m = failed || (row ? toastModel(row) : null);
  if (!m) return null;
  const box = el(doc, 'div', `toast ${m.kind}`);
  box.dataset.kind = m.kind;
  box.appendChild(el(doc, 'div', 't1', m.line));
  if (!failed && row) box.appendChild(el(doc, 'div', 'note', short(m.note, 90))).title = row.text;
  const acts = el(doc, 'div', 'acts');
  if (!failed && m.undo) acts.appendChild(button(doc, 'Undo', null, () => bridge.undo(row.id)));
  if (!failed && m.copy) acts.appendChild(button(doc, 'Copy', null, () => bridge.copy(row.id)));
  if (failed && failed.open) acts.appendChild(button(doc, 'Open the backlog', null, () => bridge.open(failed.open)));
  if (acts.childElementCount) box.appendChild(acts);
  const bar = box.appendChild(el(doc, 'div', 'bar'));
  bar.appendChild(el(doc, 'i')).style.animationDuration = `${toastMs(m.kind)}ms`;
  return box;
}

function listNode(doc, s, bridge) {
  if (!s || s.listOpen !== true) return null;
  const box = el(doc, 'div', 'pop');
  const head = box.appendChild(el(doc, 'div', 'head'));
  head.appendChild(el(doc, 'span', null, `Today · ${typeof s.label === 'string' ? s.label : ''}`));
  head.appendChild(button(doc, '✕', 'x', () => bridge.closeList())).title = 'Close (Esc)';
  const rows = rowsOf(s);
  if (rows.length === 0) box.appendChild(el(doc, 'div', 'empty', 'Nothing added today.'));
  for (const r of rows) {
    const lr = listRow(r);
    const line = box.appendChild(el(doc, 'div', `row ${r.state}`));
    line.appendChild(el(doc, 'span', 'what', short(lr.text, 70))).title = lr.text;
    line.appendChild(el(doc, 'span', 'when', lr.time));
    line.appendChild(el(doc, 'span', 'where', lr.where));
    const acts = el(doc, 'span', 'mini');
    if (lr.undo) acts.appendChild(button(doc, 'Undo', null, () => bridge.undo(r.id)));
    if (lr.copy) acts.appendChild(button(doc, 'Copy', null, () => bridge.copy(r.id)));
    if (acts.childElementCount) line.appendChild(acts);
  }
  return box;
}

const api = { counterText, reasonText, toastModel, resultToast, toastMs, listRow, short, timeOf, mountStrip, paintStrip, mountOverlay };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.indexingDisplay = api;
  if (root.strip && typeof root.strip.indexSubmit === 'function') mountStrip(root.document, root.strip);
  if (root.indexing && typeof root.indexing.onState === 'function') {
    let part = 'toast';
    try { part = new URLSearchParams(root.location.search).get('part') === 'list' ? 'list' : 'toast'; } catch { /* toast */ }
    mountOverlay(root.document, root.indexing, part);
  }
}

})(typeof window !== 'undefined' ? window : globalThis);
