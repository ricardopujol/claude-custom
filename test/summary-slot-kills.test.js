'use strict';
/**
 * Kill tests for host/summary-slot.js, from Mortimer's gate on release PR #109 (survivors 2 and 3).
 *
 * 2. release() must delete only the slot THIS host took. The race the token exists for: A holds the slot, B breaks it as
 *    stale and takes it, then A's late release() must not delete B's live slot (a third host would then start a second
 *    GPU job).
 * 3. The default liveness probe (no injected isAlive) was dead code to the suite: every test injects one. A live holder
 *    must block, a dead holder must be taken over, and EPERM (a live process we can't signal) counts as alive.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./tmp-dir');

const { createSlot, STALE_MS } = require('../host/summary-slot');

const tmp = () => tmpDir('slot-kills-');
const clock = (t = 1_000_000) => { const f = () => t; f.set = (v) => { t = v; }; return f; };

test('a late release() from a host whose slot was broken as stale leaves the new holder\'s slot alone', () => {
  const file = path.join(tmp(), 'job.lock');
  const now = clock();
  const a = createSlot({ file, now, pid: 111, isAlive: () => true });
  const b = createSlot({ file, now, pid: 222, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  now.set(now() + STALE_MS + 1);                 // A's job outlived any job: B may break its slot
  assert.strictEqual(b.tryAcquire(), true);
  const bBody = fs.readFileSync(file, 'utf8');
  assert.strictEqual(JSON.parse(bBody).pid, 222);

  a.release();                                    // A finally finishes

  assert.strictEqual(fs.existsSync(file), true, 'B\'s slot must survive A\'s late release');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), bBody);
  // ... and a third host is still refused while B holds it.
  const c = createSlot({ file, now, pid: 333, isAlive: () => true });
  assert.strictEqual(c.tryAcquire(), false);
});

test('a release() with the slot already gone does not throw', () => {
  const file = path.join(tmp(), 'job.lock');
  const a = createSlot({ file, pid: 111, isAlive: () => true });
  assert.strictEqual(a.tryAcquire(), true);
  fs.unlinkSync(file);
  assert.doesNotThrow(() => a.release());
  assert.strictEqual(fs.existsSync(file), false);
});

test('default liveness probe: a slot held by a live process blocks acquire', () => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'x' }));
  const s = createSlot({ file });
  assert.strictEqual(s.tryAcquire(), false);
  assert.strictEqual(fs.existsSync(file), true);
});

test('default liveness probe: a slot held by a process that no longer exists is taken over', () => {
  const file = path.join(tmp(), 'job.lock');
  const child = spawnSync(process.execPath, ['-e', '0']);   // runs, exits, and its pid is then free
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, at: Date.now(), token: 'y' }));
  const s = createSlot({ file });
  assert.strictEqual(s.tryAcquire(), true);
  assert.notStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'y');
  s.release();
});

test('default liveness probe signals with 0 (existence only), against the holder\'s pid', (t) => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 424242, at: Date.now(), token: 'z' }));
  const calls = [];
  t.mock.method(process, 'kill', (pid, sig) => { calls.push([pid, sig]); return true; });
  const s = createSlot({ file });
  assert.strictEqual(s.tryAcquire(), false);
  assert.deepStrictEqual(calls, [[424242, 0]]);
});

test('default liveness probe: EPERM means the process exists (alive), any other error means gone', (t) => {
  const file = path.join(tmp(), 'job.lock');
  const body = JSON.stringify({ pid: 424242, at: Date.now(), token: 'z' });

  fs.writeFileSync(file, body);
  const raise = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const m = t.mock.method(process, 'kill', raise('EPERM'));
  assert.strictEqual(createSlot({ file }).tryAcquire(), false, 'EPERM: a live process we can\'t signal still holds it');

  m.mock.restore();
  t.mock.method(process, 'kill', raise('ESRCH'));
  assert.strictEqual(createSlot({ file }).tryAcquire(), true, 'ESRCH: gone, taken over');
});

test('default liveness probe: a thrown value with no code is not read as EPERM', (t) => {
  const file = path.join(tmp(), 'job.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 424242, at: Date.now(), token: 'z' }));
  t.mock.method(process, 'kill', () => { throw undefined; });   // eslint-disable-line no-throw-literal
  assert.strictEqual(createSlot({ file }).tryAcquire(), true);
});
