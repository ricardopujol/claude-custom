'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const s = require('../host/tab-marks-store');
const { setMark, emptyMarks, markFor } = require('../app/tab-marks');
const { tmpDir } = require('./tmp-dir');

const tempRoot = () => tmpDir('tab-marks-');
const stateDir = root => path.join(root, '.claude-custom');

test('the file sits in .claude-custom, and finding it creates nothing', (t) => {
  const root = tempRoot(t);
  assert.strictEqual(s.marksFileFor(root), path.join(root, '.claude-custom', 'tab-marks.json'));
  assert.strictEqual(fs.existsSync(stateDir(root)), false);
});

test('a junctioned .claude-custom is refused, like the ledger', (t) => {
  const root = tempRoot(t);
  const elsewhere = tempRoot(t);
  fs.symlinkSync(elsewhere, stateDir(root), 'junction');
  assert.strictEqual(s.marksFileFor(root), null);
  assert.deepStrictEqual(s.loadMarks(s.marksFileFor(root)).state, 'unavailable');
});

test('load: missing, ok, unreadable', (t) => {
  const root = tempRoot(t);
  const file = s.marksFileFor(root);
  const missing = s.loadMarks(file);
  assert.strictEqual(missing.state, 'missing');
  assert.deepStrictEqual(Object.keys(missing.store.marks), []);

  fs.mkdirSync(stateDir(root));
  fs.writeFileSync(file, JSON.stringify({ version: 1, marks: { develop: 'star' } }));
  const ok = s.loadMarks(file);
  assert.strictEqual(ok.state, 'ok');
  assert.strictEqual(markFor(ok.store, 'develop').id, 'star');

  fs.writeFileSync(file, '{ not json');
  const bad = s.loadMarks(file);
  assert.strictEqual(bad.state, 'unreadable');
  assert.strictEqual(bad.store, null);
});

test('load: a read that fails for any reason but ENOENT is unreadable, not missing', () => {
  const fsImpl = { readFileSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
  assert.strictEqual(s.loadMarks('C:\\x\\tab-marks.json', { fsImpl }).state, 'unreadable');
});

test('save writes the file (and the folder) and load reads it back', (t) => {
  const root = tempRoot(t);
  s.saveMarks(root, setMark(emptyMarks(), 'feat/a', 'waiting'));
  const back = s.loadMarks(s.marksFileFor(root));
  assert.strictEqual(back.state, 'ok');
  assert.strictEqual(markFor(back.store, 'feat/a').id, 'waiting');
  assert.ok(fs.existsSync(path.join(stateDir(root), '.gitignore')));
});

test('save refuses a junctioned .claude-custom', (t) => {
  const root = tempRoot(t);
  const elsewhere = tempRoot(t);
  fs.symlinkSync(elsewhere, stateDir(root), 'junction');
  assert.throws(() => s.saveMarks(root, emptyMarks()), /tab-marks/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('a failed rename keeps the old file and leaves no temp behind', (t) => {
  const root = tempRoot(t);
  s.saveMarks(root, setMark(emptyMarks(), 'feat/a', 'waiting'));
  const fsImpl = { ...fs, renameSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
  assert.throws(() => s.saveMarks(root, setMark(emptyMarks(), 'feat/a', 'ship'), { fsImpl }), /denied/);
  assert.strictEqual(markFor(s.loadMarks(s.marksFileFor(root)).store, 'feat/a').id, 'waiting');
  assert.deepStrictEqual(fs.readdirSync(stateDir(root)).sort(), ['.gitignore', 'tab-marks.json']);
});
