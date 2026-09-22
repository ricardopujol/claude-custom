'use strict';
/**
 * A cross-process mutex for one file.
 *
 * Dexter, PR #29 review, F3B. `host/store.js`'s own header has documented the
 * hole since the multi-project change landed: `update()` is read-modify-write,
 * which is not atomic ACROSS PROCESSES. Two hosts both read N and both write
 * N+1; two events happened and the file says one.
 *
 * It was a documented, deliberately-deferred defect while everything in the
 * store was regenerable convenience state. The bug vault is the first consumer
 * holding records a user cannot reconstruct, so the same race stops being an
 * off-by-one in a counter and becomes a lost piece of evidence. And because
 * `.harness/state` is install-wide, it is not "two windows on one project" --
 * it is EVERY PAIR OF OPEN WINDOWS, across every project.
 *
 * `fs.openSync(path, 'wx')` is an atomic create-or-fail on both Windows and
 * POSIX, which is the whole mechanism. Everything else here is about not
 * deadlocking forever when a holder dies without cleaning up.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withFileLock, isStale, STALE_MS, DEADLINE_MS } = require('../host/file-lock');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lock-'));
const lockIn = (dir) => path.join(dir, 'thing.json.lock');

test('the work runs and its value comes back', () => {
  const lock = lockIn(tmpdir());
  assert.strictEqual(withFileLock(lock, () => 42), 42);
});

test('the lock file is gone afterwards', () => {
  const lock = lockIn(tmpdir());
  withFileLock(lock, () => 'x');
  assert.strictEqual(fs.existsSync(lock), false);
});

test('the lock exists WHILE the work runs -- otherwise it is not a lock', () => {
  const lock = lockIn(tmpdir());
  let seen = null;
  withFileLock(lock, () => { seen = fs.existsSync(lock); });
  assert.strictEqual(seen, true);
});

test('a throw from the work releases the lock and still propagates', () => {
  // A lock leaked by an exception is a vault that never writes again.
  const lock = lockIn(tmpdir());
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(lock), false);
});

test('a lock held by a live process is NOT taken, and the attempt fails closed', () => {
  // The case the whole module exists for. It must refuse rather than proceed
  // unlocked -- proceeding is exactly the lost update we are here to stop.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  let ran = false;
  assert.throws(() => withFileLock(lock, () => { ran = true; }, { deadlineMs: 120 }), /lock/i);
  assert.strictEqual(ran, false, 'the work must not run without the lock');
  assert.strictEqual(fs.existsSync(lock), true, 'someone else’s lock must survive our failure');
});

test('waiting for a held lock is bounded by wall clock, not by attempts', () => {
  // The bound this project asks for by name: a retry loop that counts tries
  // has no idea how long it has blocked the caller.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const started = Date.now();
  assert.throws(() => withFileLock(lock, () => {}, { deadlineMs: 150 }));
  const waited = Date.now() - started;
  assert.ok(waited >= 100, `must actually wait, waited ${waited}ms`);
  assert.ok(waited < 2000, `must give up near the deadline, waited ${waited}ms`);
});

test('a lock left behind by a DEAD process is broken and the work proceeds', () => {
  // The failure this would otherwise cause is permanent: one crashed host and
  // the vault never accepts another record.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: Date.now() }));
  assert.strictEqual(withFileLock(lock, () => 'took it', { deadlineMs: 200 }), 'took it');
  assert.strictEqual(fs.existsSync(lock), false);
});

test('an OLD lock is broken even if its pid happens to be alive', () => {
  // pids are reused. A holder that has been sitting on the lock far longer
  // than any write could take is treated as gone.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - STALE_MS - 1 }));
  assert.strictEqual(withFileLock(lock, () => 'took it', { deadlineMs: 200 }), 'took it');
});

test('a lock file that is not JSON is not trusted forever', () => {
  // Unparseable means we cannot read its age from the contents, so the file's
  // own mtime decides. It must not become a permanent tombstone.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, 'not json at all');
  const old = Date.now() - STALE_MS - 1000;
  fs.utimesSync(lock, old / 1000, old / 1000);
  assert.strictEqual(withFileLock(lock, () => 'took it', { deadlineMs: 200 }), 'took it');
});

// --- isStale, and the boundaries the constants encode ------------------------
//
// STALE_MS and DEADLINE_MS live at module scope, which means StrykerJS and
// mutmut alike generate NO mutants for them: a mutation score says nothing
// about whether these boundaries are asserted. CLAUDE.md records that trap at
// length -- tuned thresholds are the numbers most likely to be wrong and least
// likely to be pinned. So they are pinned explicitly, here.

test('a lock younger than STALE_MS is not stale', () => {
  assert.strictEqual(isStale({ pid: process.pid, at: Date.now() - (STALE_MS - 1) }, Date.now()), false);
});

test('a lock of exactly STALE_MS is not yet stale -- the boundary is inclusive', () => {
  const now = Date.now();
  assert.strictEqual(isStale({ pid: process.pid, at: now - STALE_MS }, now), false);
});

test('a lock one millisecond past STALE_MS is stale', () => {
  const now = Date.now();
  assert.strictEqual(isStale({ pid: process.pid, at: now - STALE_MS - 1 }, now), true);
});

test('a dead pid is stale immediately, however fresh the lock', () => {
  assert.strictEqual(isStale({ pid: deadPid(), at: Date.now() }, Date.now()), true);
});

test('an unusable pid is never PROBED -- and is not assumed dead either', () => {
  // `process.kill(0, 0)` addresses the caller's whole PROCESS GROUP and
  // `kill(-1, 0)` every process the user can signal, so these values must
  // never reach `kill`. A lock file is whatever was on disk.
  //
  // THIS TEST USED TO ASSERT THE OPPOSITE and was pinning a real bug. It said
  // an unusable pid meant "stale", which let a fresh lock be broken instantly:
  // `openSync(path, 'wx')` creates the file EMPTY and writes the pid a moment
  // later, so a competitor reading in that window sees no pid at all. With
  // this test green, test/bugvault-concurrent.test.js measured 2 of 120
  // records lost WITH the lock in place. "Cannot prove it is dead" is not
  // "assume it is dead".
  for (const pid of [0, -1, -12345, 1.5, NaN, null, undefined, 'x']) {
    assert.strictEqual(isStale({ pid, at: Date.now() }, Date.now()), false,
      `a FRESH lock claiming pid ${JSON.stringify(pid)} must be left alone`);
  }
});

test('an unusable pid does not make a lock immortal -- age still breaks it', () => {
  // The other half. Refusing to break an unprobeable lock is only safe because
  // age remains an independent reason, so nothing can wedge the vault forever
  // by writing a lock file with no pid in it.
  const now = Date.now();
  for (const pid of [0, -1, null, 'x']) {
    assert.strictEqual(isStale({ pid, at: now - STALE_MS - 1 }, now), true,
      `an OLD lock claiming pid ${JSON.stringify(pid)} must be breakable`);
  }
});

test('a lock with neither a usable pid nor an age is left alone, not broken', () => {
  // Fail closed. Nothing is known about this holder, so the caller waits out
  // its deadline and reports a refusal -- visible -- rather than breaking a
  // lock that may well be live and losing a record silently.
  assert.strictEqual(isStale({ pid: null }, Date.now()), false);
  assert.strictEqual(isStale({ pid: null, at: 'yesterday' }, Date.now()), false);
  assert.strictEqual(isStale({}, Date.now()), false);
});

test('a lock file with no age on disk still gets one, from its mtime', () => {
  // Which is what stops the case above from being a tombstone in practice:
  // withFileLock never sees an ageless lock, because the file always has an
  // mtime even when its contents do not carry `at`.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));   // no `at`
  const old = Date.now() - STALE_MS - 1000;
  fs.utimesSync(lock, old / 1000, old / 1000);
  assert.strictEqual(withFileLock(lock, () => 'took it', { deadlineMs: 200 }), 'took it');
});

test('the deadline is shorter than the stale window, or nothing would ever wait', () => {
  // A relationship, not a value: if giving up took longer than declaring the
  // holder dead, the waiting branch would be unreachable.
  assert.ok(DEADLINE_MS < STALE_MS, `${DEADLINE_MS} must be < ${STALE_MS}`);
});

// A pid that is almost certainly not running. High, and probed to be sure --
// if it IS alive on this machine the test would be asserting nothing, so it
// says so rather than passing quietly.
function deadPid() {
  for (const pid of [999999, 999998, 999997]) {
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return pid; }
  }
  throw new Error('could not find a dead pid to test with');
}
