'use strict';
/**
 * The indexing assistant (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md): a note typed into the strip is
 * journaled, classified by the local model and filed into the project's backlog or history, with an exact Undo.
 * One per claude-custom window, in Electron main (the strip is main's own page).
 *
 *   createIndexingService({ journal, ollama, slot, onBattery, writer, docsFor, mode, now, broadcast, log })
 *     submit(project, text)    -> { ok: true, id } | { ok: false, reason: 'empty' | 'journal-failed' }
 *     tick()                   -> Promise   files the oldest waiting note it can (one job at a time)
 *     choose(id, { target, kind? }) -> { ok: true } | { ok: false, reason }   an asking note, filed where it was picked
 *     undo(id)                 -> { ok: true } | { ok: false, reason: 'changed', file } | { ok: false, reason }
 *     move(id, { target, kind? }) -> undo, then file there
 *     snapshot(project)        -> { mode, counts: { filed, waiting, asking }, list: [row] }
 *
 * THE ORDER OF A NOTE: journaled first (nothing is lost), then it waits until it can be filed. #105's rules for a local
 * job: never on battery (only a real `true` pauses), ONE GPU job across every window and every tab's summary (the
 * shared slot file), and Ollama that's off is retried once a minute, not hammered. The reason it waits is journaled once
 * per change of reason, and the strip shows it ("1 waiting").
 *
 * PROPOSE OR DIRECT (the accuracy gate): `mode()` says which. In propose mode, or when the answer isn't sure, the note
 * is `asking`: the strip shows the guess and a picker, and nothing is written until a choice is made (choose). In direct
 * mode a sure answer is filed at once.
 *
 * TWO WINDOWS, ONE NOTE: only the GPU-slot holder classifies, and the slot is held until the result is journaled; the
 * doc write and its event happen under the journal lock after re-reading that the note is still waiting (or asking).
 * So a note can't be filed twice.
 *
 * A tick never throws. The note's words are never logged.
 */

const path = require('path');
const fs = require('fs');
const { fold, listFor, counts } = require('./indexing-journal');
const { classifyNote, candidates, fallbackTitle, BACKLOG_KINDS } = require('./indexing-classify');
const { parseBacklog, undoInsert, HISTORY_KINDS } = require('./indexing-doc');
const realWriter = require('./indexing-writer');

const HOLD_MS = Object.freeze({
  'ollama-down': 60_000, 'model-missing': 60_000, 'model-error': 60_000, battery: 60_000, busy: 5_000,
  conflict: 15_000, 'write-failed': 15_000, 'no-docs': 60_000, 'no-backlog': 60_000, 'no-history': 60_000,
  'many-build-logs': 60_000, error: 60_000,
});
const MODEL_REASONS = { unreachable: 'ollama-down', timeout: 'ollama-down', 'model-missing': 'model-missing' };
const PICKER_ITEMS = 3;

const isText = (s) => typeof s === 'string' && s.trim() !== '';
const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };

function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** What to write for a hand-picked target: the kind fits the place, a new item gets a title. */
function specFor(note, choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  const prior = [c.kind, note.where && note.where.kind, note.guess && note.guess.kind];
  const pick = (allowed, fallback) => prior.find(k => allowed.includes(k)) || fallback;
  if (c.target === 'history') return { ok: true, spec: { target: 'history', kind: pick(HISTORY_KINDS, 'decision'), text: note.text } };
  const isItem = Number.isInteger(c.target) && c.target > 0;
  if (c.target !== 'new' && !isItem) return { ok: false, reason: 'bad-target' };
  const kind = pick(BACKLOG_KINDS, 'idea');
  if (isItem) return { ok: true, spec: { target: c.target, kind, text: note.text } };
  const titled = [note.where, note.guess].find(g => g && g.target === 'new' && isText(g.title));
  return { ok: true, spec: { target: 'new', kind, title: titled ? titled.title : fallbackTitle(note.text), text: note.text } };
}

