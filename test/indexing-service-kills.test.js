'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21 (2026-10-09), host/indexing-service.js (93 survivors): the retry
 * hold's exact boundary and which reasons are retried, what each failure logs (never the note's words), the journal
 * text and project, the broadcast after a submit / undo / tick, the snapshot's per-row fields, and the daily rotation.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createIndexingService, RETRY_MS } = require('../host/indexing-service');
const { createJournal } = require('../host/indexing-journal');
const writer = require('../host/indexing-writer');

const BACKLOG = '# P — Backlog\n\n**Status:** fine\n\n## 1. First\nbody\n';
const T0 = new Date(2026, 9, 5, 9, 7).getTime();

function setup({ writerImpl = writer, backlog = BACKLOG, log, docsFor } = {}) {
  const dir = tmpDir('cc-is-kills-');
  const dev = path.join(dir, 'proj');
  const docsDir = path.join(dev, 'documentation');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(dev, '.git'));
  fs.writeFileSync(path.join(dev, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(docsDir, 'P_BUILD_LOG.md'), '# log\n');
  if (backlog !== null) fs.writeFileSync(path.join(docsDir, 'P_BACKLOG.md'), backlog);
  const journal = createJournal({ file: path.join(dir, 'state', 'indexing-notes.jsonl') });
  const clock = { t: T0 };
  const logs = [];
  const calls = { broadcast: 0 };
  const svc = createIndexingService({
    journal, writer: writerImpl,
    docsFor: docsFor || (() => writer.docsOf({ root: dev, dev })),
    now: () => clock.t, broadcast: () => { calls.broadcast += 1; }, log: log || ((...a) => logs.push(a.join(' '))),
  });
  return { svc, journal, clock, logs, calls, project: dev, backlog: path.join(docsDir, 'P_BACKLOG.md'), dir };
}
const read = (f) => fs.readFileSync(f, 'utf8');

// ---- the hold and which reasons are retried -----------------------------------------------------------------------------------

function failingWriter(reasons) {
  const calls = { fileNote: 0 };
  return {
    calls,
    impl: { ...writer, fileNote: (a) => { const reason = reasons[Math.min(calls.fileNote, reasons.length - 1)]; calls.fileNote += 1; return reason === 'ok' ? writer.fileNote(a) : { ok: false, reason }; } },
  };
}

test('S21 service: a note held for RETRY_MS is tried again at exactly RETRY_MS and not one millisecond before', async () => {
  const w = failingWriter(['busy', 'ok']);
  const t = setup({ writerImpl: w.impl });
  assert.strictEqual(t.svc.submit(t.project, 'mine').reason, 'busy');
  assert.strictEqual(w.calls.fileNote, 1);
  t.clock.t += RETRY_MS - 1;
  await t.svc.tick();
  assert.strictEqual(w.calls.fileNote, 1, 'one millisecond early: still held');
  t.clock.t += 1;
  await t.svc.tick();
  assert.strictEqual(w.calls.fileNote, 2, 'at the hold\'s end: tried');
  assert.ok(read(t.backlog).includes('· mine'));
});

test('S21 service: conflict, write-failed and busy are retried by the tick; no-docs, no-backlog-ambiguous and any other reason are not', async () => {
  for (const reason of ['conflict', 'write-failed', 'busy']) {
    const w = failingWriter([reason, 'ok']);
    const t = setup({ writerImpl: w.impl });
    t.svc.submit(t.project, 'x');
    t.clock.t += RETRY_MS;
    await t.svc.tick();
    assert.strictEqual(w.calls.fileNote, 2, `${reason} is retried`);
  }
  for (const reason of ['no-docs', 'many-build-logs', 'no-backlog-ambiguous', 'something-new']) {
    const w = failingWriter([reason, 'ok']);
    const t = setup({ writerImpl: w.impl });
    const r = t.svc.submit(t.project, 'x');
    assert.strictEqual(r.reason, reason);
    t.clock.t += 10 * RETRY_MS;
    await t.svc.tick();
    assert.strictEqual(w.calls.fileNote, 1, `${reason} is not retried`);
  }
});

