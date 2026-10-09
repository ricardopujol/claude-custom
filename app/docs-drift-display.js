'use strict';
/**
 * The "Docs that may be out of date" list (BACKLOG #39 job 2), drawn at the top of the Git panel: what the local model flagged
 * after a merge into develop, each note dismissable. Pure view rules plus one tiny painter.
 *
 *   view({ notes, off }, now) -> null | { title, label, rows: [{ id, doc, sentence, why, commit, subject, age }], note }
 *   html(view)                -> markup ('' for null); every word of the model is escaped
 *   render(el, snapshot, now, { onDismiss(id) })
 *
 * TRUTH RULES
 *   - It is always labelled as a local model's guess ("may be wrong: check the doc"): never mistaken for a verdict.
 *   - When the check is off (Ollama down, model missing, no develop branch...) that is SAID, beside the notes if there are any;
 *     nothing to say at all is no section, never an empty box.
 *   - A missing or backwards time is "time unknown", not time zero (Number(null) is 0).
 *   - Read-only: the only action is Dismiss, which tells the host to hide the note. Nothing here edits a document.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js): the page loads this as a plain <script> that shares one global
 * scope. One name leaves it: `docsDriftDisplay`.
 */
(function (root) {

const MIN = 60_000;
const TITLE = 'Docs that may be out of date';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isStr = (s) => typeof s === 'string';

function ageLabel(at, now) {
  if (!isNum(at) || !isNum(now) || at > now) return 'time unknown';
  const ms = now - at;
  if (ms < MIN) return 'just now';
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < 24 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))} h ago`;
  return `${Math.floor(ms / (24 * 60 * MIN))} d ago`;
}

/** What is wrong, in plain words, or null when nothing is. */
function offNote(off) {
  if (off === null || typeof off !== 'object' || !isStr(off.reason)) return null;
  const model = isStr(off.model) && off.model !== '' ? off.model : 'the local model';
  switch (off.reason) {
    case 'ollama-down': return "Docs check is off: Ollama isn't running.";
    case 'model-missing': return `Docs check is off: model not installed. Run: ollama pull ${model}`;
    case 'failed': return `Docs check couldn't finish${isStr(off.detail) && off.detail !== '' ? ` (${off.detail})` : ''}.`;
    case 'no-develop': return 'Docs check is off: this project has no develop branch to watch.';
    case 'no-docs': return 'Docs check is off: no documentation folder found.';
    default: return `Docs check couldn't run (${off.reason}).`;
  }
}

function view(snapshot, now) {
  const s = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
  const notes = Array.isArray(s.notes) ? s.notes.filter(n => n && isStr(n.id) && isStr(n.doc) && isStr(n.sentence)) : [];
  const note = offNote(s.off === undefined ? null : s.off);
  if (notes.length === 0 && note === null) return null;
  return {
    title: TITLE,
    label: 'local model · may be wrong: check the doc before changing it',
    rows: notes.map(n => ({
      id: n.id, doc: n.doc, sentence: n.sentence, why: isStr(n.why) ? n.why : '', commit: isStr(n.commit) ? n.commit : '',
      subject: isStr(n.subject) ? n.subject : '', age: ageLabel(n.at, now),
    })),
    note,
  };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, c => ESC[c]);

function html(v) {
  if (v === null || v === undefined) return '';
  const rows = v.rows.map(r => `<div class="drift-row">`
    + `<div class="drift-doc"><b>${esc(r.doc)}</b> <span class="drift-meta">${esc(r.commit.slice(0, 9))} ${esc(r.subject)} · ${esc(r.age)}</span>`
    + `<button type="button" class="drift-dismiss" data-drift-dismiss="${esc(r.id)}" title="Hide this note">Dismiss</button></div>`
    + `<div class="drift-sentence">${esc(r.sentence)}</div>`
    + `<div class="drift-why">${esc(r.why)}</div></div>`).join('');
  return `<section class="drift-sec"><h3>${esc(v.title)} <span class="drift-label">${esc(v.label)}</span></h3>`
    + (v.note ? `<div class="drift-note">${esc(v.note)}</div>` : '') + rows + '</section>';
}

const bound = typeof WeakSet === 'function' ? new WeakSet() : null;

function render(el, snapshot, now, { onDismiss } = {}) {
  if (!el) return;
  const v = view(snapshot, now);
  el.hidden = v === null;
  el.innerHTML = html(v);
  if (bound && !bound.has(el)) {
    bound.add(el);
    el.addEventListener('click', (e) => {
      const btn = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-drift-dismiss]') : null;
      if (btn && typeof onDismiss === 'function') onDismiss(btn.getAttribute('data-drift-dismiss'));
    });
  }
}

const api = { view, html, render, offNote, ageLabel };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.docsDriftDisplay = api;

})(typeof window !== 'undefined' ? window : globalThis);
