'use strict';
/**
 * The indexing assistant (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05 (evening)": no
 * model, a verbatim inbox). A note typed into the strip is journaled, then appended to the selected project's backlog
 * `## Inbox` as `- YYYY-MM-DD HH:MM · <verbatim>`; the docs pass (/sync-docs, /checkpoint) files the inbox later.
 * One per claude-custom window, in Electron main (the strip is main's own page).
 *
 *   createIndexingService({ journal, writer, docsFor, now, broadcast, log })
 *     submit(project, text)   -> { ok: true, id, filed: true } | { ok: true, id, filed: false, reason }
 *                              | { ok: false, reason: 'empty' | 'journal-failed' }
 *     tick()                  -> Promise   tries one note again whose backlog was busy or kept changing
 *     undo(id, project)       -> { ok: true } | { ok: false, reason: 'changed', file } | { ok: false, reason }
 *                                project: the selected one; Undo only ever writes that project's own backlog
 *     snapshot(project)       -> (throws when the journal can't be read) { counts: { filed, unfiled }, list: [{ id, text, at, state, reason, undoable }] }
 *
 * THE ORDER: the note is journaled first (nothing is lost), then the backlog is written, then `filed` is journaled.
 * A project with no backlog file gets one made by the first note (#79), the documentation folder and its sync-docs
 * .gitignore block too when it has none, and every note of that project held as `no-backlog` or `no-docs` is filed
 * with it, in the order typed. Not filed: a project folder that isn't there,
 * stays in the list as not filed with its words in the journal for Copy; a backlog that kept changing under the write,
 * stayed busy or couldn't be written is tried again by the tick after RETRY_MS.
 *
 * TWO WINDOWS: the doc write and its event happen under the journal lock after re-reading that the note is still not
 * filed, so a note can't be filed twice by two windows. A tick never throws. The note's words are never logged.
 */

const path = require('path');
const fs = require('fs');
const { fold, listFor, counts, isCurrent } =require('./indexing-journal');
const { stampOf, removeEntry } = require('./indexing-doc');
const { samePath, normPath } = require('./project-layout');
const realWriter = require('./indexing-writer');

const RETRY_MS = 15_000;
const RETRIED = new Set(['conflict', 'write-failed', 'busy']);
// Held because the project had nowhere to file them; filed (in order) once the backlog exists, however it came to.
const HELD = new Set(['no-backlog', 'no-docs']);

const isText = (s) => typeof s === 'string' && s.trim() !== '';
const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };

