'use strict';
/**
 * The indexing assistant's journal (host/indexing-journal.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised
 * 2026-10-05 (evening)"): every note is written here FIRST, then what happened to it, as an append-only event log
 * (.harness/state/indexing-notes.jsonl). Folding the events gives each note's state; the strip's list is today's notes
 * for one project, newest first, last 20, plus any not filed.
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
  j.append({ ev: 'unfiled', id: 'n1', reason: 'no-backlog', at: at(1) });
  assert.deepStrictEqual(j.read().map(e => e.ev), ['note', 'unfiled']);
  assert.ok(fs.readFileSync(path.join(dir, 'state', 'indexing-notes.jsonl'), 'utf8').endsWith('\n'));
});

test('read: a torn last line and a garbage line are skipped, the rest is kept', () => {
  const dir = tmpDir('cc-ij-');
  const file = path.join(dir, 'j.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ev: 'note', id: 'n1', project: P, text: 'a', at: 1 }) + '\nnot json\n[1]\n{"ev":"note","id":"n2"');
  assert.deepStrictEqual(createJournal({ file }).read().map(e => e.id), ['n1']);
});

test('an append after a torn last line starts on its own line, so the new note is not lost (Miguel B1 / Dexter F2, PR #121)', () => {
  const file = path.join(tmpDir('cc-ij-'), 'j.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ev: 'note', id: 'n1', project: P, text: 'a', at: 1 }) + '\n{"ev":"unfiled","id":"n1","rea');
  const j = createJournal({ file });
  j.append({ ev: 'note', id: 'n2', project: P, text: 'b', at: 2 });
  assert.deepStrictEqual([...fold(j.read()).keys()], ['n1', 'n2']);
  j.withLock(({ append }) => append({ ev: 'note', id: 'n3', project: P, text: 'c', at: 3 }));
  assert.deepStrictEqual([...fold(j.read()).keys()], ['n1', 'n2', 'n3'], 'and a well-ended file gets no blank line');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('\n\n'));
});

test('compact: keeps every event of the notes `keep` says, in order, drops the rest and torn lines; temp + rename (Miguel S1)', () => {
  const dir = tmpDir('cc-ij-');
  const file = path.join(dir, 'j.jsonl');
  const j = createJournal({ file });
  j.append({ ev: 'note', id: 'old', project: P, text: 'a', at: 1 });
  j.append({ ev: 'note', id: 'new', project: P, text: 'b', at: 2 });
  j.append({ ev: 'filed', id: 'old', at: 3, where: { file: 'x' }, record: null });
  j.append({ ev: 'unfiled', id: 'new', reason: 'no-backlog', at: 4 });
  fs.appendFileSync(file, '{"ev":"torn');
  const r = j.compact((n) => n.id === 'new');
  assert.deepStrictEqual(r, { ok: true, kept: 1, dropped: 1 });
  assert.deepStrictEqual(j.read().map(e => `${e.ev}:${e.id}`), ['note:new', 'unfiled:new']);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
  assert.strictEqual(fs.existsSync(file + '.lock'), false);
});

test('compact: no journal yet is nothing to do', () => {
  assert.deepStrictEqual(createJournal({ file: path.join(tmpDir('cc-ij-'), 'none.jsonl') }).compact(() => true), { ok: true, kept: 0, dropped: 0 });
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

const where = { file: 'B.md' };
const record = { entry: '- S · a\n', offset: 10, lead: '', sep: '' };

test('fold: a note starts unfiled, and each later event moves it on', () => {
  const notes = fold([
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'filed', id: 'n1', at: at(2), where, record },
  ]);
  const n = notes.get('n1');
  assert.strictEqual(n.state, 'filed');
  assert.deepStrictEqual(n.where, where);
  assert.deepStrictEqual(n.record, record);
  assert.strictEqual(n.text, 'a');
  assert.strictEqual(n.filedAt, at(2));
});

test('fold: unfiled keeps its reason; undone ends a filing; only a filed note can be undone', () => {
  const evs = [
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'undone', id: 'n1', at: at(1) },
    { ev: 'unfiled', id: 'n1', reason: 'no-backlog', at: at(1) },
  ];
  assert.deepStrictEqual([fold(evs).get('n1').state, fold(evs).get('n1').reason], ['unfiled', 'no-backlog']);
  evs.push({ ev: 'filed', id: 'n1', at: at(3), where, record });
  assert.strictEqual(fold(evs).get('n1').reason, null);
  evs.push({ ev: 'undone', id: 'n1', at: at(4) });
  assert.strictEqual(fold(evs).get('n1').state, 'undone');
  assert.strictEqual(fold(evs).get('n1').record, null);
});

test('fold: a filed event with no record is still filed (it just can\'t be undone), so it is never filed again (Miguel B2, PR #121)', () => {
  const n = fold([
    { ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) },
    { ev: 'filed', id: 'n1', at: at(1), where, record: null },
  ]).get('n1');
  assert.deepStrictEqual([n.state, n.record], ['filed', null]);
  const noWhere = fold([{ ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) }, { ev: 'filed', id: 'n1', at: at(1), record: null }]).get('n1');
  assert.strictEqual(noWhere.state, 'unfiled', 'a filed event that names no file is not one');
});

test('fold: a filing intent marks the note (its write may have happened) and leaves it unfiled until filed', () => {
  const evs = [{ ev: 'note', id: 'n1', project: P, text: 'a', at: at(0) }, { ev: 'filing', id: 'n1', at: at(1) }];
  assert.deepStrictEqual([fold(evs).get('n1').state, fold(evs).get('n1').intent], ['unfiled', true]);
  evs.push({ ev: 'filed', id: 'n1', at: at(2), where, record });
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
  assert.strictEqual(notes.get('n1').state, 'unfiled');
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
  }
  return fold(evs);
}

test('listFor: today\'s notes for this project (path spelling ignored), newest first', () => {
  const notes = notesOf([['a', P, 0, 'filed'], ['b', 'c:/proj/A/', 5, 'filed'], ['c', 'C:\\other', 6, 'filed'], ['d', P, -24 * 60, 'filed']]);
  assert.deepStrictEqual(listFor(notes, P, at(10)).map(n => n.id), ['b', 'a']);
});

test('listFor: a note not filed shows whatever day it was written (its words are only there)', () => {
  const notes = notesOf([['old', P, -3 * 24 * 60, 'unfiled'], ['a', P, 0, 'filed']]);
  assert.deepStrictEqual(listFor(notes, P, at(10)).map(n => n.id), ['a', 'old']);
});

test('listFor: at most 20', () => {
  const notes = notesOf(Array.from({ length: 30 }, (_, i) => [`n${i}`, P, i, 'filed']));
  const l = listFor(notes, P, at(60));
  assert.strictEqual(l.length, 20);
  assert.strictEqual(l[0].id, 'n29');
});

test('counts: today\'s filed, and every note not filed, for this project', () => {
  const notes = notesOf([['a', P, 0, 'filed'], ['b', P, 1, 'filed'], ['c', P, -3 * 24 * 60, 'unfiled'], ['e', 'C:\\x', 4, 'unfiled'], ['f', P, -24 * 60, 'filed']]);
  assert.deepStrictEqual(counts(notes, P, at(10)), { filed: 2, unfiled: 1 });
});
