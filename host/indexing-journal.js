'use strict';
/**
 * The indexing assistant's journal (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)": a verbatim inbox).
 *
 *   createJournal({ file }) -> { append(event), read(), withLock(fn), newId() }
 *   fold(events)            -> Map<id, note>   each note's state, from its events in order (pure)
 *   listFor(notes, project, now) -> the strip's list: today's notes for the project plus any not filed, newest first,
 *                                   at most 20
 *   counts(notes, project, now)  -> { filed (today), unfiled }
 *
 * NOTHING IS LOST: a note is appended here BEFORE its backlog is touched, so a note that couldn't be filed (no backlog
 * file, a backlog that kept changing) still has its words here, for the list's Copy. Every later step is another event:
 *   note     { id, project, text, at }          the note, verbatim; it starts unfiled
 *   unfiled  { id, reason, at }                 why it isn't in the inbox
 *   filed    { id, at, where: { file }, record: { entry, offset, lead, sep } }   in the inbox (host/indexing-doc.js)
 *   undone   { id, at }                         the entry was taken back out exactly
 * One file for every project (.harness/state is install-wide): each note carries its project root, and "per project"
 * is a filter.
 *
 * Appends go through host/file-lock.js, because every claude-custom window has its own service and they share this
 * file. A torn last line (a crash mid-append) is skipped, never fatal. The note's words are never logged.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withFileLock } = require('./file-lock');
const { normPath } = require('./project-layout');

const LIST_MAX = 20;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isTime = (n) => typeof n === 'number' && Number.isFinite(n);
const isText = (s) => typeof s === 'string' && s.trim() !== '';

function createJournal({ file }) {
  const lockFile = file + '.lock';

  /** Does the file end mid-line (a crash mid-append)? Then the next event must start on a line of its own. */
  function endsTorn() {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch {
      return false;                        // no file yet
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
    }
  }

  function appendUnlocked(event) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Glued onto a torn fragment, the event would be unreadable and the note lost (Miguel B1 / Dexter F2, PR #121).
    fs.appendFileSync(file, (endsTorn() ? '\n' : '') + JSON.stringify(event) + '\n', 'utf8');
  }

  function withLock(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withFileLock(lockFile, fn);
  }

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try { const e = JSON.parse(line); if (isObject(e)) out.push(e); } catch { /* a torn or foreign line */ }
    }
    return out;
  }

  return {
    // An append from outside a withLock takes the lock itself; inside one, `withLock(() => j.append(...))` would
    // deadlock on the same lock, so the locked body gets appendUnlocked as its argument.
    append: (event) => withLock(() => appendUnlocked(event)),
    withLock: (fn) => withLock(() => fn({ append: appendUnlocked, read })),
    read,
    newId: () => crypto.randomBytes(9).toString('hex'),
  };
}

function fold(events) {
  const notes = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!isObject(e) || typeof e.id !== 'string') continue;
    if (e.ev === 'note') {
      if (notes.has(e.id) || !isText(e.text) || typeof e.project !== 'string' || !isTime(e.at)) continue;
      notes.set(e.id, {
        id: e.id, project: e.project, text: e.text, at: e.at,
        state: 'unfiled', reason: null, where: null, record: null, filedAt: null,
      });
      continue;
    }
    const n = notes.get(e.id);
    if (!n) continue;
    if (e.ev === 'unfiled') {
      if (n.state === 'filed') continue;
      n.state = 'unfiled';
      n.reason = typeof e.reason === 'string' ? e.reason : null;
    } else if (e.ev === 'filed') {
      if (!isObject(e.where) || !isObject(e.record)) continue;
      n.state = 'filed';
      n.reason = null;
      n.where = e.where;
      n.record = e.record;
      n.filedAt = isTime(e.at) ? e.at : null;
    } else if (e.ev === 'undone') {
      if (n.state !== 'filed') continue;
      n.state = 'undone';
      n.record = null;
    }
  }
  return notes;
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function ofProject(notes, project) {
  const key = normPath(project);
  return [...notes.values()].filter(n => key !== null && normPath(n.project) === key);
}

function listFor(notes, project, now) {
  return ofProject(notes, project)
    .filter(n => n.state === 'unfiled' || sameDay(n.at, now))
    .sort((a, b) => b.at - a.at)
    .slice(0, LIST_MAX);
}

function counts(notes, project, now) {
  const mine = ofProject(notes, project);
  return {
    filed: mine.filter(n => n.state === 'filed' && sameDay(n.at, now)).length,
    unfiled: mine.filter(n => n.state === 'unfiled').length,
  };
}

module.exports = { createJournal, fold, listFor, counts, LIST_MAX };
