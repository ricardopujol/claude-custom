'use strict';
/**
 * Where "docs drift" notes are kept (BACKLOG #39 job 2): one JSON file per project in the harness state folder.
 *
 *   createDriftStore({ file, rename }) -> { read(), open(), setProcessed(sha), addNotes(commit, flags, at), dismiss(id) }
 *   read()  -> { processed: sha | null, notes: [note] }      every note, dismissed ones too
 *   open()  -> [note]                                         the ones not dismissed, newest first
 *   note    -> { id, doc, sentence, why, commit (12 hex), subject, at, dismissed }
 *   writes  -> { ok: true } | { ok: false, error }
 *
 * EVERY CALL READS THE FILE. Each tab of a project is its own host, and they share this file, so a dismissal made in one
 * window has to be seen by the others and a merge one host already handled must not be handled again. The file is small.
 *
 * A DISMISSED NOTE STAYS (as dismissed) so finding the same sentence again, on a re-run or by another host, does not bring
 * it back. Its id is a hash of commit + doc + sentence. The file is capped (MAX_NOTES): dismissed notes go first, then the oldest.
 *
 * TRUTH RULES. A file that isn't ours (not JSON, wrong shape) reads as empty and the next write replaces it; a write is a temp
 * file renamed over the target, never the target opened with 'w'; a failed write is REPORTED and leaves the old file whole;
 * a missing time is not time zero (Number(null) is 0), it is refused. It never touches a project's documents.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renameWithRetry } = require('./atomic-write');

const MAX_NOTES = 200;
const FILE_MAX = 1024 * 1024;
const SENTENCE_MAX = 400;
const WHY_MAX = 300;
const SUBJECT_MAX = 120;
const DOC_MAX = 120;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isStr = (s) => typeof s === 'string';
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const SHA = /^[0-9a-f]{7,40}$/i;

const noteId = (sha, doc, sentence) => crypto.createHash('sha1').update(`${sha}\0${doc}\0${sentence}`).digest('hex').slice(0, 12);

function shapeNote(n) {
  if (!isObject(n) || !isStr(n.id) || !isStr(n.doc) || !isStr(n.sentence) || !isStr(n.why) || !isStr(n.commit)) return null;
  if (n.id === '' || n.doc === '' || n.sentence === '' || n.why === '' || !isNum(n.at)) return null;
  return {
    id: n.id, doc: n.doc.slice(0, DOC_MAX), sentence: n.sentence.slice(0, SENTENCE_MAX), why: n.why.slice(0, WHY_MAX),
    commit: n.commit.slice(0, 12), subject: isStr(n.subject) ? n.subject.slice(0, SUBJECT_MAX) : '', at: n.at, dismissed: n.dismissed === true,
  };
}

function createDriftStore({ file, rename = renameWithRetry } = {}) {
  function load() {
    try {
      if (fs.statSync(file).size > FILE_MAX) return { processed: null, notes: [] };
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObject(o)) return { processed: null, notes: [] };
      const notes = Array.isArray(o.notes) ? o.notes.map(shapeNote).filter(Boolean) : [];
      const seen = new Set();
      const unique = notes.filter(n => (seen.has(n.id) ? false : (seen.add(n.id), true)));
      return { processed: isStr(o.processed) && SHA.test(o.processed) ? o.processed : null, notes: unique };
    } catch {
      return { processed: null, notes: [] };
    }
  }

  function save(state) {
    let notes = state.notes;
    if (notes.length > MAX_NOTES) {
      const drop = notes.length - MAX_NOTES;
      const order = [...notes].sort((a, b) => (a.dismissed === b.dismissed ? a.at - b.at : (a.dismissed ? -1 : 1)));
      const gone = new Set(order.slice(0, drop).map(n => n.id));
      notes = notes.filter(n => !gone.has(n.id));
    }
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ processed: state.processed, notes }) + '\n');
      rename(tmp, file);
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* it was never written */ }
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  const read = () => load();
  const open = () => load().notes.filter(n => !n.dismissed).sort((a, b) => b.at - a.at);

  function setProcessed(sha) {
    if (!isStr(sha) || !SHA.test(sha)) return { ok: false, error: 'not a commit id' };
    const state = load();
    return save({ ...state, processed: sha });
  }

  function addNotes(commit, flags, at) {
    if (!isNum(at)) return { ok: false, error: 'no usable time' };
    if (!isObject(commit) || !isStr(commit.sha) || !SHA.test(commit.sha)) return { ok: false, error: 'not a commit id' };
    const state = load();
    const have = new Set(state.notes.map(n => n.id));
    let added = 0;
    for (const f of Array.isArray(flags) ? flags : []) {
      if (!isObject(f) || !isStr(f.doc) || !isStr(f.sentence) || !isStr(f.why)) continue;
      const id = noteId(commit.sha, f.doc, f.sentence);
      if (have.has(id)) continue;
      const note = shapeNote({ id, doc: f.doc, sentence: f.sentence, why: f.why, commit: commit.sha, subject: commit.subject, at, dismissed: false });
      if (!note) continue;
      have.add(id);
      state.notes.push(note);
      added++;
    }
    if (added === 0) return { ok: true, added: 0 };
    const r = save(state);
    return r.ok ? { ok: true, added } : r;
  }

  function dismiss(id) {
    const state = load();
    const note = state.notes.find(n => n.id === id);
    if (!note) return { ok: false, error: 'unknown note' };
    if (note.dismissed) return { ok: true };
    note.dismissed = true;
    return save(state);
  }

  return { read, open, setProcessed, addNotes, dismiss };
}

module.exports = { createDriftStore, noteId, MAX_NOTES };