test('S21 service: a hold is set only for a retried reason, and a successful filing clears it', async () => {
  const w = failingWriter(['busy', 'busy', 'ok']);
  const t = setup({ writerImpl: w.impl });
  t.svc.submit(t.project, 'x');                         // busy: held until T0 + RETRY_MS
  t.clock.t += RETRY_MS;
  await t.svc.tick();                                   // busy again: held until +RETRY_MS more
  assert.strictEqual(w.calls.fileNote, 2);
  t.clock.t += RETRY_MS - 1;
  await t.svc.tick();
  assert.strictEqual(w.calls.fileNote, 2, 'the new hold is counted from the second failure');
  t.clock.t += 1;
  await t.svc.tick();
  assert.strictEqual(w.calls.fileNote, 3);
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('S21 service: a tick files ONE due note, the oldest, and tells the windows; a tick with nothing to do says nothing', async () => {
  const t = setup();
  t.journal.append({ ev: 'note', id: 'newer', project: t.project, text: 'newer note', at: T0 - 1000 });
  t.journal.append({ ev: 'note', id: 'older', project: t.project, text: 'older note', at: T0 - 5000 });
  await t.svc.tick();
  const text = read(t.backlog);
  assert.ok(text.includes('older note') && !text.includes('newer note'), 'only the oldest per tick');
  assert.strictEqual(t.calls.broadcast, 1);
  await t.svc.tick();
  assert.ok(read(t.backlog).includes('newer note'));
  assert.strictEqual(t.calls.broadcast, 2);
  const before = t.calls.broadcast;
  await t.svc.tick();
  assert.strictEqual(t.calls.broadcast, before, 'nothing due: nobody is told');
});

test('S21 service: a note whose earlier attempt was never decided (no reason) is due; one filed or undone is not', async () => {
  const t = setup();
  t.journal.append({ ev: 'note', id: 'a', project: t.project, text: 'pending note', at: T0 - 100 });
  t.journal.append({ ev: 'filing', id: 'a', at: T0 - 90 });
  await t.svc.tick();
  assert.strictEqual(read(t.backlog).split('pending note').length - 1, 1);
  const before = read(t.backlog);
  await t.svc.tick();
  assert.strictEqual(read(t.backlog), before);
});

// ---- submit ---------------------------------------------------------------------------------------------------------------------

test('S21 service: submit journals the TRIMMED words and the project as a string, then tells the windows', () => {
  const t = setup();
  const r = t.svc.submit(t.project, '  spaced words \n');
  const note = t.journal.read().find(e => e.ev === 'note');
  assert.strictEqual(note.text, 'spaced words');
  assert.strictEqual(note.project, t.project);
  assert.strictEqual(note.at, T0);
  assert.strictEqual(note.id, r.id);
  assert.strictEqual(t.calls.broadcast, 1);
  const withFiling = t.journal.read().map(e => e.ev);
  assert.deepStrictEqual(withFiling, ['note', 'filing', 'filed']);
  const filed = t.journal.read().find(e => e.ev === 'filed');
  assert.strictEqual(filed.at, T0);
  assert.strictEqual(filed.where.file, t.backlog);
});

test('S21 service: submit refuses text that is not a non-blank string, and journals nothing', () => {
  const t = setup();
  for (const bad of ['', '  ', '\n\t', null, undefined, 5, {}, ['x']]) {
    assert.deepStrictEqual(t.svc.submit(t.project, bad), { ok: false, reason: 'empty' }, JSON.stringify(bad));
  }
  assert.deepStrictEqual(t.journal.read(), []);
  assert.strictEqual(t.calls.broadcast, 0);
});

test('S21 service: a broadcast that throws does not fail the submit', () => {
  const dir = tmpDir('cc-is-kills-');
  const dev = path.join(dir, 'proj');
  fs.mkdirSync(path.join(dev, 'documentation'), { recursive: true });
  fs.mkdirSync(path.join(dev, '.git'));
  fs.writeFileSync(path.join(dev, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dev, 'documentation', 'P_BACKLOG.md'), BACKLOG);
  const svc = createIndexingService({
    journal: createJournal({ file: path.join(dir, 'j.jsonl') }), docsFor: () => writer.docsOf({ root: dev, dev }),
    broadcast: () => { throw new Error('window gone'); }, log: () => {},
  });
  assert.strictEqual(svc.submit(dev, 'still filed').filed, true);
});

test('S21 service: a journal that cannot take the note is logged without the words; a filing that throws is logged, held and reported write-failed', () => {
  const t = setup();
  const broken = createIndexingService({
    journal: { read: () => [], withLock() { throw new Error('lock'); }, append() { throw new Error('EPERM journal'); }, newId: () => 'id1' },
    writer, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), log: (...a) => t.logs.push(a.join(' ')),
  });
  assert.deepStrictEqual(broken.submit(t.project, 'SECRET words'), { ok: false, reason: 'journal-failed' });
  assert.deepStrictEqual(t.logs, ['[indexing] could not journal a note: EPERM journal']);

  const logs = [];
  const j = createJournal({ file: path.join(t.dir, 'state2', 'j.jsonl') });
  let throwOnLock = true;
  const flaky = { ...j, withLock: (fn) => { if (throwOnLock) throw new Error('lock busy'); return j.withLock(fn); } };
  let clock = T0;
  const svc = createIndexingService({ journal: flaky, writer, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), now: () => clock, log: (...a) => logs.push(a.join(' ')) });
  const r = svc.submit(t.project, 'SECRET words');
  assert.deepStrictEqual([r.ok, r.id !== undefined, r.filed, r.reason], [true, true, false, 'write-failed']);
  assert.deepStrictEqual(logs, ['[indexing] could not file a note: lock busy']);
  assert.ok(!logs.join('').includes('SECRET'));
  // held: the tick leaves it alone until RETRY_MS has passed
  throwOnLock = false;
  clock += RETRY_MS - 1;
  return svc.tick().then(() => {
    assert.ok(!read(t.backlog).includes('SECRET'), 'held');
    clock += 1;
    return svc.tick();
  }).then(() => assert.ok(read(t.backlog).includes('SECRET words')));
});

