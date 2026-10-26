'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { createDriftStore, MAX_NOTES, noteId } = require('../host/drift-store');

const tmp = () => tmpDir('drift-store-');
const commit = { sha: 'a'.repeat(40), subject: 'Merge pull request #9' };
const flag = (n = 1) => ({ doc: 'DESIGN_X.md', sentence: `Sentence number ${n} here.`, why: 'the diff changed it' });

test('a fresh store has nothing processed and no notes', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  assert.deepStrictEqual(s.read(), { processed: null, notes: [], unreadable: false });
  assert.deepStrictEqual(s.open(), []);
});

test('processed survives a reload; so do notes, newest first in open()', () => {
  const file = path.join(tmp(), 'p.json');
  const a = createDriftStore({ file });
  assert.ok(a.setProcessed('b'.repeat(40)).ok);
  assert.ok(a.addNotes(commit, [flag(1)], 1000).ok);
  assert.ok(a.addNotes({ sha: 'c'.repeat(40), subject: 's' }, [flag(2)], 2000).ok);
  const b = createDriftStore({ file });
  assert.strictEqual(b.read().processed, 'b'.repeat(40));
  assert.deepStrictEqual(b.open().map(n => n.sentence), ['Sentence number 2 here.', 'Sentence number 1 here.']);
  assert.strictEqual(b.open()[1].commit, 'a'.repeat(12));
  assert.strictEqual(b.open()[1].subject, 'Merge pull request #9');
});

test('dismiss persists across a reload and across another reader of the same file', () => {
  const file = path.join(tmp(), 'p.json');
  const a = createDriftStore({ file });
  a.addNotes(commit, [flag(1), flag(2)], 1000);
  const id = a.open()[0].id;
  assert.ok(a.dismiss(id).ok);
  assert.strictEqual(createDriftStore({ file }).open().length, 1);
  assert.strictEqual(a.open().length, 1);
  // a second host holding its own store object on the same file sees it at once
  const other = createDriftStore({ file });
  other.dismiss(a.open()[0].id);
  assert.strictEqual(a.open().length, 0);
});

test('a dismissed note is not brought back when the same flag is found again', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  s.addNotes(commit, [flag(1)], 1000);
  s.dismiss(s.open()[0].id);
  s.addNotes(commit, [flag(1)], 9000);
  assert.strictEqual(s.open().length, 0);
});

test('the same flag twice is one note; the id is a pure function of commit, doc and sentence', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  s.addNotes(commit, [flag(1), flag(1)], 1000);
  assert.strictEqual(s.open().length, 1);
  assert.strictEqual(s.open()[0].id, noteId(commit.sha, 'DESIGN_X.md', 'Sentence number 1 here.'));
  assert.notStrictEqual(noteId('x', 'a', 'b'), noteId('x', 'a', 'c'));
});

test('dismissing an unknown id says so and changes nothing', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  s.addNotes(commit, [flag(1)], 1000);
  const r = s.dismiss('nope');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown/);
  assert.strictEqual(s.open().length, 1);
});

test('a garbled or wrong-shaped file reads as empty, never throws; the next write replaces it', () => {
  const dir = tmp();
  const file = path.join(dir, 'p.json');
  for (const bad of ['{not json', '[]', '{"processed":5,"notes":"x"}', '{"processed":"abc","notes":[{"id":1},null,"x"]}']) {
    fs.writeFileSync(file, bad);
    const s = createDriftStore({ file });
    const r = s.read();
    assert.strictEqual(r.notes.length, 0, bad);
  }
  fs.writeFileSync(file, '{not json');
  const s = createDriftStore({ file });
  assert.ok(s.addNotes(commit, [flag(1)], 1).ok);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notes.length, 1);
});

test('a failed write is reported, leaves the old file whole, and leaves no temp file behind', () => {
  const dir = tmp();
  const file = path.join(dir, 'p.json');
  const ok = createDriftStore({ file });
  ok.addNotes(commit, [flag(1)], 1);
  const failing = createDriftStore({ file, rename: () => { throw new Error('disk says no'); } });
  const r = failing.addNotes(commit, [flag(2)], 2);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /disk says no/);
  assert.strictEqual(createDriftStore({ file }).open().length, 1);
  assert.deepStrictEqual(fs.readdirSync(dir), ['p.json']);
});

test('text is bounded and made of strings: oversize fields are cut, non-strings refused', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  s.addNotes({ sha: 'a'.repeat(40), subject: 's'.repeat(1000) }, [{ doc: 'DESIGN_X.md', sentence: 'q'.repeat(1000), why: 'w'.repeat(1000) }, { doc: 5, sentence: 'x', why: 'y' }], 1);
  const [n] = s.open();
  assert.strictEqual(s.open().length, 1);
  assert.ok(n.subject.length <= 120 && n.sentence.length <= 400 && n.why.length <= 300);
});

test('no usable time is refused, not stored as time zero', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  assert.strictEqual(s.addNotes(commit, [flag(1)], null).ok, false);
  assert.strictEqual(s.addNotes(commit, [flag(1)], NaN).ok, false);
  assert.strictEqual(s.open().length, 0);
});

