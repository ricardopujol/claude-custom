'use strict';
/**
 * The indexing assistant's display decisions (app/indexing-display.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised
 * 2026-10-05 (evening)": a verbatim inbox). Pure: what the counter says, the toast ("Added to the inbox" + the note's
 * first line + Undo for 10 s; why it wasn't filed, with Copy), and the "N filed" list rows.
 */
const test = require('node:test');
const assert = require('node:assert');

const d = require('../app/indexing-display');

// --- the counter -----------------------------------------------------------------------------------------------------

test('counterText: "N filed", and what isn\'t, never a note that isn\'t filed counted as filed', () => {
  assert.strictEqual(d.counterText({ filed: 3, unfiled: 0 }), '3 filed');
  assert.strictEqual(d.counterText({ filed: 0, unfiled: 1 }), '1 not filed');
  assert.strictEqual(d.counterText({ filed: 2, unfiled: 1 }), '2 filed · 1 not filed');
  assert.strictEqual(d.counterText({ filed: 0, unfiled: 0 }), '0 filed');
});

test('counterText: counts that are not numbers are not drawn as numbers', () => {
  assert.strictEqual(d.counterText(null), '0 filed');
  assert.strictEqual(d.counterText({ filed: null, unfiled: '2' }), '0 filed');
});

test('reasonText: why a note isn\'t filed, in words; an unknown reason still says it isn\'t', () => {
  assert.strictEqual(d.reasonText('no-backlog'), 'This project has no backlog file');
  assert.strictEqual(d.reasonText('no-docs'), 'This project has no documentation folder');
  assert.strictEqual(d.reasonText('conflict'), 'The backlog kept changing; it tries again');
  assert.strictEqual(d.reasonText('busy'), 'The backlog was busy; it tries again');
  assert.strictEqual(d.reasonText(null), 'Not filed yet');
  assert.strictEqual(d.reasonText('something-new'), 'Not filed');
});

// --- the toast -------------------------------------------------------------------------------------------------------

test('toastModel: filed is "Added to the inbox" with the note\'s first line, and Undo only while Undo is exact', () => {
  assert.deepStrictEqual(d.toastModel({ state: 'filed', text: 'first line\nsecond', undoable: true }),
    { kind: 'added', line: 'Added to the inbox', note: 'first line', undo: true, copy: false });
  assert.strictEqual(d.toastModel({ state: 'filed', text: 'x', undoable: false }).undo, false);
});

test('toastModel (#79, Ricardo 2026-10-09): the line names only the parts this note created', () => {
  const line = (over) => d.toastModel({ state: 'filed', text: 'x', undoable: true, createdBacklog: true, ...over }).line;
  assert.strictEqual(line({ createdFolder: true, createdIgnore: true }), 'Created documentation\\, the backlog and its .gitignore entry, and filed your note');
  assert.strictEqual(line({ createdFolder: true, createdIgnore: false }), 'Created documentation\\ and the backlog, and filed your note');
  assert.strictEqual(line({ createdFolder: false, createdIgnore: false }), 'Created the backlog and filed your note');
  assert.strictEqual(line({ createdFolder: undefined }), 'Created the backlog and filed your note');
});

test('toastModel (#79): a note that created the backlog says so, and still offers Undo only while Undo is exact', () => {
  assert.deepStrictEqual(d.toastModel({ state: 'filed', text: 'first', undoable: true, createdBacklog: true }),
    { kind: 'added', line: 'Created the backlog and filed your note', note: 'first', undo: true, copy: false });
  assert.strictEqual(d.toastModel({ state: 'filed', text: 'x', undoable: false, createdBacklog: true }).undo, false);
  assert.strictEqual(d.toastModel({ state: 'filed', text: 'x', undoable: true, createdBacklog: false }).line, 'Added to the inbox');
});

test('reasonText (PR #138): several backlog files is said in words', () => {
  assert.strictEqual(d.reasonText('no-backlog-ambiguous'), 'Several backlog files in documentation');
});

test('toastModel: not filed says why, with Copy (the words are only in the journal)', () => {
  assert.deepStrictEqual(d.toastModel({ state: 'unfiled', reason: 'no-backlog', text: 'idea' }),
    { kind: 'unfiled', line: 'Not filed: This project has no backlog file', note: 'idea', undo: false, copy: true });
});

test('toastModel: undone', () => {
  assert.deepStrictEqual(d.toastModel({ state: 'undone', text: 'x' }), { kind: 'undone', line: 'Undone. Removed from the inbox.', note: 'x', undo: false, copy: false });
});

test('resultToast: an Undo that could not happen; anything else that failed; nothing when it worked', () => {
  assert.deepStrictEqual(d.resultToast({ ok: false, reason: 'changed', file: 'C:\\p\\documentation\\P_BACKLOG.md' }),
    { kind: 'cant-undo', line: "Can't undo: the inbox changed since.", open: 'C:\\p\\documentation\\P_BACKLOG.md' });
  assert.deepStrictEqual(d.resultToast({ ok: false, reason: 'busy' }), { kind: 'error', line: "Couldn't undo: The backlog was busy; it tries again." });
  assert.deepStrictEqual(d.resultToast({ ok: false, reason: 'not-filed' }), { kind: 'error', line: "That note isn't in the inbox." });
  assert.strictEqual(d.resultToast({ ok: true }), null);
  assert.strictEqual(d.resultToast(null), null);
});

test('toastMs: 10 s for an added note (the design\'s Undo window) and anything said once; undone 2.5 s', () => {
  assert.strictEqual(d.toastMs('added'), 10_000);
  assert.strictEqual(d.toastMs('unfiled'), 10_000);
  assert.strictEqual(d.toastMs('cant-undo'), 10_000);
  assert.strictEqual(d.toastMs('error'), 10_000);
  assert.strictEqual(d.toastMs('undone'), 2_500);
  assert.strictEqual(d.toastMs('nonsense'), 10_000);
});

// --- the list --------------------------------------------------------------------------------------------------------

test('listRow: the text, the time, the state in words, and Undo or Copy', () => {
  const at = new Date(2026, 9, 5, 9, 7).getTime();
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'filed', undoable: true }),
    { text: 't', time: '09:07', where: 'In the inbox', undo: true, copy: false });
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'filed', undoable: false }).where, 'In the inbox (changed since)');
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'undone' }),
    { text: 't', time: '09:07', where: 'Undone', undo: false, copy: false });
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'unfiled', reason: 'no-backlog' }),
    { text: 't', time: '09:07', where: 'Not filed: This project has no backlog file', undo: false, copy: true });
  assert.strictEqual(d.listRow({ text: 't', at: null, state: 'unfiled' }).time, '');
});

test('short: a long note is cut for one line, never mid surrogate pair', () => {
  assert.strictEqual(d.short('abc', 64), 'abc');
  assert.strictEqual(d.short('x'.repeat(70), 64).length, 64);
  assert.ok(d.short('x'.repeat(70), 64).endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(d.short('a'.repeat(62) + '😀😀', 64)));
});

test('toastModel (#146 D3): a .gitignore that was left alone is said so', () => {
  const m = d.toastModel({ state: 'filed', text: 'x', undoable: true, createdBacklog: true, createdFolder: true, createdIgnore: false, ignoreSkipped: true });
  assert.strictEqual(m.line, "Created documentation\\ and the backlog, and filed your note. Your .gitignore wasn't changed.");
});

test('reasonText (#146 D4): the two permanent create failures have words', () => {
  assert.match(d.reasonText('docs-blocked'), /file named documentation/);
  assert.match(d.reasonText('gitignore-blocked'), /\.gitignore can't be changed/);
});