// ---- docs problems and other windows ----------------------------------------------------------------------------------------------

test('S21 service: docsFor failing or answering not-ok is journaled as unfiled with its reason (no-docs when it gives none)', () => {
  for (const [docs, want] of [[{ ok: false, reason: 'many-build-logs' }, 'many-build-logs'], [{ ok: false }, 'no-docs'], [null, 'no-docs'], [{ ok: 'yes', backlog: 'x' }, 'no-docs']]) {
    const t = setup({ docsFor: () => docs });
    const r = t.svc.submit(t.project, 'x');
    assert.deepStrictEqual([r.ok, r.filed, r.reason], [true, false, want], JSON.stringify(docs));
    assert.deepStrictEqual(t.journal.read().filter(e => e.ev === 'unfiled').map(e => [e.reason, e.at]), [[want, T0]]);
  }
});

// ---- undo ------------------------------------------------------------------------------------------------------------------------------

test('S21 service: undo journals "undone" with the time, tells the windows, and the row is undone', () => {
  const t = setup();
  const r = t.svc.submit(t.project, 'mine');
  const sent = t.calls.broadcast;
  t.clock.t += 1234;
  assert.deepStrictEqual(t.svc.undo(r.id, t.project), { ok: true });
  assert.deepStrictEqual(t.journal.read().filter(e => e.ev === 'undone').map(e => [e.id, e.at]), [[r.id, T0 + 1234]]);
  assert.strictEqual(t.calls.broadcast, sent + 1);
  assert.ok(!read(t.backlog).includes('mine'));
});

