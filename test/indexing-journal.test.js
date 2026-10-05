'use strict';
/**
 * The indexing assistant's journal (host/indexing-journal.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Claude's call"
 * 6 and 9): every note is written here FIRST, then what happened to it, as an append-only event log
 * (.harness/state/indexing-notes.jsonl). Folding the events gives each note's state; the strip's list is today's notes
 * for one project, newest first, last 20, plus any still waiting for a place.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createJournal, fold, listFor, counts } = require('../host/indexing-journal');

const P = 'C:\\proj\\a';
const DAY = Date.UTC(2026, 9, 5, 15, 0, 0);
const at = (minutes) => DAY + minutes * 60_000;

test('append + read: events come back in order; the file is created with its folder', () => {
  const dir = tmpDir('cc-ij-');
  const j = createJournal({ file: path.join(dir, 'state', 'indexing-notes.jsonl') });
  j.append({ ev: 'note', id: 'n1', project: P, text: 'hello', at: at(0) });
  j.append({ ev: 'waiting', id: 'n1', reason: 'ollama-down', at: at(1) });
  assert.deepStrictEqual(j.read().map(e => e.ev), ['note', 'waiting']);
  assert.ok(fs.readFileSync(path.join(dir, 'state', 'indexing-notes.jsonl'), 'utf8').endsWith('\n'));
});

test('read: a torn last line and a garbage line are skipped, the rest is kept', () => {
  const dir = tmpDir('cc-ij-');
  const file = path.join(dir, 'j.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ev: 'note', id: 'n1', project: P, text: 'a', at: 1 }) + '\nnot json\n[1]\n{"ev":"note","id":"n2"');
  assert.deepStrictEqual(createJournal({ file }).read().map(e => e.id), ['n1']);
});

test('read: no file yet is no events', () => {
  assert.deepStrictEqual(createJournal({ file: path.join(tmpDir('cc-ij-'), 'none.jsonl') }).read(), []);
});

test('withLock: runs the function holding the lock, returns its value, and releases it', () => {
  const dir = tmpDir('cc-ij-');
  const file = path.join(dir, 'j.jsonl');
  const j = createJournal({ file });
  const v = j.withLock(() => { assert.ok(fs.existsSync(file + '.lock')); return 7; });
  assert.strictEqual(v, 7);
  assert.strictEqual(fs.existsSync(file + '.lock'), false);
});

test('withLock: the body appends and reads through what it is handed, under the one lock (no second lock taken)', () => {
  const file = path.join(tmpDir('cc-ij-'), 'j.jsonl');
  const j = createJournal({ file });
  const seen = j.withLock(({ append, read }) => {
    append({ ev: 'note', id: 'n1', project: P, text: 'a', at: 1 });
    return read().length;
  });
  assert.strictEqual(seen, 1);
  assert.strictEqual(j.read().length, 1);
});

test('a new id is minted for every note and never repeats', () => {
  const j = createJournal({ file: path.join(tmpDir('cc-ij-'), 'j.jsonl') });
  const ids = new Set(Array.from({ length: 200 }, () => j.newId()));
  assert.strictEqual(ids.size, 200);
});

// --- fold ------------------------------------------------------------------------------------------------------------

const where = { file: 'B.md', target: 'new', kind: 'idea', title: 'T', n: 72, label: 'new #72' };
const record = { offset: 10, inserted: 'x', prefixHash: 'h' };

test('fold: a note starts waiting, and each later event moves it on', () => {
  const notes = fold([
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'asking', id: 'n1', at: at(1), guess: { kind: 'idea', target: 'new', title: 'T', sure: false }, options: [61] },
    { ev: 'filed', id: 'n1', at: at(2), where, record },
  ]);
  const n = notes.get('n1');
  assert.strictEqual(n.state, 'filed');
  assert.deepStrictEqual(n.where, where);
  assert.deepStrictEqual(n.record, record);
  assert.strictEqual(n.text, 'a');
  assert.strictEqual(n.filedAt, at(2));
});

test('fold: waiting keeps its reason; asking keeps the guess and options; undone ends a filing; a move files again', () => {
  const evs = [
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'waiting', id: 'n1', reason: 'battery', at: at(1) },
  ];
  assert.deepStrictEqual([fold(evs).get('n1').state, fold(evs).get('n1').reason], ['waiting', 'battery']);
  evs.push({ ev: 'asking', id: 'n1', at: at(2), guess: { kind: 'bug', target: 61 }, options: [61, 63] });
  assert.deepStrictEqual(fold(evs).get('n1').options, [61, 63]);
  assert.strictEqual(fold(evs).get('n1').reason, null);
  evs.push({ ev: 'filed', id: 'n1', at: at(3), where, record });
  evs.push({ ev: 'undone', id: 'n1', at: at(4) });
  assert.strictEqual(fold(evs).get('n1').state, 'undone');
  assert.strictEqual(fold(evs).get('n1').record, null);
  evs.push({ ev: 'filed', id: 'n1', at: at(5), where: { ...where, target: 61 }, record });
  assert.strictEqual(fold(evs).get('n1').state, 'filed');
});

test('fold: events for an unknown note, unknown kinds of event and malformed notes are ignored', () => {
  const notes = fold([
    { ev: 'filed', id: 'ghost', at: 1, where, record },
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'teleported', id: 'n1', at: 2 },
    { ev: 'note', id: 'n2', project: P, text: '', at: 3 },
    { ev: 'note', id: 'n3', project: 5, text: 'x', at: 3 },
    { ev: 'note', id: 'n4', project: P, text: 'x', at: null },
    null, 'x',
  ]);
  assert.deepStrictEqual([...notes.keys()], ['n1']);
  assert.strictEqual(notes.get('n1').state, 'waiting');
});

test('fold: a second note event with the same id does not reset a note', () => {
  const notes = fold([
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'filed', id: 'n1', at: at(1), where, record },
    { ev: 'note', id: 'n1', project: P, text: 'b', at: at(2) },
  ]);
  assert.strictEqual(notes.get('n1').state, 'filed');
  assert.strictEqual(notes.get('n1').text, 'a');
});

// --- the list --------------------------------------------------------------------------------------------------------

function notesOf(list) {
  const evs = [];
  for (const [id, project, minutes, state] of list) {
    evs.push({ ev: 'note', id, project, text: id, at: at(minutes) });
    if (state === 'filed') evs.push({ ev: 'filed', id, at: at(minutes), where, record });
    if (state === 'asking') evs.push({ ev: 'asking', id, at: at(minutes), guess: {}, options: [] });
  }
  return fold(evs);
}

test('listFor: today\'s notes for this project (path spelling ignored), newest first', () => {
  const notes = notesOf([['a', P, 0, 'filed'], ['b', 'c:/proj/A/', 5, 'filed'], ['c', 'C:\\other', 6, 'filed'], ['d', P, -24 * 60, 'filed']]);
  assert.deepStrictEqual(listFor(notes, P, at(10)).map(n => n.id), ['b', 'a']);
});

test('listFor: a note still waiting or asking shows whatever day it was written', () => {
  const notes = notesOf([['old-wait', P, -3 * 24 * 60, 'waiting'], ['old-ask', P, -2 * 24 * 60, 'asking'], ['a', P, 0, 'filed']]);
  assert.deepStrictEqual(listFor(notes, P, at(10)).map(n => n.id), ['a', 'old-ask', 'old-wait']);
});

test('listFor: at most 20', () => {
  const notes = notesOf(Array.from({ length: 30 }, (_, i) => [`n${i}`, P, i, 'filed']));
  const l = listFor(notes, P, at(60));
  assert.strictEqual(l.length, 20);
  assert.strictEqual(l[0].id, 'n29');
});

test('counts: today\'s filed, waiting and asking for this project', () => {
  const notes = notesOf([['a', P, 0, 'filed'], ['b', P, 1, 'filed'], ['c', P, 2, 'waiting'], ['d', P, 3, 'asking'], ['e', 'C:\\x', 4, 'waiting'], ['f', P, -24 * 60, 'filed']]);
  assert.deepStrictEqual(counts(notes, P, at(10)), { filed: 2, waiting: 1, asking: 1 });
});
