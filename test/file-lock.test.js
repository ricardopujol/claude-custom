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
const { tmpDir } = require('./tmp-dir');

const tmpdir = () => tmpDir('cc-lock-');
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
  // this test green, verify/probe-vault-concurrency.js measured 2 of 120
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

// --- liveness: every path must reach the deadline ----------------------------
//
// Mortimer, PR #29 mutation gate. Found on the UNMUTATED shipped code, not by
// a mutant: `withFileLock` could spin forever.
//
// The stale-breaking branch ended in `continue`, which jumps the deadline
// check below it. If readLock returned null (the path could not be read) AND
// unlinkSync failed (the path could not be deleted), the loop went round
// again, read null again, failed to unlink again, and never terminated. The
// empty catch treated "somebody beat us to it" and "this cannot be removed"
// as the same event, and only the first is safe to retry immediately.
//
// A HANG IS WORSE THAN THE THROW DEXTER F2 CLOSED. sleepSync uses
// Atomics.wait, so the thread blocks; the host owns the pty, so the Claude
// session goes with it. And this module's own header promises the opposite in
// capitals: FAIL CLOSED, it throws and the work does not run.
//
// Realistic trigger on Windows: any lock file another process holds open
// without share-delete -- an antivirus scanner, a backup agent, a crashed host
// still holding the handle -- is both unreadable and undeletable.

test('a lock path that can be neither read nor deleted fails closed instead of hanging', () => {
  // A directory where the lock file should be: readFileSync throws EISDIR, so
  // readLock returns null; unlinkSync refuses to remove a directory. Exactly
  // the pair that used to loop.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.mkdirSync(lock, { recursive: true });

  const started = Date.now();
  let ran = false;
  assert.throws(() => withFileLock(lock, () => { ran = true; }, { deadlineMs: 200 }), /lock/i);
  const waited = Date.now() - started;
  assert.strictEqual(ran, false, 'the work must not run without the lock');
  assert.ok(waited < 5000, `must give up, not spin -- still going after ${waited}ms`);
});

test('a deadline of 0 means try once and do not wait', () => {
  // Mortimer: `Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEADLINE_MS`
  // is a ternary with a bare CALL as its test, which StrykerJS generates no
  // mutant for -- so nothing in a mutation score can tell you this default is
  // right. Swapping the isFinite check for a truthy one would silently turn 0
  // into 3000. Asserted explicitly, because the tool cannot.
  const lock = lockIn(tmpdir());
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const started = Date.now();
  assert.throws(() => withFileLock(lock, () => {}, { deadlineMs: 0 }), /lock/i);
  assert.ok(Date.now() - started < 200, 'a zero deadline must not wait');
});

// --- the rules the tests were only accidentally enforcing --------------------
//
// Mortimer, PR #29 mutation gate, R1a/R1b/R1c. All three are LATENT: the
// shipped code is correct and the suite could not tell.

test('a holder we may not signal (EPERM) is ALIVE, not stale', () => {
  // `kill` failing with EPERM means the process EXISTS and belongs to another
  // user. Treating that as dead breaks a live lock -- the same failure class
  // as the pid bug this module already shipped once. The comment on the catch
  // names EPERM explicitly; nothing asserted it, because deadPid() only ever
  // produces ESRCH.
  const real = process.kill;
  process.kill = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  try {
    assert.strictEqual(isStale({ pid: 4321, at: Date.now() }, Date.now()), false);
  } finally {
    process.kill = real;
  }
});

test('an unusable pid never reaches process.kill at all', () => {
  // THE RULE, not the outcome. The test above this one is titled "never
  // PROBED" and asserted only the return value -- and `process.kill(0, 0)`
  // does not throw on this machine, so narrowing the guard to `pid < 0` let
  // pid 0 reach `kill`, return false, and keep that test green. Since
  // `kill(0, …)` addresses the caller's whole PROCESS GROUP, "never probed" is
  // the load-bearing half, and it was enforced by nothing but a coincidence of
  // Windows semantics.
  const real = process.kill;
  const calls = [];
  process.kill = (pid, sig) => { calls.push(pid); return real.call(process, pid, sig); };
  try {
    for (const pid of [0, -1, -12345, 1.5, NaN, null, undefined, 'x']) {
      isStale({ pid, at: Date.now() }, Date.now());
    }
  } finally {
    process.kill = real;
  }
  assert.deepStrictEqual(calls, [], `these unusable pids were signalled: ${calls.join(', ')}`);
});

test('the lock we hold names our pid, so a competitor can probe us', () => {
  // The other half of the empty-file window. isStale's reaction to a pid-less
  // lock is tested; that withFileLock ever WRITES a pid was not -- deleting
  // the writeSync left every test green, with the lock permanently empty and
  // every contended write degrading into a full deadline stall.
  const lock = lockIn(tmpdir());
  let seen = null;
  withFileLock(lock, () => { seen = JSON.parse(fs.readFileSync(lock, 'utf8')); });
  assert.strictEqual(seen.pid, process.pid);
  assert.ok(Number.isFinite(seen.at), 'the lock must carry a usable age');
});

test('a genuine filesystem error surfaces at once, not as a lock timeout 3 seconds later', () => {
  // Mortimer: `err.code !== 'EEXIST'` mutated to `false` swallows a real error
  // into the retry loop, where it resurfaces as "could not take the lock" --
  // a message that sends the reader looking for a competing process that does
  // not exist. Only EEXIST means "somebody holds it".
  const missing = path.join(tmpdir(), 'no-such-dir', 'thing.json.lock');
  const started = Date.now();
  assert.throws(() => withFileLock(missing, () => {}), (err) => err.code === 'ENOENT');
  assert.ok(Date.now() - started < 500, 'it must not spend the deadline on it');
});