test('S21 service: a refused undo reports why, tells the windows too, and journals nothing', () => {
  const t = setup();
  const r = t.svc.submit(t.project, 'mine');
  const sent = t.calls.broadcast;
  assert.deepStrictEqual(t.svc.undo('nope', t.project), { ok: false, reason: 'not-filed' });
  assert.deepStrictEqual(t.svc.undo(r.id, path.join(t.dir, 'other')), { ok: false, reason: 'other-project' });
  assert.strictEqual(t.calls.broadcast, sent + 2);
  fs.writeFileSync(t.backlog, read(t.backlog).replace('· mine', '· mine, edited'));
  assert.deepStrictEqual(t.svc.undo(r.id, t.project), { ok: false, reason: 'changed', file: t.backlog });
  assert.strictEqual(t.journal.read().filter(e => e.ev === 'undone').length, 0);
});

test('S21 service: an undo that throws is logged without the words and answers "error"', () => {
  const t = setup();
  const r = t.svc.submit(t.project, 'SECRET mine');
  const svc = createIndexingService({
    journal: { ...t.journal, withLock() { throw new Error('journal locked'); } }, writer,
    docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), log: (...a) => t.logs.push(a.join(' ')),
  });
  assert.deepStrictEqual(svc.undo(r.id, t.project), { ok: false, reason: 'error' });
  assert.deepStrictEqual(t.logs, ['[indexing] undo failed: journal locked']);
});

test('S21 service: undo refuses when docsFor is not ok, or names another file than the note was filed into (bad-record)', () => {
  const t = setup();
  const r = t.svc.submit(t.project, 'mine');
  let docs = { ok: false, reason: 'no-docs' };
  const svc = createIndexingService({ journal: t.journal, writer, docsFor: () => docs, log: () => {} });
  assert.deepStrictEqual(svc.undo(r.id, t.project), { ok: false, reason: 'bad-record' });
  docs = { ok: true, backlog: path.join(t.dir, 'elsewhere', 'P_BACKLOG.md') };
  assert.deepStrictEqual(svc.undo(r.id, t.project), { ok: false, reason: 'bad-record' });
  docs = null;
  assert.deepStrictEqual(svc.undo(r.id, t.project), { ok: false, reason: 'bad-record' });
});

// ---- snapshot ---------------------------------------------------------------------------------------------------------------------------

test('S21 service: a snapshot row carries the id, words, time, state, reason, the file\'s base name and createdBacklog', () => {
  const t = setup();
  const r = t.svc.submit(t.project, 'row words');
  const row = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual(row, { id: r.id, text: 'row words', at: T0, state: 'filed', reason: null, file: 'P_BACKLOG.md', createdBacklog: false, undoable: true });
});

test('S21 service: undoable is false when docsFor throws or is not ok, when the backlog is gone, or when the entry was edited', () => {
  const t = setup();
  const r = t.svc.submit(t.project, 'row words');
  let mode = 'throw';
  const svc = createIndexingService({
    journal: t.journal, writer, now: () => T0,
    docsFor: () => { if (mode === 'throw') throw new Error('x'); if (mode === 'notok') return { ok: false, reason: 'no-docs' }; return writer.docsOf({ root: t.project, dev: t.project }); },
  });
  for (const m of ['throw', 'notok']) { mode = m; assert.strictEqual(svc.snapshot(t.project).list[0].undoable, false, m); }
  mode = 'ok';
  assert.strictEqual(svc.snapshot(t.project).list[0].undoable, true);
  const saved = read(t.backlog);
  fs.writeFileSync(t.backlog, saved.replace('· row words', '· row words (edited)'));
  assert.strictEqual(svc.snapshot(t.project).list[0].undoable, false, 'edited');
  fs.rmSync(t.backlog);
  assert.strictEqual(svc.snapshot(t.project).list[0].undoable, false, 'gone');
  assert.ok(r.id);
});

