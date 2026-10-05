'use strict';
/**
 * Boundary kill tests for host/summary-slot.js, from Mortimer's gate on release PR #109 (survivor 4): a slot is stale
 * strictly AFTER staleMs, a takeover claim strictly AFTER CLAIM_STALE_MS, a slot that vanishes between create() and
 * holder() is simply created, and a slot that changed under the claim is never broken.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createSlot } = require('../host/summary-slot');

const tmp = () => tmpDir('slot-bounds-');
const STALE = 1000;
const CLAIM_STALE_MS = 10_000;   // the module's constant, not exported

const setAge = (file, ms, at) => { const s = (at - ms) / 1000; fs.utimesSync(file, s, s); };

test('a slot whose holder is alive is held at exactly staleMs and stale one ms later', () => {
  const file = path.join(tmp(), 'job.lock');
  let t = 5_000_000;
  const now = () => t;
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: t, token: 'x' }));
  const s = createSlot({ file, now, pid: 222, isAlive: () => true, staleMs: STALE });
  t += STALE;
  assert.strictEqual(s.tryAcquire(), false, 'exactly staleMs old is not yet stale');
  t += 1;
  assert.strictEqual(s.tryAcquire(), true, 'one ms past it is');
});

test('an unreadable-as-JSON slot is judged by its age on disk: held at exactly staleMs, taken one ms later', (t) => {
  const file = path.join(tmp(), 'job.lock');
  const D = 1_700_000_000_000;
  fs.writeFileSync(file, 'not json');
  t.mock.method(Date, 'now', () => D);
  const s = createSlot({ file, pid: 222, isAlive: () => true, staleMs: STALE });
  setAge(file, STALE, D);
  assert.strictEqual(s.tryAcquire(), false, 'exactly staleMs on disk is held');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'not json');
  setAge(file, STALE + 1, D);
  assert.strictEqual(s.tryAcquire(), true, 'one ms older is abandoned');
});

test('a takeover claim is cleared only when strictly older than the claim limit', (t) => {
  const dir = tmp();
  const file = path.join(dir, 'job.lock');
  const claim = file + '.takeover';
  const D = 1_700_000_000_000;
  let n = 5_000_000;
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: n - 10 * STALE, token: 'x' }));   // stale
  fs.writeFileSync(claim, '{}');
  t.mock.method(Date, 'now', () => D);
  const s = createSlot({ file, now: () => n, pid: 222, isAlive: () => true, staleMs: STALE });

  setAge(claim, CLAIM_STALE_MS, D);
  assert.strictEqual(s.tryAcquire(), false, 'somebody else holds the claim');
  assert.strictEqual(fs.existsSync(claim), true, 'a claim exactly at the limit is still respected');

  setAge(claim, CLAIM_STALE_MS + 1, D);
  assert.strictEqual(s.tryAcquire(), false, 'the clearing tick itself does not take over');
  assert.strictEqual(fs.existsSync(claim), false, 'a claim older than the limit is cleared');
  assert.strictEqual(s.tryAcquire(), true, 'and the next tick goes through');
});

test('a slot that vanishes between the failed create and the read is created at once', () => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: Date.now(), token: 'x' }));   // fresh, live: would be held
  let reads = 0;
  const fsImpl = {
    ...fs,
    readFileSync(f, ...rest) {
      if (f === file && reads++ === 0) { fs.unlinkSync(file); const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
      return fs.readFileSync(f, ...rest);
    },
  };
  const s = createSlot({ file, pid: 222, isAlive: () => true, fsImpl });
  assert.strictEqual(s.tryAcquire(), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
});

test('a stale slot that was replaced by another host while the claim was taken is left alone, and the claim is dropped', () => {
  const file = path.join(tmp(), 'job.lock');
  const fresh = JSON.stringify({ pid: 333, at: Date.now(), token: 'new' });
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: 1, token: 'old' }));
  let reads = 0;
  const fsImpl = {
    ...fs,
    readFileSync(f, ...rest) {
      if (f === file && reads++ === 1) fs.writeFileSync(file, fresh);   // the second look, under the claim
      return fs.readFileSync(f, ...rest);
    },
  };
  const s = createSlot({ file, pid: 222, isAlive: () => true, staleMs: STALE, fsImpl });
  assert.strictEqual(s.tryAcquire(), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), fresh, 'the new holder\'s slot survives');
  assert.strictEqual(fs.existsSync(file + '.takeover'), false, 'the claim is released');
});

test('a stale slot that disappears under the claim is simply created', () => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: 1, token: 'old' }));
  let reads = 0;
  const fsImpl = {
    ...fs,
    readFileSync(f, ...rest) {
      if (f === file && reads++ === 1) fs.unlinkSync(file);
      return fs.readFileSync(f, ...rest);
    },
  };
  const s = createSlot({ file, pid: 222, isAlive: () => true, staleMs: STALE, fsImpl });
  assert.strictEqual(s.tryAcquire(), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  assert.strictEqual(fs.existsSync(file + '.takeover'), false);
});
