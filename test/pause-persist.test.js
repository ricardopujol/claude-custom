'use strict';
/**
 * host/pause-persist.js (BACKLOG #19, PR #158 Miguel Y4, Dexter R2-3 / R2-7): the paused set survives a crash, only a DEAD owner's file is ever acted on
 * (an owner is a pid AND a start time), and a file is removed only after its processes were woken.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createPausePersist } = require('../host/pause-persist');
const { tmpDir } = require('./tmp-dir');

const dirOf = () => tmpDir('cc-pause-persist-');
const entry = (pid, start = '100') => ({ key: `${pid}:${start}`, pid, start, name: 'burn.js', since: 5, pids: [{ pid, start }, { pid: pid + 1, start: '200' }] });
const states = map => async pid => (pid in map ? map[pid] : 'absent');

test('save writes the set under the owner\'s pid AND start, and an empty set removes the file', () => {
  const dir = dirOf();
  const p = createPausePersist({ dir, ownPid: 7, ownStart: '900' });
  p.save([entry(10)]);
  const file = path.join(dir, 'paused-7-900.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.ownPid, 7);
  assert.strictEqual(doc.ownStart, '900');
  assert.deepStrictEqual(doc.entries, [{ pid: 10, start: '100', name: 'burn.js', since: 5, pids: [{ pid: 10, start: '100' }, { pid: 11, start: '200' }] }]);
  p.save([]);
  assert.strictEqual(fs.existsSync(file), false);
  p.save([]);                                   // nothing to remove: still fine
});

test('takeDead returns the entries of a dead owner, removes NOTHING until release(), and never touches a live owner or its own file', async () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 1, ownStart: '10' }).save([entry(10)]);
  createPausePersist({ dir, ownPid: 2, ownStart: '20' }).save([entry(20)]);
  createPausePersist({ dir, ownPid: 3, ownStart: '30' }).save([entry(30)]);
  const mine = createPausePersist({ dir, ownPid: 3, ownStart: '30', ownerState: states({ 2: '20' }) });
  const got = await mine.takeDead();
  assert.deepStrictEqual(got.entries.map(e => e.pid), [10]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['paused-1-10.json', 'paused-2-20.json', 'paused-3-30.json'], 'R2-7: still there until the wake is confirmed');
  got.release();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['paused-2-20.json', 'paused-3-30.json']);
});

test('R2-3: a relaunch that was given the dead owner\'s pid is a DIFFERENT owner: the stale file is taken, and this run\'s own file does not collide with it', async () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 7, ownStart: '111' }).save([entry(24)]);
  const second = createPausePersist({ dir, ownPid: 7, ownStart: '222', ownerState: states({ 7: '222' }) });
  second.save([entry(50)]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['paused-7-111.json', 'paused-7-222.json'], 'two files, neither overwrote the other');
  const got = await second.takeDead();
  assert.deepStrictEqual(got.entries.map(e => e.pid), [24]);
  got.release();
  second.save([]);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and saving nothing removes only its own');
});

test('R2-3: another process holding the dead owner\'s pid (a different start) does not keep its file alive; the SAME start does', async () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 4242, ownStart: '111' }).save([entry(24)]);
  const sameStart = await createPausePersist({ dir, ownPid: 9, ownStart: '9', ownerState: states({ 4242: '111' }) }).takeDead();
  assert.deepStrictEqual(sameStart.entries, []);
  const stranger = await createPausePersist({ dir, ownPid: 9, ownStart: '9', ownerState: states({ 4242: '999' }) }).takeDead();
  assert.deepStrictEqual(stranger.entries.map(e => e.pid), [24]);
});

test('a pid whose state cannot be told is NOT dead (only absent, or another start, is)', async () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 1, ownStart: '10' }).save([entry(10)]);
  for (const answer of [null, undefined, '10']) {
    const got = await createPausePersist({ dir, ownPid: 9, ownStart: '9', ownerState: async () => answer }).takeDead();
    assert.deepStrictEqual(got.entries, [], String(answer));
  }
  const thrown = await createPausePersist({ dir, ownPid: 9, ownStart: '9', ownerState: async () => { throw new Error('ps'); } }).takeDead();
  assert.deepStrictEqual(thrown.entries, []);
  assert.strictEqual(fs.existsSync(path.join(dir, 'paused-1-10.json')), true);
});

test('a damaged file, a foreign file and a bad entry are skipped without throwing; the damaged one is left', async () => {
  const dir = dirOf();
  fs.writeFileSync(path.join(dir, 'paused-5-50.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'paused-6-60.json'), JSON.stringify({ entries: [{ pid: 1 }, entry(60), { pid: 'x', start: '1', pids: [] }] }));
  const got = await createPausePersist({ dir, ownPid: 9, ownStart: '9', ownerState: states({}) }).takeDead();
  assert.deepStrictEqual(got.entries.map(e => e.pid), [60]);
  got.release();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'paused-5-50.json']);
});

test('R2-7: a release that cannot unlink says "could not remove", never "could not read"', async () => {
  const dir = dirOf();
  createPausePersist({ dir, ownPid: 1, ownStart: '10' }).save([entry(10)]);
  const logs = [];
  const p = createPausePersist({ dir, ownPid: 9, ownStart: '9', ownerState: states({}), log: (...a) => logs.push(a.join(' ')), fsx: { ...fs, unlinkSync() { throw new Error('locked'); } } });
  const got = await p.takeDead();
  assert.strictEqual(got.entries.length, 1);
  got.release();
  assert.match(logs.join('|'), /could not remove paused-1-10\.json locked/);
  assert.doesNotMatch(logs.join('|'), /could not read/);
});

test('no folder at all: nothing to take, and a save that cannot be written is caught', async () => {
  const logs = [];
  const p = createPausePersist({ dir: path.join(dirOf(), 'missing'), ownPid: 1, ownStart: '1', log: (...a) => logs.push(a.join(' ')) });
  const got = await p.takeDead();
  assert.deepStrictEqual(got.entries, []);
  got.release();
  const bad = createPausePersist({ dir: path.join(dirOf(), 'x'), ownPid: 1, ownStart: '1', fsx: { ...fs, mkdirSync() { throw new Error('read-only'); } }, log: (...a) => logs.push(a.join(' ')) });
  bad.save([entry(10)]);
  assert.match(logs.join('|'), /could not save the paused set: read-only/);
});

test('save drops entries that are not proven processes (no start, no members)', () => {
  const dir = dirOf();
  const p = createPausePersist({ dir, ownPid: 4, ownStart: '40' });
  p.save([{ pid: 1 }, { pid: 2, start: 'x', pids: [] }, entry(30)]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'paused-4-40.json'), 'utf8')).entries.map(e => e.pid), [30]);
});
