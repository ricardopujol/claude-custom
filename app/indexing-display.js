'use strict';
/**
 * The indexing assistant's display (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md pick 1, A: a field in the
 * strip that files, Undo in a toast; the accuracy gate's propose mode; "Claude's call" 4, 5, 6 and 9).
 *
 * Two pages draw it. The strip (app/tab-strip.html) has the field, the project chip and the counter; the overlay
 * (app/indexing-overlay.html, a small view main stacks over the tab views, which cover everything under the strip) has
 * the toast and the "N filed" list. The decisions are the pure functions below; the painters only draw them.
 *
 *   counterText(counts)                  '3 filed' | '1 waiting' | '2 filed · 1 to place' ...
 *   placeText(where)                     'New backlog item #72' | 'Added to #66' | 'History · learning'
 *   reasonText(reason)                   why a note waits, in words
 *   pickerOptions(row, titles, { moving })  [{ value, label, guess? }]  the guess first, then new, the closest items,
 *                                        the history (decision, learning); Move leaves out where it already is
 *   choiceOf(value)                      a picker value -> { target, kind? } for main, or null
 *   toastModel(row, titles) / resultToast(result) / toastMs(kind)   the toast
 *   listRow(row)                         one line of the list
 *
 * Somebody's words (the note, item titles, file names) only ever go in through textContent.
 *
 * WRAPPED IN AN IIFE: plain <script> files share one global scope (CLAUDE.md's first trap). One name leaves it:
 * `indexingDisplay`.
 */