test('S21 service: a filed row of a note that created the backlog says createdBacklog; an unfiled one has no file', () => {
  const t = setup({ backlog: null });
  const made = t.svc.submit(t.project, 'first ever');
  const row = t.svc.snapshot(t.project).list[0];
  assert.strictEqual(row.createdBacklog, true);
  assert.strictEqual(row.file, 'P_BACKLOG.md');
  assert.ok(made.filed);

  const u = setup({ docsFor: () => ({ ok: false, reason: 'no-docs' }) });
  u.svc.submit(u.project, 'nowhere');
  const un = u.svc.snapshot(u.project).list[0];
  assert.deepStrictEqual([un.state, un.reason, un.file, un.createdBacklog, un.undoable], ['unfiled', 'no-docs', null, false, false]);
});

// ---- rotation -----------------------------------------------------------------------------------------------------------------------------

test('S21 service: rotation runs on the first tick and again only when the local day changes; a failing rotation is logged and does not stop the tick', async () => {
  const t = setup();
  const compacts = [];
  const real = t.journal;
  const journal = { ...real, compact: (keep) => { compacts.push(keep); return real.compact(keep); } };
  const svc = createIndexingService({ journal, writer, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), now: () => t.clock.t, log: (...a) => t.logs.push(a.join(' ')) });
  await svc.tick();
  await svc.tick();
  assert.strictEqual(compacts.length, 1, 'once on the first day');
  t.clock.t += 24 * 60 * 60 * 1000;
  await svc.tick();
  assert.strictEqual(compacts.length, 2, 'again the next day');

  // The kept predicate: any unfiled note, and a note current today.
  const keep = compacts[0];
  assert.strictEqual(keep({ state: 'unfiled', at: 0 }), true);
  assert.strictEqual(keep({ state: 'filed', at: T0 }), true, 'today');
  assert.strictEqual(keep({ state: 'filed', at: T0 - 3 * 24 * 60 * 60 * 1000 }), false, 'old and filed');
  assert.strictEqual(keep({ state: 'undone', at: T0 - 3 * 24 * 60 * 60 * 1000 }), false);

  const failing = createIndexingService({
    journal: { ...real, compact() { throw new Error('lock busy'); } }, writer, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }),
    now: () => t.clock.t, log: (...a) => t.logs.push(a.join(' ')),
  });
  real.append({ ev: 'note', id: 'late', project: t.project, text: 'still filed', at: t.clock.t - 10 });
  await failing.tick();
  assert.ok(t.logs.includes('[indexing] journal rotation failed: lock busy'), t.logs.join('|'));
  assert.ok(read(t.backlog).includes('still filed'), 'the note was filed despite the failed rotation');
});

test('S21 service: a tick that throws is logged and swallowed', async () => {
  const logs = [];
  const svc = createIndexingService({
    journal: { read() { throw new Error('read broke'); }, compact() {}, withLock() {}, append() {}, newId: () => 'x' },
    docsFor: () => null, log: (...a) => logs.push(a.join(' ')),
  });
  await svc.tick();
  assert.deepStrictEqual(logs, ['[indexing] tick failed: read broke']);
});

test('S21 service: a held note\'s replay that throws is logged (not the words) and settled as write-failed', () => {
  const t = setup({ backlog: null });
  const logs = [];
  t.journal.append({ ev: 'note', id: 'held1', project: t.project, text: 'SECRET held', at: T0 - 60_000 });
  t.journal.append({ ev: 'unfiled', id: 'held1', reason: 'no-backlog', at: T0 - 59_000 });
  const w = { ...writer, findNote: () => { throw new Error('look exploded'); } };
  const svc = createIndexingService({ journal: t.journal, writer: w, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), now: () => T0, log: (...a) => logs.push(a.join(' ')) });
  const r = svc.submit(t.project, 'second');
  assert.ok(logs.includes('[indexing] could not file a held note: look exploded'), logs.join('|'));
  assert.ok(!logs.join('').includes('SECRET'));
  const held = t.journal.read().filter(e => e.id === 'held1' && e.ev === 'unfiled').map(e => e.reason);
  assert.deepStrictEqual(held, ['no-backlog', 'write-failed']);
  assert.ok(r.ok);
});
