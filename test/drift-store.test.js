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
  assert.deepStrictEqual(s.read(), { processed: null, notes: [] });
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