function createIndexingService({ journal, writer = realWriter, docsFor, now = Date.now, broadcast = () => {}, log = () => {} }) {
  const holds = new Map();          // note id -> time before which the tick doesn't try it again
  const changed = () => { try { broadcast(); } catch { /* a window that went away */ } };

  /** Try to put one unfiled note into `docs`' backlog. -> the writer's result: { ok: true, where, record, result? } | { ok: false, reason } */
  function attempt(n, docs, { append, read }, { look = false } = {}) {
    // Journal the intent BEFORE the write; a note that has one may already be in the doc (the write landed and
    // `filed` didn't), so it is looked for first and never written twice (Dexter F3 / Miguel I2, PR #121). A held
    // note being replayed is always looked for (`look`): its replay may have crashed halfway (PR #138).
    const lookFirst = n.intent || look;
    const others = lookFirst
      ? [...fold(read()).values()].filter(o => o.id !== n.id && o.state === 'filed' && o.record && o.where
        && samePath(o.where.file, docs.backlog)).map(o => o.record)
      : [];
    let found = lookFirst ? writer.findNote({ docs, stamp: stampOf(n.at), text: n.text, others }) : null;
    // No backlog file at all is a definite "the entry isn't there" (a note held that way, or a backlog deleted since):
    // the write below makes the file (#79).
    if (found && !found.ok && found.reason === 'no-backlog') found = null;
    if (found && !found.ok) {
      // The look couldn't read the backlog: that is not "the entry isn't there" (Dexter F1, PR #121). Writing now
      // could put the note in twice, so this attempt ends here and the tick looks again later.
      return { ok: false, reason: found.reason };
    }
    if (found && found.record) return { ok: true, where: { file: docs.backlog }, record: found.record };
    if (!n.intent) append({ ev: 'filing', id: n.id, at: now() });
    return writer.fileNote({ docs, stamp: stampOf(n.at), text: n.text });
  }

  /** Journal what an attempt came to. -> { filed: true } | { filed: false, reason } */
  function settle(n, r, { append }) {
    if (r.ok) {
      append({ ev: 'filed', id: n.id, at: now(), where: r.where, record: r.record });
      holds.delete(n.id);
      return { filed: true };
    }
    if (n.reason !== r.reason) append({ ev: 'unfiled', id: n.id, reason: r.reason, at: now() });
    if (RETRIED.has(r.reason)) holds.set(n.id, now() + RETRY_MS);
    return { filed: false, reason: r.reason };
  }

  /** The notes of `project` held as `no-backlog` or `no-docs` (a backlog or folder that was missing), oldest first. */
  function heldFor(project, exceptId, { read }) {
    return [...fold(read()).values()]
      .filter(o => o.id !== exceptId && o.state === 'unfiled' && HELD.has(o.reason) && samePath(o.project, project))
      .sort((a, b) => a.at - b.at);
  }

  /**
   * The backlog exists: every note held for its project as `no-backlog` is filed, oldest first (#79). Each one is
   * looked for in the file before it is written, so a replay that crashed halfway files the rest without doubling the
   * first; one whose attempt throws is settled as write-failed (the tick retries it), never left silent; and a settle
   * that throws costs only that note, never the note being filed or the others.
   */
  function replayHeld(held, docs, ctx) {
    for (const h of held) {
      let r;
      try { r = attempt(h, docs, ctx, { look: true }); } catch (err) {
        log('[indexing] could not file a held note:', (err && err.message) || String(err));
        r = { ok: false, reason: 'write-failed' };
      }
      try { settle(h, r, ctx); } catch (err) {
        log('[indexing] could not journal a held note:', (err && err.message) || String(err));
      }
    }
  }

  /** Under the journal lock: file one note that isn't filed yet. -> { filed: true } | { filed: false, reason } */
  function fileNow(id) {
    return journal.withLock((ctx) => {
      const n = fold(ctx.read()).get(id);
      if (!n) return { filed: false, reason: 'gone' };
      if (n.state !== 'unfiled') return { filed: n.state === 'filed' };       // another window got there first
      const docs = docsFor(n.project);
      if (!docs || docs.ok !== true) return settle(n, { ok: false, reason: (docs && docs.reason) || 'no-docs' }, ctx);
      // Notes held for this project come first, so the inbox stays in the order they were typed (Dexter F4): the
      // backlog is made now if it isn't there, then they are filed, then this note.
      let made = null;                 // set when the backlog is made here, ahead of this note
      const held = heldFor(n.project, id, ctx);
      if (held.length > 0) {
        if (!fs.existsSync(docs.backlog)) {
          const ens = writer.ensureBacklog(docs);
          if (ens.created === true) made = ens;
        }
        if (fs.existsSync(docs.backlog)) replayHeld(held, docs, ctx);
      }
      let r = attempt(n, docs, ctx);
      if (r.ok && made !== null && r.result !== 'created-backlog' && r.record) {
        r = { ...r, result: 'created-backlog', record: { ...r.record, pristine: writer.pristineOf(docs), ...(made.made ? { made: made.made } : {}) } };
      }
      return settle(n, r, ctx);
    });
  }

  function submit(project, text) {
    if (!isText(text)) return { ok: false, reason: 'empty' };
    let id;
    try {
      id = journal.newId();
      journal.append({ ev: 'note', id, project: String(project), text: text.trim(), at: now() });
    } catch (err) {
      log('[indexing] could not journal a note:', (err && err.message) || String(err));
      return { ok: false, reason: 'journal-failed' };
    }
    let r;
    try { r = fileNow(id); } catch (err) {
      log('[indexing] could not file a note:', (err && err.message) || String(err));
      holds.set(id, now() + RETRY_MS);
      r = { filed: false, reason: 'write-failed' };
    }
    changed();
    return r.filed ? { ok: true, id, filed: true } : { ok: true, id, filed: false, reason: r.reason };
  }

  // Once a day (the first tick, then whenever the local day changes) the journal keeps only what the list can show:
  // today's notes and any not filed (Miguel S1, PR #121).
  let rotatedDay = null;
  function rotate(t) {
    const day = new Date(t).toDateString();
    if (day === rotatedDay) return;
    journal.compact((n) => n.state === 'unfiled' || isCurrent(n, t));
    rotatedDay = day;
  }

  /**
   * A backlog that exists next to notes held as `no-backlog` / `no-docs` (made by hand, or by a note that then failed to file):
   * they are filed now, not only when a note happens to create the file (Dexter F1 / Miguel 1).
   */
  function replayStranded(notes) {
    const projects = new Map();
    for (const n of notes) if (n.state === 'unfiled' && HELD.has(n.reason)) projects.set(normPath(n.project), n.project);
    let did = false;
    for (const project of projects.values()) {
      journal.withLock((ctx) => {
        const docs = docsFor(project);
        if (!docs || docs.ok !== true || !fs.existsSync(docs.backlog)) return;
        const held = heldFor(project, null, ctx);
        if (held.length > 0) { replayHeld(held, docs, ctx); did = true; }
      });
    }
    return did;
  }

  async function tick() {
    try {
      const t = now();
      // Its own try: a rotation that fails (the lock busy) must not keep a note from being filed.
      try { rotate(t); } catch (err) { log('[indexing] journal rotation failed:', (err && err.message) || String(err)); }
      const notes = [...fold(journal.read()).values()];
      const due = notes
        // A reason the tick retries, or none at all: journaled but never decided (a crash, a journal that threw).
        .filter(n => n.state === 'unfiled' && (n.reason === null || RETRIED.has(n.reason)) && !(holds.get(n.id) > t))
        .sort((a, b) => a.at - b.at)[0];
      if (due) fileNow(due.id);
      const replayed = replayStranded(due ? [...fold(journal.read()).values()] : notes);
      if (due || replayed) changed();
    } catch (err) {
      log('[indexing] tick failed:', (err && err.message) || String(err));
    }
  }

  function undo(id, project) {
    try {
      const r = journal.withLock(({ append, read }) => {
        const n = fold(read()).get(id);
        if (!n || n.state !== 'filed') return { ok: false, reason: 'not-filed' };
        // The journal is install-wide and any window writes it: the file Undo touches is re-derived from the selected
        // project, never taken from the row (Miguel I4, PR #121).
        if (!samePath(n.project, project)) return { ok: false, reason: 'other-project' };
        const docs = docsFor(project);
        if (!docs || docs.ok !== true || !samePath(n.where.file, docs.backlog)) return { ok: false, reason: 'bad-record' };
        const u = writer.undoNote(docs.backlog, n.record);
        if (!u.ok) return { ok: false, reason: u.reason, file: n.where.file };
        append({ ev: 'undone', id, at: now() });
        return { ok: true };
      });
      changed();
      return r;
    } catch (err) {
      log('[indexing] undo failed:', (err && err.message) || String(err));
      return { ok: false, reason: 'error' };
    }
  }

  function snapshot(project) {
    // A journal that can't be read throws: a confident "no notes" would cancel a pending toast for good (Dexter F5,
    // PR #121). The caller keeps what it last showed.
    const notes = fold(journal.read());
    const t = now();
    let docs = null;
    try { docs = docsFor(project); } catch { docs = null; }
    const own = (f) => !!docs && docs.ok === true && samePath(f, docs.backlog);
    const files = new Map();
    const text = (f) => { if (!files.has(f)) files.set(f, readOr(f, null)); return files.get(f); };
    const list = listFor(notes, project, t).map(n => ({
      id: n.id, text: n.text, at: n.at, state: n.state, reason: n.reason,
      file: n.where ? path.basename(n.where.file) : null,
      createdBacklog: n.state === 'filed' && !!n.record && typeof n.record.pristine === 'string',
      undoable: n.state === 'filed' && own(n.where.file) && text(n.where.file) !== null
        && removeEntry(text(n.where.file), n.record).ok === true,
    }));
    return { counts: counts(notes, project, t), list };
  }

  return { submit, tick, undo, snapshot };
}

module.exports = { createIndexingService, RETRY_MS };
