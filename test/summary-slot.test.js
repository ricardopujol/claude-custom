'use strict';
/**
 * The one-GPU-job-at-a-time slot ACROSS hosts (host/summary-slot.js). Every tab is its own host process, so the
 * in-process queue in host/summary-scheduler.js can't see another tab's job; the slot is a file created with 'wx'
 * (atomic create-or-fail), released by its holder, and presumed abandoned once it is older than any job can run
 * or its holder process is gone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createSlot, STALE_MS } = require('../host/summary-slot');

const tmp = () => tmpDir('slot-');
const clock = (t = 1_000_000) => { const f = () => t; f.set = (v) => { t = v; }; return f; };

test('the first host takes the slot and a second one is refused until it is released', () => {
  const file = path.join(tmp(), 'job.lock');
  const a = createSlot({ file, pid: 111, isAlive: () => true });
  const b = createSlot({ file, pid: 222, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  assert.strictEqual(b.tryAcquire(), false);
  a.release();
  assert.strictEqual(b.tryAcquire(), true);
  b.release();
  assert.strictEqual(fs.existsSync(file), false);
});

test('the folder is created when it is not there yet', () => {
  const file = path.join(tmp(), 'nested', 'deeper', 'job.lock');
  const a = createSlot({ file, pid: 1, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  a.release();
});

test('a host that already holds the slot does not lock itself out: a second acquire is refused, a release frees it', () => {
  const file = path.join(tmp(), 'job.lock');
  const a = createSlot({ file, pid: 111, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  assert.strictEqual(a.tryAcquire(), false);
  a.release();
  assert.strictEqual(a.tryAcquire(), true);
  a.release();
});

test('release only removes the slot this host took: a stranger\'s slot stays', () => {
  const file = path.join(tmp(), 'job.lock');
  const a = createSlot({ file, pid: 111, isAlive: () => true });
  a.release();                                    // never held: nothing happens
  fs.writeFileSync(file, JSON.stringify({ pid: 999, at: Date.now(), token: 'someone-else' }));
  a.release();
  assert.strictEqual(fs.existsSync(file), true);
});

test('a slot older than any job could run is presumed abandoned and taken over', () => {
  const file = path.join(tmp(), 'job.lock');
  const now = clock();
  const a = createSlot({ file, pid: 111, now, isAlive: () => true });
  const b = createSlot({ file, pid: 222, now, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  now.set(1_000_000 + STALE_MS - 1);
  assert.strictEqual(b.tryAcquire(), false);
  now.set(1_000_000 + STALE_MS + 1);
  assert.strictEqual(b.tryAcquire(), true);
});

test('a slot whose holder process is gone is taken over at once, not after the timeout', () => {
  const file = path.join(tmp(), 'job.lock');
  const a = createSlot({ file, pid: 111, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  const b = createSlot({ file, pid: 222, isAlive: (pid) => pid !== 111 });
  assert.strictEqual(b.tryAcquire(), true);
});

test('the holder\'s pid is not trusted: a pid that is not a positive integer is never probed and never counts as dead', () => {
  const file = path.join(tmp(), 'job.lock');
  const probed = [];
  const b = createSlot({ file, pid: 222, now: clock(), isAlive: (p) => { probed.push(p); return false; } });
  for (const pid of [0, -1, 1.5, '12', null, 'abc']) {
    fs.writeFileSync(file, JSON.stringify({ pid, at: 1_000_000, token: 't' }));
    assert.strictEqual(b.tryAcquire(), false, `pid ${JSON.stringify(pid)} must not read as dead`);
  }
  assert.deepStrictEqual(probed, []);
});

test('a slot file nobody can read is judged by its age on disk, so it cannot jam the queue forever', () => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, 'garbage{');
  const b = createSlot({ file, pid: 222, isAlive: () => true });
  assert.strictEqual(b.tryAcquire(), false, 'a fresh unreadable file might be a holder mid-write');
  const old = new Date(Date.now() - STALE_MS - 5000);
  fs.utimesSync(file, old, old);
  assert.strictEqual(b.tryAcquire(), true);
});

test('a folder that cannot be written is a refusal with a reason, never a throw', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file-not-folder');
  fs.writeFileSync(blocker, 'x');
  const a = createSlot({ file: path.join(blocker, 'job.lock'), pid: 1, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), false);
  assert.ok(typeof a.lastError() === 'string' && a.lastError() !== '');
});

// Dexter F3 (PR #105): taking over a stale slot was check-then-act, so a second host could delete the FIRST host's fresh
// slot and both would hold the GPU. The takeover is now claimed with a create-exclusive file and re-verified.
test('two hosts taking over the same stale slot at once: only one of them ever holds it', () => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: 1_000_000, token: 'dead-host' }));
  const now = clock(1_000_000 + STALE_MS + 5000);
  const b = createSlot({ file, pid: 222, now, isAlive: (p) => p !== 4242 });
  let bResult = null;
  let reads = 0;
  // Host A reads the slot twice while judging it (judge, then re-verify before it breaks it). Host B runs its WHOLE
  // takeover inside A's second read: the interleaving that let both through.
  const aFs = { ...fs, readFileSync: (f, ...rest) => {
    if (f === file && ++reads === 2) bResult = b.tryAcquire();
    return fs.readFileSync(f, ...rest);
  } };
  const a = createSlot({ file, pid: 111, now, isAlive: (p) => p !== 4242, fsImpl: aFs });
  const aResult = a.tryAcquire();
  assert.ok(reads >= 2 && bResult !== null, 'the interleaving actually ran');
  const holders = [aResult, bResult === true].filter(Boolean).length;
  assert.ok(holders <= 1, `both took the slot: A=${aResult} B=${bResult}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid === 111 || JSON.parse(fs.readFileSync(file, 'utf8')).pid === 222, true);
});

test('a takeover that finds the slot already re-made by someone else leaves it alone', () => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: 1_000_000, token: 'dead-host' }));
  const now = clock(1_000_000 + STALE_MS + 5000);
  let first = true;
  const aFs = { ...fs, readFileSync: (f, ...rest) => {
    if (f === file && !first) fs.writeFileSync(file, JSON.stringify({ pid: 333, at: now(), token: 'fresh' }));   // another host got there between judge and break
    first = false;
    return fs.readFileSync(f, ...rest);
  } };
  const a = createSlot({ file, pid: 111, now, isAlive: (p) => p !== 4242, fsImpl: aFs });
  assert.strictEqual(a.tryAcquire(), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'fresh', 'the fresh slot was not deleted');
});

test('the takeover claim never outlives the takeover, and a crashed claimant\'s claim goes stale', () => {
  const dir = tmp();
  const file = path.join(dir, 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: 1_000_000, token: 'dead-host' }));
  const now = clock(1_000_000 + STALE_MS + 5000);
  const a = createSlot({ file, pid: 111, now, isAlive: (p) => p !== 4242 });
  assert.strictEqual(a.tryAcquire(), true);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['job.lock'], 'no claim file left behind');
  a.release();
  // a claimant that died between creating its claim and removing it
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: 1_000_000, token: 'dead-host' }));
  fs.writeFileSync(file + '.takeover', '{}');
  const b = createSlot({ file, pid: 222, now, isAlive: (p) => p !== 4242 });
  assert.strictEqual(b.tryAcquire(), false, 'a fresh claim is respected');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file + '.takeover', old, old);
  assert.strictEqual(b.tryAcquire(), false, 'the stale claim is cleared on this tick...');
  assert.strictEqual(b.tryAcquire(), true, '...and the takeover goes through on the next');
});