test('waiting sleeps rather than spinning -- the host owns the pty', () => {
  // Mortimer: three mutants delete the sleep, turning the retry loop into a
  // busy-wait that burns a core in the process running the terminal. The
  // Atomics.wait comment exists to prevent exactly that and nothing asserted
  // it. Counted by attempts rather than by CPU, which is the observable half.
  const dir = tmpdir();
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));

  const realRead = fs.readFileSync;
  let attempts = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === lock) attempts++;
    return realRead.apply(fs, args);
  };
  try {
    assert.throws(() => withFileLock(lock, () => {}, { deadlineMs: 150 }), /lock/i);
  } finally {
    fs.readFileSync = realRead;
  }
  // ~10 attempts at RETRY_MS=15 over 150ms. A busy-wait makes tens of thousands.
  assert.ok(attempts > 0 && attempts < 50, `expected a paced retry, got ${attempts} attempts`);
});

// --- the other half of the liveness fix --------------------------------------
//
// Mortimer, PR #29 mutation re-run, R13. The deadline check stops the HANG and
// is fully pinned -- two of its mutants die as timeouts, which is the tool
// recreating the original defect and these tests catching it. The `broke`
// classification is the other half, and it was pinned by nothing: four mutants
// on it, all surviving, verified by building each one and running this whole
// file against it (25/25 passed every time).
//
// Why the two tests above cannot see it, both being otherwise correct:
//   - the directory test asserts `waited < 5000`, and a busy-spin also gives
//     up on time, so it passes;
//   - the pacing test has exactly the right instrument, the attempt counter,
//     but points it at a lock held by a LIVE pid -- isStale returns false, the
//     breaking branch never runs, and `broke` is never assigned at all.
//
// Measured: `broke = true` spins 1763 attempts in 150ms and
// `broke = err.code !== 'ENOENT'` spins 1421, where the shipped code does
// about ten. A core burned inside the process that owns the pty, which is
// precisely what the Atomics.wait comment exists to prevent.

test('an undeletable lock path is PACED, not retried at full speed', () => {
  const lock = lockIn(tmpdir());
  fs.mkdirSync(lock, { recursive: true });      // unreadable AND undeletable

  const realRead = fs.readFileSync;
  let attempts = 0;
  fs.readFileSync = (...a) => {
    if (String(a[0]) === lock) attempts++;
    return realRead.apply(fs, a);
  };
  try {
    assert.throws(() => withFileLock(lock, () => {}, { deadlineMs: 150 }), /lock/i);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.ok(attempts > 0 && attempts < 50, `expected a paced retry, got ${attempts} attempts`);
});

test('a zero deadline gives up on the FIRST check -- the deadline is inclusive', () => {
  // Mortimer's own correction, and the sharper finding of the two. He first
  // filed `now() >= giveUpAt -> >` as an EQUIVALENT mutant -- "differs only if
  // the clock lands exactly on the deadline, costing one extra 15ms retry".
  // It is not equivalent: with an injected clock it never terminates. The same
  // liveness class as the bug this file just fixed, one character away.
  //
  // It also escaped the report: Stryker called it Killed, and running this
  // suite against the built mutant passed 25/25 -- because the `deadlineMs: 0`
  // test uses the REAL clock, which advances on the next retry and lets the
  // mutant out. Only an injected clock reaches it.
  //
  // BUT A FROZEN CLOCK IS THE WRONG INSTRUMENT, and he measured why: against
  // the mutant it does not fail, it HANGS, and no per-test timeout can stop it
  // -- the retry loop is fully synchronous and `sleepSync` uses Atomics.wait,
  // so the thread never yields and node's test timer never gets a turn. `npm
  // test` would hang forever instead of going red: a stuck CI job rather than
  // a failing build, and Ctrl-C rather than a message locally. A suite that
  // hangs is the one that gets a test deleted six months later.
  //
  // So the clock SITS ON the deadline for a few reads and then jumps well past
  // it. Both versions terminate, and the attempt count says which check fired.
  const lock = lockIn(tmpdir());
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  let reads = 0;
  const now = () => (reads++ < 8 ? 1000 : 9999999);

  const realRead = fs.readFileSync;
  let attempts = 0;
  fs.readFileSync = (...a) => {
    if (String(a[0]) === lock) attempts++;
    return realRead.apply(fs, a);
  };
  try {
    assert.throws(() => withFileLock(lock, () => {}, { deadlineMs: 0, now }), /lock/i);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.strictEqual(attempts, 1, `a zero deadline must give up on the first check, took ${attempts}`);
});

test('a lock whose mtime cannot be read is broken, not treated as a tombstone', () => {
  // Mortimer's second correction. He filed the `catch { return parsed; }` in
  // readLock as "not producible deterministically"; it is producible with a
  // statSync stub, exactly like the process.kill stub above, and the
  // behaviours differ materially.
  //
  // Measured: the shipped code acquires in 1ms; the mutant burns the whole
  // deadline and refuses. `readLock` returns null when it can learn nothing,
  // so `held === null` breaks the lock. Returning `{ pid: null, at: null }`
  // instead makes isStale call it not-stale forever -- the permanent tombstone
  // the mtime fallback exists to prevent, per its own comment.
  const lock = lockIn(tmpdir());
  fs.writeFileSync(lock, 'not json at all');

  const realStat = fs.statSync;
  fs.statSync = (...a) => {
    if (String(a[0]) === lock) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
    return realStat.apply(fs, a);
  };
  try {
    assert.strictEqual(withFileLock(lock, () => 'took it', { deadlineMs: 200 }), 'took it');
  } finally {
    fs.statSync = realStat;
  }
});