function createIndexingService({
  journal, ollama, slot, onBattery = async () => null, writer = realWriter, docsFor, mode = () => 'propose',
  now = Date.now, broadcast = () => {}, log = () => {},
}) {
  const holds = new Map();          // note id -> time before which it isn't tried again
  let busy = null;

  const notesNow = () => fold(journal.read());
  const changed = () => { try { broadcast(); } catch { /* a window that went away */ } };

  function submit(project, text) {
    if (!isText(text)) return { ok: false, reason: 'empty' };
    try {
      const id = journal.newId();
      journal.append({ ev: 'note', id, project: String(project), text: text.trim(), at: now() });
      changed();
      return { ok: true, id };
    } catch (err) {
      log('[indexing] could not journal a note:', (err && err.message) || String(err));
      return { ok: false, reason: 'journal-failed' };
    }
  }

  /** Under the journal lock: journal `reason` for a waiting note, once per change, and hold it. */
  function wait(id, reason) {
    holds.set(id, now() + (HOLD_MS[reason] || HOLD_MS.error));
    journal.withLock(({ append, read }) => {
      const n = fold(read()).get(id);
      if (n && n.state === 'waiting' && n.reason !== reason) append({ ev: 'waiting', id, reason, at: now() });
    });
    changed();
  }

  function nextWaiting() {
    const t = now();
    const waiting = [...notesNow().values()].filter(n => n.state === 'waiting' && !(holds.get(n.id) > t));
    waiting.sort((a, b) => a.at - b.at);
    return waiting[0] || null;
  }

  async function job(note) {
    const docs = docsFor(note.project);
    if (!docs || docs.ok !== true) return wait(note.id, (docs && docs.reason) || 'no-docs');
    if ((await onBattery()) === true) return wait(note.id, 'battery');
    if (!slot.tryAcquire()) return wait(note.id, 'busy');
    try {
      const backlogText = readOr(docs.backlog, '');
      const c = await classifyNote({ note: note.text, backlogText, generate: ollama.generate });
      if (!c.ok) return wait(note.id, MODEL_REASONS[c.reason] || 'model-error');
      const result = c.result;
      const options = candidates(note.text, parseBacklog(backlogText).items, PICKER_ITEMS);
      const outcome = journal.withLock(({ append, read }) => {
        const n = fold(read()).get(note.id);
        if (!n || n.state !== 'waiting') return 'gone';            // another window got there first
        const ask = () => { append({ ev: 'asking', id: note.id, at: now(), guess: result, options }); return 'asked'; };
        if (mode() !== 'direct' || result.sure !== true) return ask();
        const spec = { target: result.target, kind: result.kind, title: result.title, text: n.text };
        const r = writer.fileNote({ docs, spec, date: localDate(now()) });
        if (r.ok) { append({ ev: 'filed', id: note.id, at: now(), where: r.where, record: r.record }); return 'filed'; }
        if (r.reason === 'no-item' || r.reason === 'dup-item') return ask();
        return r.reason;
      });
      if (outcome === 'filed' || outcome === 'asked') { holds.delete(note.id); changed(); return undefined; }
      if (outcome !== 'gone') return wait(note.id, outcome);
      return undefined;
    } finally {
      slot.release();
    }
  }

  async function run() {
    const note = nextWaiting();
    if (!note) return;
    try {
      await job(note);
    } catch (err) {
      // Held like any other wait, so a note that keeps failing isn't retried on every tick.
      log('[indexing] job failed:', (err && err.message) || String(err));
      try { wait(note.id, 'error'); } catch { holds.set(note.id, now() + HOLD_MS.error); }
    }
  }

  function tick() {
    if (busy) return busy;
    busy = Promise.resolve()
      .then(run)
      .catch((err) => { log('[indexing] tick failed:', (err && err.message) || String(err)); })
      .finally(() => { busy = null; });
    return busy;
  }

  /** File `note` per `choice` (no model): the event appended under the caller's lock. */
  function fileChoice(note, choice, append) {
    const s = specFor(note, choice);
    if (!s.ok) return s;
    const docs = docsFor(note.project);
    if (!docs || docs.ok !== true) return { ok: false, reason: (docs && docs.reason) || 'no-docs' };
    const r = writer.fileNote({ docs, spec: s.spec, date: localDate(now()) });
    if (r.ok) append({ ev: 'filed', id: note.id, at: now(), where: r.where, record: r.record });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  function guarded(fn) {
    try {
      const r = journal.withLock(fn);
      changed();
      return r;
    } catch (err) {
      log('[indexing] failed:', (err && err.message) || String(err));
      return { ok: false, reason: 'error' };
    }
  }

  function choose(id, choice) {
    return guarded(({ append, read }) => {
      const n = fold(read()).get(id);
      if (!n || n.state !== 'asking') return { ok: false, reason: 'not-asking' };
      return fileChoice(n, choice, append);
    });
  }

  function undoNote(n, append) {
    if (!n || n.state !== 'filed') return { ok: false, reason: 'not-filed' };
    const r = writer.undoWrite(n.where.file, n.record);
    if (!r.ok) return { ok: false, reason: r.reason, file: n.where.file };
    append({ ev: 'undone', id: n.id, at: now() });
    return { ok: true };
  }

  function undo(id) {
    return guarded(({ append, read }) => undoNote(fold(read()).get(id), append));
  }

  function move(id, choice) {
    return guarded(({ append, read }) => {
      const n = fold(read()).get(id);
      if (!specFor(n || { text: '' }, choice).ok) return { ok: false, reason: 'bad-target' };
      const u = undoNote(n, append);
      if (!u.ok) return u;
      const r = fileChoice(n, choice, append);
      if (!r.ok) {
        // The note is out of the doc and must not be lost: it asks for a place again.
        const options = n.guess && Array.isArray(n.options) ? n.options : [];
        append({ ev: 'asking', id, at: now(), guess: n.guess || { kind: n.where.kind, target: n.where.target, title: n.where.title, sure: false }, options });
      }
      return r;
    });
  }

  function snapshot(project) {
    let notes;
    try { notes = notesNow(); } catch { notes = new Map(); }
    const t = now();
    const files = new Map();
    const text = (f) => { if (!files.has(f)) files.set(f, readOr(f, null)); return files.get(f); };
    const list = listFor(notes, project, t).map(n => ({
      id: n.id, text: n.text, at: n.at, state: n.state, reason: n.reason,
      where: n.where ? { target: n.where.target, kind: n.where.kind, title: n.where.title, n: n.where.n, file: path.basename(n.where.file) } : null,
      guess: n.guess, options: n.options,
      undoable: n.state === 'filed' && text(n.where.file) !== null && undoInsert(text(n.where.file), n.record).ok === true,
    }));
    return { mode: mode(), counts: counts(notes, project, t), list, titles: titlesFor(project, list) };
  }

  /** The current titles of every item the list names, for the picker and the places (read now: titles get edited). */
  function titlesFor(project, list) {
    const wanted = new Set();
    for (const r of list) {
      for (const n of r.options || []) wanted.add(n);
      if (r.guess && Number.isInteger(r.guess.target)) wanted.add(r.guess.target);
      if (r.where && Number.isInteger(r.where.target)) wanted.add(r.where.target);
    }
    const out = {};
    if (wanted.size === 0) return out;
    let docs = null;
    try { docs = docsFor(project); } catch { docs = null; }
    if (!docs || docs.ok !== true) return out;
    for (const it of parseBacklog(readOr(docs.backlog, '')).items) {
      if (wanted.has(it.n) && !it.dup) out[it.n] = it.title;
    }
    return out;
  }

  return { submit, tick, choose, undo, move, snapshot };
}

module.exports = { createIndexingService, specFor, localDate, HOLD_MS };