test('property: any run of adds and dismissals keeps ids unique, the count capped, dismissed notes out of open()', () => {
  fc.assert(fc.property(fc.array(fc.oneof(
    fc.record({ op: fc.constant('add'), n: fc.integer({ min: 0, max: 400 }) }),
    fc.record({ op: fc.constant('dismiss'), at: fc.integer({ min: 0, max: 50 }) }),
  ), { maxLength: 40 }), (ops) => {
    const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
    let t = 1;
    for (const o of ops) {
      if (o.op === 'add') s.addNotes({ sha: String(o.n).padStart(40, '0'), subject: 's' }, [flag(o.n), flag(o.n + 1000)], t++);
      else { const open = s.open(); if (open.length) s.dismiss(open[o.at % open.length].id); }
    }
    const all = s.read().notes;
    const ids = new Set(all.map(n => n.id));
    return ids.size === all.length && all.length <= MAX_NOTES && s.open().every(n => n.dismissed === false);
  }), { numRuns: 25 });
});

// ---- PR #153 review fixes ----------------------------------------------------------------------------------------

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
// An fs whose reads fail with EBUSY for the first `n` calls (a scanner holding the freshly renamed file), then work.
const flaky = (n) => { let left = n; return { ...fs, readFileSync: (...a) => { if (left-- > 0) throw busy(); return fs.readFileSync(...a); } }; };

test('a read that fails once (EBUSY) is tried again and sees the real file (PR #153 Dexter 6)', () => {
  const file = path.join(tmp(), 'p.json');
  const real = createDriftStore({ file });
  real.setProcessed('b'.repeat(40));
  real.addNotes(commit, [flag(1)], 1000);
  const s = createDriftStore({ file, fsImpl: flaky(1), sleep: () => {} });
  const r = s.read();
  assert.strictEqual(r.unreadable, false);
  assert.strictEqual(r.processed, 'b'.repeat(40));
  assert.strictEqual(r.notes.length, 1);
});

test('a file that stays unreadable is NOT an empty one: read says so and every write refuses, leaving the file as it was (Dexter 6)', () => {
  const file = path.join(tmp(), 'p.json');
  const real = createDriftStore({ file });
  real.setProcessed('b'.repeat(40));
  real.addNotes(commit, [flag(1), flag(2)], 1000);
  real.dismiss(real.open()[0].id);
  const before = fs.readFileSync(file, 'utf8');
  const s = createDriftStore({ file, fsImpl: flaky(100), sleep: () => {} });
  assert.strictEqual(s.read().unreadable, true);
  for (const r of [s.setProcessed('c'.repeat(40)), s.addNotes(commit, [flag(3)], 2000), s.dismiss('anything')]) {
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /can't be read/);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('a file that is missing or garbled is empty (the first look, or a file that is not ours), not unreadable', () => {
  const dir = tmp();
  assert.strictEqual(createDriftStore({ file: path.join(dir, 'none.json') }).read().unreadable, false);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  const r = createDriftStore({ file: path.join(dir, 'bad.json') }).read();
  assert.deepStrictEqual([r.unreadable, r.processed, r.notes.length], [false, null, 0]);
});

test('two hosts never write at once: a dismissal made while another host is saving is refused, not lost, and goes through after (Dexter 7)', () => {
  const file = path.join(tmp(), 'p.json');
  const a = createDriftStore({ file });
  a.addNotes(commit, [flag(1)], 1000);
  const id = a.open()[0].id;
  let during;
  // host A is saving a new note: its rename is the moment the old code let host B read the OLD file and write it back over A's
  const savingA = createDriftStore({ file, rename: (from, to) => {
    during = createDriftStore({ file, lockDeadlineMs: 50 }).dismiss(id);
    return require('../host/atomic-write').renameWithRetry(from, to);
  } });
  assert.ok(savingA.addNotes(commit, [flag(2)], 2000).ok);
  assert.strictEqual(during.ok, false, 'B had to wait for A: its dismissal was refused, not interleaved');
  assert.match(during.error, /lock/);
  assert.strictEqual(a.open().length, 2);
  assert.ok(createDriftStore({ file }).dismiss(id).ok, 'and B can dismiss once A has finished');
  const final = a.read().notes;
  assert.strictEqual(final.find(n => n.id === id).dismissed, true);
  assert.strictEqual(final.length, 2);
  assert.ok(!fs.existsSync(file + '.lock'), 'the lock is released');
});

test('the lock is released when a write fails', () => {
  const file = path.join(tmp(), 'p.json');
  const s = createDriftStore({ file, rename: () => { throw new Error('disk says no'); } });
  assert.strictEqual(s.setProcessed('b'.repeat(40)).ok, false);
  assert.ok(!fs.existsSync(file + '.lock'));
  assert.ok(createDriftStore({ file }).setProcessed('b'.repeat(40)).ok);
});

test('the model\'s reason is scrubbed of secret-shaped strings before it is kept (Dexter 5)', () => {
  const s = createDriftStore({ file: path.join(tmp(), 'p.json') });
  s.addNotes(commit, [{ doc: 'DESIGN_X.md', sentence: 'Sentence number 1 here.', why: 'changed DB_PASSWORD=hunter2hunter2 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }], 1);
  assert.doesNotMatch(s.open()[0].why, /hunter2|abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(s.open()[0].why, /\[redacted\]/);
});
