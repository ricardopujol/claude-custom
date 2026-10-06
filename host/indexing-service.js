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
 *     snapshot(project)       -> { counts: { filed, unfiled }, list: [{ id, text, at, state, reason, undoable }] }
 *
 * THE ORDER: the note is journaled first (nothing is lost), then the backlog is written, then `filed` is journaled.
 * Not filed: a project with no backlog file (or no documentation) gets nothing created and the note stays in the list
 * as not filed, its words in the journal for Copy; a backlog that kept changing under the write, stayed busy or couldn't
 * be written,
 * is tried again by the tick after RETRY_MS.
 *
 * TWO WINDOWS: the doc write and its event happen under the journal lock after re-reading that the note is still not
 * filed, so a note can't be filed twice by two windows. A tick never throws. The note's words are never logged.
 */

const path = require('path');
const fs = require('fs');
const { fold, listFor, counts } = require('./indexing-journal');
const { stampOf, removeEntry } = require('./indexing-doc');
const realWriter = require('./indexing-writer');

const RETRY_MS = 15_000;
const RETRIED = new Set(['conflict', 'write-failed', 'busy']);

const isText = (s) => typeof s === 'string' && s.trim() !== '';
const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };

function createIndexingService({ journal, writer = realWriter, docsFor, now = Date.now, broadcast = () => {}, log = () => {} }) {
  const holds = new Map();          // note id -> time before which the tick doesn't try it again
  const changed = () => { try { broadcast(); } catch { /* a window that went away */ } };

  /** Under the journal lock: file one note that isn't filed yet. -> { filed: true } | { filed: false, reason } */
  function fileNow(id) {
    return journal.withLock(({ append, read }) => {
      const n = fold(read()).get(id);
      if (!n) return { filed: false, reason: 'gone' };
      if (n.state !== 'unfiled') return { filed: n.state === 'filed' };       // another window got there first
      const docs = docsFor(n.project);
      let r;
      if (!docs || docs.ok !== true) {
        r = { ok: false, reason: (docs && docs.reason) || 'no-docs' };
      } else {
        // Journal the intent BEFORE the write; a note that has one may already be in the doc (the write landed and
        // `filed` didn't), so it is looked for first and never written twice (Dexter F3 / Miguel I2, PR #121).
        const found = n.intent ? writer.findNote({ docs, stamp: stampOf(n.at), text: n.text }) : null;
        if (found && found.ok && found.record) {
          r = { ok: true, where: { file: docs.backlog }, record: found.record };
        } else {
          if (!n.intent) append({ ev: 'filing', id, at: now() });
          r = writer.fileNote({ docs, stamp: stampOf(n.at), text: n.text });
        }
      }
      if (r.ok) {
        append({ ev: 'filed', id, at: now(), where: r.where, record: r.record });
        holds.delete(id);
        return { filed: true };
      }
      if (n.reason !== r.reason) append({ ev: 'unfiled', id, reason: r.reason, at: now() });
      if (RETRIED.has(r.reason)) holds.set(id, now() + RETRY_MS);
      return { filed: false, reason: r.reason };
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

  async function tick() {
    try {
      const t = now();
      const due = [...fold(journal.read()).values()]
        // A reason the tick retries, or none at all: journaled but never decided (a crash, a journal that threw).
        .filter(n => n.state === 'unfiled' && (n.reason === null || RETRIED.has(n.reason)) && !(holds.get(n.id) > t))
        .sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      fileNow(due.id);
      changed();
    } catch (err) {
      log('[indexing] tick failed:', (err && err.message) || String(err));
    }
  }

  function undo(id) {
    try {
      const r = journal.withLock(({ append, read }) => {
        const n = fold(read()).get(id);
        if (!n || n.state !== 'filed') return { ok: false, reason: 'not-filed' };
        const u = writer.undoNote(n.where.file, n.record);
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
    let notes;
    try { notes = fold(journal.read()); } catch { notes = new Map(); }
    const t = now();
    const files = new Map();
    const text = (f) => { if (!files.has(f)) files.set(f, readOr(f, null)); return files.get(f); };
    const list = listFor(notes, project, t).map(n => ({
      id: n.id, text: n.text, at: n.at, state: n.state, reason: n.reason,
      file: n.where ? path.basename(n.where.file) : null,
      undoable: n.state === 'filed' && text(n.where.file) !== null && removeEntry(text(n.where.file), n.record).ok === true,
    }));
    return { counts: counts(notes, project, t), list };
  }

  return { submit, tick, undo, snapshot };
}

module.exports = { createIndexingService, RETRY_MS };
