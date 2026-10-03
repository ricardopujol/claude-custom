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

const { createSlot, STALE_MS } = require('../host/summary-slot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
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
