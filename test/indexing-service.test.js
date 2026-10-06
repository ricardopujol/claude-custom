'use strict';
/**
 * The indexing assistant's service (host/indexing-service.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised
 * 2026-10-05 (evening)": no model, a verbatim inbox). Real journal and writer on temp fixture docs.
 *   - Enter: the note is journaled first, then appended to the project's backlog inbox at once
 *   - no backlog file: nothing is created; the note stays in the list as not filed (its words in the journal)
 *   - a backlog that kept changing: it waits and is tried again by the tick
 *   - Undo removes exactly that entry, or says it can't
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

function setup({ backlog = BACKLOG, writerImpl = writer } = {}) {
  const dir = tmpDir('cc-is-');
  const dev = path.join(dir, 'proj');
  const docsDir = path.join(dev, 'documentation');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'P_BUILD_LOG.md'), '# log\n');
  if (backlog !== null) fs.writeFileSync(path.join(docsDir, 'P_BACKLOG.md'), backlog);
  const journal = createJournal({ file: path.join(dir, 'state', 'indexing-notes.jsonl') });
  let clock = new Date(2026, 9, 5, 9, 7).getTime();
  const calls = { broadcast: 0 };
  const svc = createIndexingService({
    journal, writer: writerImpl,
    docsFor: () => writer.docsOf({ root: dev, dev }),
    now: () => clock,
    broadcast: () => { calls.broadcast += 1; },
  });
  return { svc, journal, calls, project: dev, backlog: path.join(docsDir, 'P_BACKLOG.md'), advance: (ms) => { clock += ms; } };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const INBOXED = (entries) => BACKLOG.replace('## 1. First', `## Inbox\n${entries}\n## 1. First`);

test('submit: journaled first, then appended to the inbox at once, verbatim, stamped with when it was typed', () => {
  const t = setup();
  const r = t.svc.submit(t.project, '  tabs should glow  ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.filed, true);
  assert.strictEqual(read(t.backlog), INBOXED('- 2026-10-05 09:07 · tabs should glow\n'));
  const evs = t.journal.read().map(e => e.ev);
  assert.deepStrictEqual(evs.slice(0, 1), ['note'], 'the note is in the journal before anything else');
  assert.ok(evs.includes('filed'));
  const n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.text, n.undoable], ['filed', 'tabs should glow', true]);
  assert.deepStrictEqual(t.svc.snapshot(t.project).counts, { filed: 1, unfiled: 0 });
  assert.ok(t.calls.broadcast >= 1);
});

test('submit refuses an empty note and writes nothing anywhere', () => {
  const t = setup();
  assert.deepStrictEqual(t.svc.submit(t.project, '   '), { ok: false, reason: 'empty' });
  assert.deepStrictEqual(t.journal.read(), []);
  assert.strictEqual(read(t.backlog), BACKLOG);
});

test('no backlog file: nothing is created, and the note stays in the list as not filed', () => {
  const t = setup({ backlog: null });
  const r = t.svc.submit(t.project, 'an idea');
  assert.deepStrictEqual([r.ok, r.filed, r.reason], [true, false, 'no-backlog']);
  assert.strictEqual(fs.existsSync(t.backlog), false);
  const n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.reason, n.text, n.undoable], ['unfiled', 'no-backlog', 'an idea', false]);
  assert.deepStrictEqual(t.svc.snapshot(t.project).counts, { filed: 0, unfiled: 1 });
});

test('no backlog file is not retried by the tick (the design: it stays not filed, with Copy)', async () => {
  const t = setup({ backlog: null });
  t.svc.submit(t.project, 'x');
  fs.writeFileSync(t.backlog, BACKLOG);
  t.advance(RETRY_MS);
  await t.svc.tick();
  assert.strictEqual(read(t.backlog), BACKLOG);
});

test('a backlog that kept changing: the note waits, and the tick files it once the hold has passed', async () => {
  let busy = true;
  let k = 0;
  const busyWriter = { ...writer, fileNote: (a) => writer.fileNote({ ...a, beforeRename: () => { if (busy) fs.appendFileSync(a.docs.backlog, `edit ${k++}\n`); } }) };
  const t = setup({ writerImpl: busyWriter });
  const r = t.svc.submit(t.project, 'mine');
  assert.deepStrictEqual([r.filed, r.reason], [false, 'conflict']);
  busy = false;
  await t.svc.tick();
  assert.ok(!read(t.backlog).includes('· mine'), 'held, not retried at once');
  t.advance(RETRY_MS);
  await t.svc.tick();
  assert.ok(read(t.backlog).includes('- 2026-10-05 09:07 · mine'));
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('a reason already recorded is not journaled again on every retry', async () => {
  const failing = { ...writer, fileNote: () => ({ ok: false, reason: 'conflict' }) };
  const t = setup({ writerImpl: failing });
  t.svc.submit(t.project, 'x');
  for (let i = 0; i < 4; i++) { t.advance(RETRY_MS); await t.svc.tick(); }
  assert.strictEqual(t.journal.read().filter(e => e.ev === 'unfiled').length, 1);
});

test('the doc was written but "filed" never reached the journal: the retry finds the entry and never writes it twice (Dexter F3 / Miguel I2, PR #121)', async () => {
  const t = setup();
  // A journal whose first `filed` append throws (EPERM on the journal, or a crash right after the rename).
  let thrown = false;
  const real = t.journal;
  const flaky = {
    ...real,
    withLock: (fn) => real.withLock(({ append, read }) => fn({
      read,
      append: (e) => { if (e.ev === 'filed' && !thrown) { thrown = true; throw new Error('EPERM'); } append(e); },
    })),
  };
  let clock = new Date(2026, 9, 5, 9, 7).getTime();
  const svc = createIndexingService({ journal: flaky, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), now: () => clock, log: () => {} });
  const r = svc.submit(t.project, 'mine');
  assert.strictEqual(r.filed, false);
  assert.strictEqual(read(t.backlog).split('· mine').length - 1, 1, 'the doc was written once');
  clock += RETRY_MS;
  await svc.tick();
  assert.strictEqual(read(t.backlog).split('· mine').length - 1, 1, 'and still once after the retry');
  const n = svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.undoable], ['filed', true], 'the entry it found is the one Undo removes');
});

test('a note journaled but never filed (a crash before the write) is filed by the next tick', async () => {
  const t = setup();
  t.journal.append({ ev: 'note', id: 'crashed', project: t.project, text: 'left behind', at: new Date(2026, 9, 5, 9, 0).getTime() });
  await t.svc.tick();
  assert.ok(read(t.backlog).includes('- 2026-10-05 09:00 · left behind'));
});

test('undo removes exactly the entry; the list shows it undone', () => {
  const t = setup();
  const { id } = t.svc.submit(t.project, 'note');
  assert.deepStrictEqual(t.svc.undo(id, t.project), { ok: true });
  assert.strictEqual(read(t.backlog), INBOXED(''));
  const n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.undoable], ['undone', false]);
});

test('undo after a session edited the backlog elsewhere still works, and keeps the edit', () => {
  const t = setup();
  const { id } = t.svc.submit(t.project, 'note');
  fs.writeFileSync(t.backlog, read(t.backlog) + '## 2. New\n');
  assert.deepStrictEqual(t.svc.undo(id, t.project), { ok: true });
  assert.strictEqual(read(t.backlog), INBOXED('') + '## 2. New\n');
});

test('undo refuses when the entry was edited or filed away, names the file, removes nothing; the list says so first', () => {
  const t = setup();
  const { id } = t.svc.submit(t.project, 'note');
  const edited = read(t.backlog).replace('· note', '· note, filed as #2');
  fs.writeFileSync(t.backlog, edited);
  assert.strictEqual(t.svc.snapshot(t.project).list[0].undoable, false);
  assert.deepStrictEqual(t.svc.undo(id, t.project), { ok: false, reason: 'changed', file: t.backlog });
  assert.strictEqual(read(t.backlog), edited);
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('undo of a note that is not filed says so', () => {
  const t = setup({ backlog: null });
  const { id } = t.svc.submit(t.project, 'x');
  assert.deepStrictEqual(t.svc.undo(id, t.project), { ok: false, reason: 'not-filed' });
  assert.deepStrictEqual(t.svc.undo('nope', t.project), { ok: false, reason: 'not-filed' });
});

test('snapshot: another project\'s notes are not in it', () => {
  const t = setup();
  t.svc.submit(t.project, 'mine');
  t.svc.submit('C:\\somewhere\\else', 'theirs');
  assert.deepStrictEqual(t.svc.snapshot(t.project).list.map(n => n.text), ['mine']);
});

test('a journal that fails: submit says so and the backlog is untouched; a tick never throws', async () => {
  const t = setup();
  const broken = createIndexingService({
    journal: { read() { throw new Error('disk'); }, withLock() { throw new Error('disk'); }, append() { throw new Error('disk'); }, newId: () => 'x' },
    writer, docsFor: () => writer.docsOf({ root: t.project, dev: t.project }), log: () => {},
  });
  assert.deepStrictEqual(broken.submit(t.project, 'x'), { ok: false, reason: 'journal-failed' });
  assert.strictEqual(read(t.backlog), BACKLOG);
  await broken.tick();
});