(function (root) {

const num = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
const isItem = (t) => Number.isInteger(t) && t > 0;
const HISTORY_KINDS = ['decision', 'learning'];

function counterText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const filed = num(c.filed);
  const parts = [];
  if (filed > 0) parts.push(`${filed} filed`);
  if (num(c.waiting) > 0) parts.push(`${num(c.waiting)} waiting`);
  if (num(c.asking) > 0) parts.push(`${num(c.asking)} to place`);
  return parts.length ? parts.join(' · ') : '0 filed';
}

function placeText(where) {
  if (!where || typeof where !== 'object') return '';
  if (where.target === 'history') return `History · ${HISTORY_KINDS.includes(where.kind) ? where.kind : 'entry'}`;
  if (where.target === 'new') return isItem(where.n) ? `New backlog item #${where.n}` : 'New backlog item';
  if (isItem(where.target)) return `Added to #${where.target}`;
  return '';
}

const REASONS = {
  'ollama-down': "Ollama isn't answering",
  'model-missing': "The local model isn't installed",
  'model-error': "The model's answer was unusable",
  battery: 'On battery',
  busy: 'The local model is busy',
  conflict: 'The backlog kept changing',
  'write-failed': "The file couldn't be written",
  'no-docs': 'This project has no documentation folder',
  'no-backlog': 'This project has no backlog file',
  'no-history': 'This project has no history file',
  'many-build-logs': 'Two build logs in documentation',
  error: 'Something failed',
};

function reasonText(reason) {
  if (reason === null || reason === undefined) return 'Filing…';
  return Object.prototype.hasOwnProperty.call(REASONS, reason) ? REASONS[reason] : 'Waiting';
}

const itemLabel = (n, titles) => {
  const t = titles && typeof titles === 'object' && typeof titles[n] === 'string' && titles[n] !== '' ? titles[n] : null;
  return t ? `#${n} ${t}` : `#${n}`;
};

/** The value a target has in the picker: 'new', '63', 'history:decision'. */
function valueOf(target, kind) {
  if (target === 'new') return 'new';
  if (isItem(target)) return String(target);
  if (target === 'history') return `history:${HISTORY_KINDS.includes(kind) ? kind : 'decision'}`;
  return null;
}

function pickerOptions(row, titles, { moving = false } = {}) {
  const r = row && typeof row === 'object' ? row : {};
  const out = [];
  const seen = new Set();
  const here = moving && r.where ? valueOf(r.where.target, r.where.kind) : null;
  const add = (value, label, guess) => {
    if (value === null || seen.has(value) || value === here) return;
    seen.add(value);
    out.push(guess ? { value, label, guess: true } : { value, label });
  };
  const g = r.guess && typeof r.guess === 'object' ? r.guess : null;
  if (g) {
    const v = valueOf(g.target, g.kind);
    if (v === 'new') add(v, typeof g.title === 'string' && g.title !== '' ? `New backlog item: ${g.title}` : 'New backlog item', true);
    else if (v && v.startsWith('history:')) add(v, `History · ${v.slice(8)}`, true);
    else if (v) add(v, itemLabel(g.target, titles), true);
  }
  add('new', 'New backlog item', false);
  for (const n of Array.isArray(r.options) ? r.options : []) if (isItem(n)) add(String(n), itemLabel(n, titles), false);
  for (const k of HISTORY_KINDS) add(`history:${k}`, `History · ${k}`, false);
  return out;
}

function choiceOf(value) {
  if (value === 'new') return { target: 'new' };
  if (typeof value !== 'string') return null;
  const h = /^history:(decision|learning)$/.exec(value);
  if (h) return { target: 'history', kind: h[1] };
  if (/^[1-9]\d{0,5}$/.test(value)) return { target: Number(value) };
  return null;
}

function toastModel(row, titles) {
  const r = row && typeof row === 'object' ? row : {};
  const text = typeof r.text === 'string' ? r.text : '';
  if (r.state === 'filed') return { kind: 'filed', text, line: `Filed: ${placeText(r.where)}`, undo: r.undoable === true, move: true };
  if (r.state === 'undone') return { kind: 'undone', text, line: 'Undone. Nothing was kept.' };
  if (r.state === 'asking') {
    const best = pickerOptions(r, titles).find(o => o.guess);
    return { kind: 'asking', text, line: best ? `Where should this go? Best guess: ${best.label}` : 'Where should this go?', options: pickerOptions(r, titles) };
  }
  if (r.reason === null || r.reason === undefined) return { kind: 'filing', text, line: 'Filing…' };
  return { kind: 'waiting', text, line: `Waiting: ${reasonText(r.reason)}. It files when it can.` };
}

const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
const RESULT_LINES = {
  'no-item': "Couldn't file it: that item isn't in the backlog any more.",
  'dup-item': "Couldn't file it: that item number is used twice in the backlog.",
  'not-asking': 'That note already has a place.',
  'not-filed': "That note isn't filed.",
};

/** What a failed choose / undo / move says; null when it worked (the note's own state tells the rest). */
function resultToast(result) {
  if (!result || result.ok === true) return null;
  if (result.reason === 'changed' && typeof result.file === 'string') {
    return { kind: 'cant-undo', line: `Can't undo: ${baseName(result.file)} changed since. Open it?`, open: result.file };
  }
  if (result.reason === 'changed') return { kind: 'error', line: "Can't undo: the file changed since." };
  const line = RESULT_LINES[result.reason] || `Couldn't do it: ${reasonText(result.reason)}.`;
  return { kind: 'error', line };
}

const TOAST_MS = { filed: 10_000, undone: 2_500, waiting: 10_000, 'cant-undo': 10_000, error: 10_000 };
const toastMs = (kind) => (Object.prototype.hasOwnProperty.call(TOAST_MS, kind) ? TOAST_MS[kind] : null);

function timeOf(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function listRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  let where = '';
  if (r.state === 'filed') where = placeText(r.where);
  else if (r.state === 'undone') where = 'Undone';
  else if (r.state === 'asking') where = 'Needs a place';
  else where = r.reason === null || r.reason === undefined ? 'Filing…' : `Waiting: ${reasonText(r.reason)}`;
  return {
    text: typeof r.text === 'string' ? r.text : '',
    time: timeOf(r.at),
    where,
    undo: r.state === 'filed' && r.undoable === true,
    move: r.state === 'filed',
    pick: r.state === 'asking',
  };
}

function short(text, max = 64) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

const api = {
  counterText, placeText, reasonText, pickerOptions, choiceOf, toastModel, resultToast, toastMs, listRow, short, timeOf,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.indexingDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
