'use strict';
/**
 * The indexing assistant's doc writer (host/indexing-writer.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Settled
 * earlier" and "Claude's call" 5 and 7). Temp fixture docs only: never the real documentation/ folder.
 *   - the backlog is rewritten safely: re-read just before, temp file + rename, never truncated; if it changed between
 *     the read and the rename it starts over once, then gives up (the note waits)
 *   - the history is appended (add-history.ps1's way), so a session appending at the same moment is never lost
 *   - Undo removes exactly what was written, or refuses
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const w = require('../host/indexing-writer');

const BACKLOG = '# P — Backlog\n\n## 1. First\nbody\n\n## 2. Second\nmore\n';
const HISTORY = '# P — Build History (append-only)\n\n- 2026-10-04 [note] old\n';

function project({ backlog = BACKLOG, history = HISTORY, buildLog = true, name = 'PROJ' } = {}) {
  const dev = tmpDir('cc-iw-');
  const docs = path.join(dev, 'documentation');
  fs.mkdirSync(docs);
  if (buildLog) fs.writeFileSync(path.join(docs, `${name}_BUILD_LOG.md`), '# log\n');
  if (backlog !== null) fs.writeFileSync(path.join(docs, `${name}_BACKLOG.md`), backlog);
  if (history !== null) fs.writeFileSync(path.join(docs, `${name}_HISTORY.md`), history);
  return { root: dev, dev, docs };
}
const read = (f) => fs.readFileSync(f, 'utf8');
const tempsIn = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

// --- where the docs are ----------------------------------------------------------------------------------------------

test('docsOf: <dev>\\documentation, the name from the one *_BUILD_LOG.md', () => {
  const p = project({ name: 'LYDIA' });
  assert.deepStrictEqual(w.docsOf(p), {
    ok: true, dir: p.docs, name: 'LYDIA',
    backlog: path.join(p.docs, 'LYDIA_BACKLOG.md'), history: path.join(p.docs, 'LYDIA_HISTORY.md'),
  });
});

test('docsOf: no build log falls back to the project folder\'s name, upper case, separators removed (sync-docs\' rule)', () => {
  const p = project({ buildLog: false });
  const root = path.join(path.dirname(p.dev), 'my-proj_x');
  assert.strictEqual(w.docsOf({ root, dev: p.dev }).name, 'MYPROJX');
});

test('docsOf: no documentation folder, or two build logs, says so', () => {
  const dev = tmpDir('cc-iw-');
  assert.deepStrictEqual(w.docsOf({ root: dev, dev }), { ok: false, reason: 'no-docs' });
  const p = project();
  fs.writeFileSync(path.join(p.docs, 'OTHER_BUILD_LOG.md'), '');
  assert.deepStrictEqual(w.docsOf(p), { ok: false, reason: 'many-build-logs' });
  assert.deepStrictEqual(w.docsOf(null), { ok: false, reason: 'no-docs' });
});

// --- filing ----------------------------------------------------------------------------------------------------------

test('a new backlog item is written, and the record undoes it exactly', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'Glow', text: 'tabs glow' }, date: '2026-10-05' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.where, { file: docs.backlog, target: 'new', kind: 'idea', title: 'Glow', n: 3 });
  assert.strictEqual(read(docs.backlog), BACKLOG + '\n## 3. Glow (captured 2026-10-05, indexing assistant)\nRicardo: "tabs glow"\n');
  assert.deepStrictEqual(tempsIn(p.docs), []);
  assert.deepStrictEqual(w.undoWrite(r.where.file, r.record), { ok: true });
  assert.strictEqual(read(docs.backlog), BACKLOG);
});

test('a note on item #N is written at the end of that item', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, spec: { target: 1, kind: 'bug', text: 'it breaks' }, date: 'D' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.where, { file: docs.backlog, target: 1, kind: 'bug', title: null, n: 1 });
  assert.ok(read(docs.backlog).includes('body\n- **Note (D, indexing assistant):** it breaks\n\n## 2.'));
});

test('a history entry is appended in add-history.ps1\'s format, and undone exactly', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, spec: { target: 'history', kind: 'learning', text: 'heredocs eat backslashes' }, date: '2026-10-05' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.where, { file: docs.history, target: 'history', kind: 'learning', title: null, n: null });
  assert.strictEqual(read(docs.history), HISTORY + '- 2026-10-05 [learning] heredocs eat backslashes\n');
  assert.deepStrictEqual(w.undoWrite(docs.history, r.record), { ok: true });
  assert.strictEqual(read(docs.history), HISTORY);
});

test('Undo of a history entry still works after a session appended its own entry after it, and keeps that entry', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, spec: { target: 'history', kind: 'decision', text: 'mine' }, date: 'D' });
  fs.appendFileSync(docs.history, '- D [status] a session\'s line\n');
  assert.deepStrictEqual(w.undoWrite(docs.history, r.record), { ok: true });
  assert.strictEqual(read(docs.history), HISTORY + '- D [status] a session\'s line\n');
});

test('a CRLF backlog stays CRLF', () => {
  const p = project({ backlog: BACKLOG.replace(/\n/g, '\r\n') });
  const docs = w.docsOf(p);
  w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'T', text: 'x' }, date: 'D' });
  assert.ok(!/[^\r]\n/.test(read(docs.backlog)), 'no bare LF');
});

test('refusals: no backlog file, no history file, a missing item, an empty note', () => {
  const p = project({ backlog: null, history: null });
  const docs = w.docsOf(p);
  assert.deepStrictEqual(w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'T', text: 'x' }, date: 'D' }), { ok: false, reason: 'no-backlog' });
  assert.deepStrictEqual(w.fileNote({ docs, spec: { target: 'history', kind: 'decision', text: 'x' }, date: 'D' }), { ok: false, reason: 'no-history' });
  const q = w.docsOf(project());
  assert.deepStrictEqual(w.fileNote({ docs: q, spec: { target: 9, kind: 'idea', text: 'x' }, date: 'D' }), { ok: false, reason: 'no-item' });
  assert.deepStrictEqual(w.fileNote({ docs: q, spec: { target: 'new', kind: 'idea', title: 'T', text: ' ' }, date: 'D' }), { ok: false, reason: 'empty' });
});

// --- concurrent writers ----------------------------------------------------------------------------------------------

test('the backlog changed between the read and the rename: it starts over once and the other writer\'s edit is kept', () => {
  const p = project();
  const docs = w.docsOf(p);
  let calls = 0;
  const beforeRename = () => { if (calls++ === 0) fs.appendFileSync(docs.backlog, '\n## 3. A session wrote this\n'); };
  const r = w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'Mine', text: 'x' }, date: 'D', beforeRename });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 2);
  const text = read(docs.backlog);
  assert.ok(text.includes('## 3. A session wrote this'));
  assert.ok(text.includes('## 4. Mine'), 'the number is recomputed on the second try');
  assert.strictEqual(r.where.n, 4);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('it changed again on the second try: nothing is written and it says conflict (the note waits)', () => {
  const p = project();
  const docs = w.docsOf(p);
  let k = 0;
  const beforeRename = () => fs.appendFileSync(docs.backlog, `\nedit ${k++}\n`);
  const before = read(docs.backlog);
  const r = w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'T', text: 'x' }, date: 'D', beforeRename });
  assert.deepStrictEqual(r, { ok: false, reason: 'conflict' });
  assert.strictEqual(read(docs.backlog), before + '\nedit 0\n\nedit 1\n', 'only the other writer\'s edits');
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

// --- exact undo ------------------------------------------------------------------------------------------------------

test('Undo refuses when the backlog changed above the note, and removes nothing', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, spec: { target: 2, kind: 'idea', text: 'x' }, date: 'D' });
  const edited = read(docs.backlog).replace('## 1. First', '## 1. First, renamed');
  fs.writeFileSync(docs.backlog, edited);
  assert.deepStrictEqual(w.undoWrite(docs.backlog, r.record), { ok: false, reason: 'changed' });
  assert.strictEqual(read(docs.backlog), edited);
});

test('Undo of a file that is gone, or a record that is not one, refuses', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'T', text: 'x' }, date: 'D' });
  assert.deepStrictEqual(w.undoWrite(docs.backlog, { offset: 'x' }), { ok: false, reason: 'changed' });
  fs.unlinkSync(docs.backlog);
  assert.deepStrictEqual(w.undoWrite(docs.backlog, r.record), { ok: false, reason: 'changed' });
});

test('a write that fails leaves the doc as it was and no temp file behind', () => {
  const p = project();
  const docs = w.docsOf(p);
  const before = read(docs.backlog);
  const rename = () => { const e = new Error('disk says no'); e.code = 'ENOSPC'; throw e; };
  const r = w.fileNote({ docs, spec: { target: 'new', kind: 'idea', title: 'T', text: 'x' }, date: 'D', rename });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'write-failed');
  assert.strictEqual(read(docs.backlog), before);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});
