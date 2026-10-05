'use strict';
/**
 * The indexing assistant's journal (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Claude's call" 6 and 9).
 *
 *   createJournal({ file }) -> { append(event), read(), withLock(fn), newId() }
 *   fold(events)            -> Map<id, note>   each note's state, from its events in order (pure)
 *   listFor(notes, project, now) -> the strip's list: today's notes for the project plus any still waiting or asking,
 *                                   newest first, at most 20
 *   counts(notes, project, now)  -> { filed (today), waiting, asking }
 *
 * NOTHING IS LOST: a note is appended here BEFORE anything else happens to it, and stays here while Ollama is off, the
 * machine is on battery or the GPU slot is busy. Every later step is another event:
 *   note     { id, project, text, at }                       the note, verbatim; it starts waiting
 *   waiting  { id, reason, at }                              why it hasn't been filed yet
 *   asking   { id, at, guess: { kind, target, title, sure }, options: [N...] }   it needs a place picked
 *   filed    { id, at, where: { file, target, kind, title, n, label }, record: { offset, inserted, prefixHash } }
 *   undone   { id, at }                                      the filing was taken back exactly
 * A Move is `undone` then `filed`. One file for every project (.harness/state is install-wide): each note carries its
 * project root, and "per project" is a filter.
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
const STATES_PENDING = ['waiting', 'asking'];

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isTime = (n) => typeof n === 'number' && Number.isFinite(n);
const isText = (s) => typeof s === 'string' && s.trim() !== '';

function createJournal({ file }) {
  const lockFile = file + '.lock';

  function appendUnlocked(event) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
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
        state: 'waiting', reason: null, guess: null, options: [], where: null, record: null, filedAt: null,
      });
      continue;
    }
    const n = notes.get(e.id);
    if (!n) continue;
    if (e.ev === 'waiting') {
      n.state = 'waiting';
      n.reason = typeof e.reason === 'string' ? e.reason : null;
    } else if (e.ev === 'asking') {
      n.state = 'asking';
      n.reason = null;
      n.guess = isObject(e.guess) ? e.guess : null;
      n.options = Array.isArray(e.options) ? e.options.filter(x => Number.isInteger(x)) : [];
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
    .filter(n => STATES_PENDING.includes(n.state) || sameDay(n.at, now))
    .sort((a, b) => b.at - a.at)
    .slice(0, LIST_MAX);
}

function counts(notes, project, now) {
  const mine = ofProject(notes, project);
  return {
    filed: mine.filter(n => n.state === 'filed' && sameDay(n.at, now)).length,
    waiting: mine.filter(n => n.state === 'waiting').length,
    asking: mine.filter(n => n.state === 'asking').length,
  };
}

module.exports = { createJournal, fold, listFor, counts, LIST_MAX };
