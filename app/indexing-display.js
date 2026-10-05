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

/** A <select> whose first option is the prompt; picking anything else calls onPick(value). */
function picker(doc, prompt, options, onPick) {
  const s = el(doc, 'select');
  s.setAttribute('aria-label', prompt);
  s.appendChild(new doc.defaultView.Option(prompt, ''));
  for (const o of options) s.appendChild(new doc.defaultView.Option(o.guess ? `${o.label} (best guess)` : o.label, o.value));
  s.addEventListener('change', () => { if (s.value) onPick(s.value); });
  return s;
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
    if (v.trim() === '') { bridge.indexConfirm(); return; }
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
  const input = doc.getElementById('index-note');
  const label = typeof s.label === 'string' && s.label !== '' ? s.label : 'this project';
  chip.textContent = label;
  chip.title = `Files into ${label}. Click to switch project.`;
  count.textContent = counterText(s.counts);
  count.setAttribute('aria-expanded', String(s.listOpen === true));
  const c = s.counts && typeof s.counts === 'object' ? s.counts : {};
  count.classList.toggle('pending', num(c.waiting) > 0 || num(c.asking) > 0);
  input.title = s.mode === 'direct'
    ? 'Type a note and press Enter: it is filed in the docs (Ctrl+Alt+N, Esc to leave)'
    : 'Type a note and press Enter: it asks where it goes before anything is written (Ctrl+Alt+N, Esc to leave)';
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
        const ms = kind ? toastMs(kind) : null;
        if (ms !== null) { const seqNow = s.toast.seq; timer = setTimeout(() => bridge.dismiss(seqNow), ms); }
      }
    }
    report();
  });
  bridge.ready(part);
  return true;
}

function rowsOf(s) {
  return s && s.snapshot && Array.isArray(s.snapshot.list) ? s.snapshot.list : [];
}

function toastNode(doc, s, bridge) {
  if (!s || !s.toast) return null;
  const titles = s.snapshot ? s.snapshot.titles : {};
  const row = rowsOf(s).find(n => n.id === s.toast.id) || null;
  const failed = resultToast(s.toast.result);
  const m = failed || (row ? toastModel(row, titles) : null);
  if (!m) return null;
  const box = el(doc, 'div', `toast ${m.kind}`);
  box.dataset.kind = m.kind;
  const head = box.appendChild(el(doc, 'div', 't1'));
  if (m.kind === 'filing') head.appendChild(el(doc, 'span', 'spin'));
  if (m.kind === 'filed') {
    head.appendChild(el(doc, 'span', null, 'Filed:'));
    head.appendChild(el(doc, 'span', 'dest', placeText(row.where)));
  } else {
    head.appendChild(el(doc, 'span', m.kind === 'asking' ? 'ask' : null, m.line));
  }
  if (!failed && row) box.appendChild(el(doc, 'div', 'note', short(row.text, 90))).title = row.text;
  const acts = el(doc, 'div', 'acts');
  if (m.kind === 'filed') {
    if (m.undo) acts.appendChild(button(doc, 'Undo', null, () => bridge.undo(row.id)));
    acts.appendChild(picker(doc, 'Move to…', pickerOptions(row, titles, { moving: true }), (v) => bridge.move(row.id, v)));
  } else if (m.kind === 'asking') {
    const opts = m.options || [];
    if (opts.length) acts.appendChild(button(doc, `File it (Enter)`, 'primary', () => bridge.choose(row.id, opts[0].value)));
    acts.appendChild(picker(doc, 'Put it in…', opts, (v) => bridge.choose(row.id, v)));
    acts.appendChild(button(doc, 'Not now', null, () => bridge.dismiss(s.toast.seq)));
  } else if (m.kind === 'cant-undo') {
    acts.appendChild(button(doc, 'Open', null, () => bridge.open(m.open)));
  }
  if (acts.childElementCount) box.appendChild(acts);
  const ms = toastMs(m.kind);
  if (ms !== null) {
    const bar = box.appendChild(el(doc, 'div', 'bar'));
    const fill = bar.appendChild(el(doc, 'i'));
    fill.style.animationDuration = `${ms}ms`;
  }
  return box;
}

function listNode(doc, s, bridge) {
  if (!s || s.listOpen !== true) return null;
  const titles = s.snapshot ? s.snapshot.titles : {};
  const box = el(doc, 'div', 'pop');
  const head = box.appendChild(el(doc, 'div', 'head'));
  head.appendChild(el(doc, 'span', null, `Today · ${typeof s.label === 'string' ? s.label : ''}`));
  head.appendChild(button(doc, '✕', 'x', () => bridge.closeList())).title = 'Close (Esc)';
  const rows = rowsOf(s);
  if (rows.length === 0) box.appendChild(el(doc, 'div', 'empty', 'Nothing filed today.'));
  for (const r of rows) {
    const lr = listRow(r);
    const line = box.appendChild(el(doc, 'div', `row ${r.state}`));
    line.appendChild(el(doc, 'span', 'what', short(lr.text, 70))).title = lr.text;
    line.appendChild(el(doc, 'span', 'when', lr.time));
    line.appendChild(el(doc, 'span', 'where', lr.where));
    const acts = el(doc, 'span', 'mini');
    if (lr.undo) acts.appendChild(button(doc, 'Undo', null, () => bridge.undo(r.id)));
    if (lr.move) acts.appendChild(picker(doc, 'Move to…', pickerOptions(r, titles, { moving: true }), (v) => bridge.move(r.id, v)));
    if (lr.pick) {
      const opts = pickerOptions(r, titles);
      if (opts.length) acts.appendChild(button(doc, 'File it', 'primary', () => bridge.choose(r.id, opts[0].value))).title = opts[0].label;
      acts.appendChild(picker(doc, 'Put it in…', opts, (v) => bridge.choose(r.id, v)));
    }
    if (acts.childElementCount) line.appendChild(acts);
  }
  return box;
}

const api = {
  counterText, placeText, reasonText, pickerOptions, choiceOf, toastModel, resultToast, toastMs, listRow, short, timeOf,
  mountStrip, paintStrip, mountOverlay,
};

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
