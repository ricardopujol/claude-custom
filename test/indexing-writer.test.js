'use strict';
/**
 * The indexing assistant's doc writer (host/indexing-writer.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised
 * 2026-10-05 (evening)"). Temp fixture docs only: never the real documentation/ folder.
 *   - a note goes into the backlog's `## Inbox` (created after the status block when missing), safely: re-read just
 *     before, temp file + rename, never truncated; a backlog edited in between makes it start over once, then give up
 *   - a project with no backlog file gets none: nothing is created
 *   - Undo removes exactly the entry, or refuses
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const w = require('../host/indexing-writer');

const BACKLOG = '# P — Backlog\n\n**Status:** fine\n\n## 1. First\nbody\n';
const STAMP = '2026-10-05 09:07';

function project({ backlog = BACKLOG, buildLog = true, name = 'PROJ' } = {}) {
  const dev = tmpDir('cc-iw-');
  const docs = path.join(dev, 'documentation');
  fs.mkdirSync(docs);
  if (buildLog) fs.writeFileSync(path.join(docs, `${name}_BUILD_LOG.md`), '# log\n');
  if (backlog !== null) fs.writeFileSync(path.join(docs, `${name}_BACKLOG.md`), backlog);
  return { root: dev, dev, docs };
}
const read = (f) => fs.readFileSync(f, 'utf8');
const tempsIn = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
const WITH_INBOX = (entries) => BACKLOG.replace('## 1. First', `## Inbox\n${entries}\n## 1. First`);

// --- where the docs are ----------------------------------------------------------------------------------------------

test('docsOf: <dev>\\documentation, the name from the one *_BUILD_LOG.md', () => {
  const p = project({ name: 'LYDIA' });
  assert.deepStrictEqual(w.docsOf(p), { ok: true, dir: p.docs, name: 'LYDIA', backlog: path.join(p.docs, 'LYDIA_BACKLOG.md') });
});

test('docsOf: no build log falls back to the project folder\'s name, upper case, separators removed (sync-docs\' rule)', () => {
  const p = project({ buildLog: false });
  assert.strictEqual(w.docsOf({ root: path.join(path.dirname(p.dev), 'my-proj_x'), dev: p.dev }).name, 'MYPROJX');
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

test('the first note creates the inbox after the status block, with the note verbatim; no temp file is left', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'tabs should "glow"' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.where, { file: docs.backlog });
  assert.strictEqual(read(docs.backlog), WITH_INBOX('- 2026-10-05 09:07 · tabs should "glow"\n'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('the next note goes after the last one', () => {
  const p = project({ backlog: WITH_INBOX('- 2026-10-05 09:00 · one\n') });
  const docs = w.docsOf(p);
  w.fileNote({ docs, stamp: STAMP, text: 'two' });
  assert.strictEqual(read(docs.backlog), WITH_INBOX('- 2026-10-05 09:00 · one\n- 2026-10-05 09:07 · two\n'));
});

test('a CRLF backlog stays CRLF, and a multi-line note is indented', () => {
  const p = project({ backlog: BACKLOG.replace(/\n/g, '\r\n') });
  const docs = w.docsOf(p);
  w.fileNote({ docs, stamp: STAMP, text: 'a\n## 9. b' });
  const text = read(docs.backlog);
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF');
  assert.ok(text.includes('- 2026-10-05 09:07 · a\r\n  ## 9. b\r\n'));
});

test('undoNote removes exactly the entry; the inbox heading stays', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX(''));
});

test('undoNote still works after a session edited the backlog elsewhere, and keeps that edit', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  fs.writeFileSync(docs.backlog, read(docs.backlog).replace('fine', 'fine, edited') + '## 2. New\n');
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX('').replace('fine', 'fine, edited') + '## 2. New\n');
});

test('undoNote refuses an entry that was edited or filed away, and removes nothing', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  const edited = read(docs.backlog).replace('· note', '· note, edited');
  fs.writeFileSync(docs.backlog, edited);
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: false, reason: 'changed' });
  assert.strictEqual(read(docs.backlog), edited);
});

test('findNote: an entry already in the inbox is found with the record Undo needs; one that isn\'t, isn\'t', () => {
  const p = project();
  const docs = w.docsOf(p);
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'note' }), { ok: true, record: null });
  w.fileNote({ docs, stamp: STAMP, text: 'note' });
  const f = w.findNote({ docs, stamp: STAMP, text: 'note' });
  assert.strictEqual(f.ok, true);
  assert.deepStrictEqual(w.undoNote(docs.backlog, f.record), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX(''));
  assert.deepStrictEqual(w.findNote({ docs: w.docsOf(project({ backlog: null })), stamp: STAMP, text: 'x' }), { ok: false, reason: 'no-backlog' });
});

test('no backlog file: nothing is created', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: 'x' }), { ok: false, reason: 'no-backlog' });
  assert.strictEqual(fs.existsSync(docs.backlog), false);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('an empty note is refused', () => {
  const docs = w.docsOf(project());
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: '  \n ' }), { ok: false, reason: 'empty' });
});

// --- concurrent writers ----------------------------------------------------------------------------------------------

test('the backlog changed between the read and the rename: it starts over once and the other writer\'s edit is kept', () => {
  const p = project();
  const docs = w.docsOf(p);
  let calls = 0;
  const beforeRename = () => { if (calls++ === 0) fs.appendFileSync(docs.backlog, '## 2. A session wrote this\n'); };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', beforeRename });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 2);
  const text = read(docs.backlog);
  assert.ok(text.includes('## 2. A session wrote this'));
  assert.ok(text.includes('· mine'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('it changed again on the second try: nothing is written and it says conflict', () => {
  const p = project();
  const docs = w.docsOf(p);
  let k = 0;
  const beforeRename = () => fs.appendFileSync(docs.backlog, `edit ${k++}\n`);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x', beforeRename });
  assert.deepStrictEqual(r, { ok: false, reason: 'conflict' });
  assert.strictEqual(read(docs.backlog), BACKLOG + 'edit 0\nedit 1\n', 'only the other writer\'s edits');
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('a write that fails leaves the backlog as it was and no temp file behind', () => {
  const p = project();
  const docs = w.docsOf(p);
  const rename = () => { const e = new Error('disk says no'); e.code = 'ENOSPC'; throw e; };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x', rename });
  assert.deepStrictEqual(r, { ok: false, reason: 'write-failed' });
  assert.strictEqual(read(docs.backlog), BACKLOG);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});
