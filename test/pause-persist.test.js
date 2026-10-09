'use strict';
/**
 * host/pause-persist.js (BACKLOG #19, PR #158 Miguel Y4): the paused set survives a crash, and only a DEAD owner's file is ever acted on.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPausePersist } = require('../host/pause-persist');

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pause-persist-'));
const entry = (pid, start = '100') => ({ key: `${pid}:${start}`, pid, start, name: 'burn.js', since: 5, pids: [{ pid, start }, { pid: pid + 1, start: '200' }] });

test('save writes the set under the owner\'s pid, and an empty set removes the file', () => {
  const dir = dirOf();
  const p = createPausePersist({ dir, ownPid: 7 });
  p.save([entry(10)]);
  const file = path.join(dir, 'paused-7.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.ownPid, 7);
  assert.deepStrictEqual(doc.entries, [{ pid: 10, start: '100', name: 'burn.js', since: 5, pids: [{ pid: 10, start: '100' }, { pid: 11, start: '200' }] }]);
  p.save([]);
  assert.strictEqual(fs.existsSync(file), false);
  p.save([]);                                   // nothing to remove: still fine
});

test('takeDead returns the entries of a dead owner and removes its file; a live owner\'s file and its own are never touched', () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 1 }).save([entry(10)]);
  createPausePersist({ dir, ownPid: 2 }).save([entry(20)]);
  createPausePersist({ dir, ownPid: 3 }).save([entry(30)]);
  const mine = createPausePersist({ dir, ownPid: 3, isAlive: pid => pid === 2 });
  const got = mine.takeDead();
  assert.deepStrictEqual(got.map(e => e.pid), [10]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['paused-2.json', 'paused-3.json']);
});

test('a pid whose liveness cannot be told is NOT dead (only a definite false is)', () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 1 }).save([entry(10)]);
  for (const answer of [true, undefined, null, 'no']) {
    assert.deepStrictEqual(createPausePersist({ dir, ownPid: 9, isAlive: () => answer }).takeDead(), []);
  }
  assert.strictEqual(fs.existsSync(path.join(dir, 'paused-1.json')), true);
});

test('a damaged file, a foreign file and a bad entry are skipped without throwing; the damaged one is left', () => {
  const dir = dirOf();
  fs.writeFileSync(path.join(dir, 'paused-5.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'paused-6.json'), JSON.stringify({ entries: [{ pid: 1 }, entry(60), { pid: 'x', start: '1', pids: [] }] }));
  const got = createPausePersist({ dir, ownPid: 9, isAlive: () => false }).takeDead();
  assert.deepStrictEqual(got.map(e => e.pid), [60]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'paused-5.json']);
});

test('no folder at all: nothing to take, and a save that cannot be written is caught', () => {
  const logs = [];
  const p = createPausePersist({ dir: path.join(dirOf(), 'missing'), ownPid: 1, log: (...a) => logs.push(a.join(' ')) });
  assert.deepStrictEqual(p.takeDead(), []);
  const bad = createPausePersist({ dir: path.join(dirOf(), 'x'), ownPid: 1, fsx: { ...fs, mkdirSync() { throw new Error('read-only'); } }, log: (...a) => logs.push(a.join(' ')) });
  bad.save([entry(10)]);
  assert.match(logs.join('|'), /could not save the paused set: read-only/);
});

test('save drops entries that are not proven processes (no start, no members)', () => {
  const dir = dirOf();
  const p = createPausePersist({ dir, ownPid: 4 });
  p.save([{ pid: 1 }, { pid: 2, start: 'x', pids: [] }, entry(30)]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'paused-4.json'), 'utf8')).entries.map(e => e.pid), [30]);
});
