'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21 (2026-10-09), host/indexing-writer.js: the retry bounds and backoff
 * of the rename (`i >= RENAME_ATTEMPTS`) and of the read (`READ_ATTEMPTS`), the non-transient failures that must not wait,
 * and findNote's `others.filter` (which copies of an identical entry belong to other filed notes).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { ATTEMPTS, FIRST_WAIT_MS } = require('../host/atomic-write');
const w = require('../host/indexing-writer');

const BACKLOG = '# P — Backlog\n\n**Status:** fine\n\n## 1. First\nbody\n';
const STAMP = '2026-10-05 09:07';

function project() {
  const dev = tmpDir('cc-iw-kills-');
  const docs = path.join(dev, 'documentation');
  fs.mkdirSync(docs);
  fs.mkdirSync(path.join(dev, '.git'));
  fs.writeFileSync(path.join(dev, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(docs, 'PROJ_BUILD_LOG.md'), '# log\n');
  fs.writeFileSync(path.join(docs, 'PROJ_BACKLOG.md'), BACKLOG);
  return { root: dev, dev, docs };
}
const read = (f) => fs.readFileSync(f, 'utf8');
const tempsIn = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
const coded = (code) => { const e = new Error(code); e.code = code; return e; };

// ---- the rename's retry bound ---------------------------------------------------------------------------------------------

test('S21 writer: a transient rename failure is retried ATTEMPTS-1 times and then lands, backing off 20, 40, 80, 160 ms', () => {
  const p = project();
  const docs = w.docsOf(p);
  const sleeps = [];
  let n = 0;
  const rename = (from, to) => { if (n++ < ATTEMPTS - 1) throw coded('EBUSY'); fs.renameSync(from, to); };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', rename, sleep: (ms) => sleeps.push(ms) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, ATTEMPTS, 'the last allowed attempt is the one that lands');
  assert.deepStrictEqual(sleeps, [FIRST_WAIT_MS, FIRST_WAIT_MS * 2, FIRST_WAIT_MS * 4, FIRST_WAIT_MS * 8]);
  assert.ok(read(docs.backlog).includes('· mine'));
});

test('S21 writer: a transient rename failure on EVERY allowed attempt gives up as write-failed, leaving the backlog and no temp file', () => {
  const p = project();
  const docs = w.docsOf(p);
  let n = 0;
  const sleeps = [];
  const rename = () => { n++; throw coded('EPERM'); };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', rename, sleep: (ms) => sleeps.push(ms) });
  assert.deepStrictEqual(r, { ok: false, reason: 'write-failed' });
  assert.strictEqual(n, ATTEMPTS, 'exactly ATTEMPTS tries, not one more');
  assert.strictEqual(sleeps.length, ATTEMPTS - 1, 'and no wait after the last');
  assert.strictEqual(read(docs.backlog), BACKLOG);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('S21 writer: a rename failure that is not transient is not retried and does not wait', () => {
  const p = project();
  const docs = w.docsOf(p);
  let n = 0;
  const sleeps = [];
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', rename: () => { n++; throw coded('ENOSPC'); }, sleep: (ms) => sleeps.push(ms) });
  assert.deepStrictEqual(r, { ok: false, reason: 'write-failed' });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(sleeps, []);
});

// ---- the read's retry bound ------------------------------------------------------------------------------------------------

function flaky(failures, code = 'EBUSY') {
  const state = { calls: 0 };
  state.readFile = (f, enc) => { if (state.calls++ < failures) throw coded(code); return fs.readFileSync(f, enc); };
  return state;
}

test('S21 writer: a read refused three times is still read on the fourth try; refused four times it is "busy"; each wait doubles from 20 ms', () => {
  const p = project();
  const docs = w.docsOf(p);
  const sleeps = [];
  const three = flaky(3);
  const found = w.findNote({ docs, stamp: STAMP, text: 'x', readFile: three.readFile, sleep: (ms) => sleeps.push(ms) });
  assert.deepStrictEqual(found, { ok: true, record: null });
  assert.strictEqual(three.calls, 4);
  assert.deepStrictEqual(sleeps, [FIRST_WAIT_MS, FIRST_WAIT_MS * 2, FIRST_WAIT_MS * 4]);

  const sleeps4 = [];
  const four = flaky(4);
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'x', readFile: four.readFile, sleep: (ms) => sleeps4.push(ms) }), { ok: false, reason: 'busy' });
  assert.strictEqual(four.calls, 4, 'it stops at the fourth refusal');
  assert.strictEqual(sleeps4.length, 3, 'with no wait after the last');
});

test('S21 writer: a read that fails for a non-transient reason is "busy" at once, with no retry and no wait; ENOENT is "no-backlog" at once', () => {
  const p = project();
  const docs = w.docsOf(p);
  for (const code of ['EIO', 'EMFILE']) {
    const sleeps = [];
    const f = flaky(99, code);
    assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'x', readFile: f.readFile, sleep: (ms) => sleeps.push(ms) }), { ok: false, reason: 'busy' }, code);
    assert.strictEqual(f.calls, 1, code);
    assert.deepStrictEqual(sleeps, [], code);
  }
  const sleeps = [];
  const gone = flaky(99, 'ENOENT');
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'x', readFile: gone.readFile, sleep: (ms) => sleeps.push(ms) }), { ok: false, reason: 'no-backlog' });
  assert.strictEqual(gone.calls, 1);
  assert.deepStrictEqual(sleeps, []);
  const nothing = (() => { throw null; });                  // a thrown non-error is not "missing" either
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'x', readFile: nothing, sleep: () => {} }), { ok: false, reason: 'busy' });
});

// ---- the check before each rename attempt ------------------------------------------------------------------------------------

test('S21 writer: when the backlog cannot be re-read for the check just before the rename, nothing is replaced and it starts over', () => {
  const p = project();
  const docs = w.docsOf(p);
  let n = 0;
  // The first read (to build the text) works; every later read (the pre-rename check) is refused for good.
  const readFile = (f, enc) => { if (n++ === 0) return fs.readFileSync(f, enc); throw coded('EIO'); };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', readFile, sleep: () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(read(docs.backlog), BACKLOG, 'the backlog is untouched');
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

// ---- findNote and the other filed notes' copies -----------------------------------------------------------------------------

test('S21 writer: of identical entries in the inbox, one belongs to each OTHER filed note; this note adopts only a copy beyond those', () => {
  const p = project();
  const docs = w.docsOf(p);
  const a = w.fileNote({ docs, stamp: STAMP, text: 'same words' });
  const b = w.fileNote({ docs, stamp: STAMP, text: 'same words' });
  assert.strictEqual(a.ok && b.ok, true);
  const entry = a.record.entry;

  const none = w.findNote({ docs, stamp: STAMP, text: 'same words' });
  assert.strictEqual(none.ok, true);
  assert.ok(none.record, 'with no other note owning a copy, the copies are found');
  assert.strictEqual(none.record.entry, entry);

  const one = w.findNote({ docs, stamp: STAMP, text: 'same words', others: [{ entry }] });
  assert.ok(one.record, 'two copies, one owned by another note: one is this note\'s');

  const two = w.findNote({ docs, stamp: STAMP, text: 'same words', others: [{ entry }, { entry }] });
  assert.deepStrictEqual(two, { ok: true, record: null }, 'two copies, both owned: this note\'s was never written');

  const junk = w.findNote({ docs, stamp: STAMP, text: 'same words', others: [null, undefined, 5, {}, { entry: 'something else' }, { entry }] });
  assert.ok(junk.record, 'null, empty and different entries own no copy');
  const three = w.findNote({ docs, stamp: STAMP, text: 'same words', others: [{ entry }, { entry }, { entry }] });
  assert.deepStrictEqual(three, { ok: true, record: null });
});

test('S21 writer: the record findNote returns is the LAST copy, and removing it leaves the earlier one', () => {
  const p = project();
  const docs = w.docsOf(p);
  const first = w.fileNote({ docs, stamp: STAMP, text: 'dup' });
  w.fileNote({ docs, stamp: STAMP, text: 'dup' });
  const found = w.findNote({ docs, stamp: STAMP, text: 'dup' });
  assert.strictEqual(found.record.offset > first.record.offset, true, 'it points past the first copy');
  assert.strictEqual(found.record.lead, '');
  assert.strictEqual(found.record.sep, '');
  assert.deepStrictEqual(w.undoNote(docs.backlog, found.record), { ok: true });
  assert.strictEqual(read(docs.backlog).split(first.record.entry).length - 1, 1, 'one copy is left');
});

// ---- small guards ----------------------------------------------------------------------------------------------------------

test('S21 writer: a blank or non-string note is refused as "empty" and touches nothing', () => {
  const p = project();
  const docs = w.docsOf(p);
  for (const text of ['', '   ', '\n\t', null, undefined, 5, ['x']]) {
    assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text }), { ok: false, reason: 'empty' }, JSON.stringify(text));
  }
  assert.strictEqual(read(docs.backlog), BACKLOG);
});

test('S21 writer: ensureBacklog leaves an existing backlog alone and refuses to create where it may not', () => {
  const p = project();
  assert.deepStrictEqual(w.ensureBacklog(w.docsOf(p)), { ok: true, created: false });
  assert.deepStrictEqual(w.ensureBacklog({ dir: p.docs, backlog: path.join(p.docs, 'NEW_BACKLOG.md'), canCreate: false }), { ok: false, reason: 'no-backlog' });
  assert.deepStrictEqual(w.ensureBacklog({ dir: p.docs, backlog: path.join(p.docs, 'NEW_BACKLOG.md'), canCreate: 'yes' }), { ok: false, reason: 'no-backlog' });
  assert.deepStrictEqual(w.ensureBacklog(null), { ok: false, reason: 'no-backlog' });
  assert.deepStrictEqual(fs.readdirSync(p.docs).sort(), ['PROJ_BACKLOG.md', 'PROJ_BUILD_LOG.md']);
});
