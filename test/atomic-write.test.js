'use strict';
/**
 * Atomic write-and-rename, and why the rename needs a retry.
 *
 * MEASURED, on this machine, during the 2026-09-18 merge gate:
 *
 *   Error: EPERM: operation not permitted, rename
 *   'C:\...\Temp\cc-vault-jY2QuF\.secrets-46740-1789774020642.tmp'
 *   -> 'C:\...\Temp\cc-vault-jY2QuF\secrets.enc'
 *
 * Nothing was wrong with the file, the directory or the permissions. On
 * Windows a rename fails with EPERM/EACCES/EBUSY whenever ANY process holds a
 * handle to either path for a moment, and something always does: the
 * real-time antivirus scan of the file we just wrote is the usual one, an
 * indexer or a backup agent the others. It clears in milliseconds.
 *
 * Unretried, that surfaced as a vault save or a settings write simply
 * throwing -- a secret the UI showed as saved that was not on disk.
 */
const test = require('node:test');
const assert = require('node:assert');

const { renameWithRetry } = require('../host/atomic-write');

// A rename that fails with `codes` in order, then succeeds. Records attempts.
function flaky(codes) {
  const calls = [];
  let i = 0;
  const fn = (from, to) => {
    calls.push([from, to]);
    const code = codes[i++];
    if (!code) return;
    const err = new Error(`${code}: operation not permitted, rename`);
    err.code = code;
    throw err;
  };
  fn.calls = calls;
  return fn;
}

test('a rename that fails EPERM once and then succeeds does not throw', () => {
  // The bug, stated as the behaviour the user experiences: the save works.
  const rename = flaky(['EPERM']);
  const slept = [];
  renameWithRetry('a.tmp', 'b', { rename, sleep: (ms) => slept.push(ms) });
  assert.strictEqual(rename.calls.length, 2, 'it must try again after EPERM');
  assert.deepStrictEqual(rename.calls[1], ['a.tmp', 'b']);
  assert.strictEqual(slept.length, 1, 'it must wait before retrying, not spin');
});

test('a non-transient failure is thrown at once, not retried', () => {
  // ENOENT means the temp file we just wrote is not there -- a real bug in
  // the caller, or a disk that lost it. Retrying cannot help, and waiting
  // five times to rethrow the same error turns a clear failure into a slow
  // one. ENOSPC is the same: the disk will not become un-full in 10ms.
  for (const code of ['ENOENT', 'ENOSPC', 'EROFS']) {
    const rename = flaky([code, code, code, code, code]);
    assert.throws(() => renameWithRetry('a.tmp', 'b', { rename, sleep: () => {} }),
      (err) => err.code === code, code);
    assert.strictEqual(rename.calls.length, 1, `${code} must not be retried`);
  }
});

test('every transient Windows code is retried', () => {
  // All three are the same underlying condition -- someone holds a handle --
  // and which one Windows reports depends on how it was opened. Retrying
  // EPERM but not EBUSY would fix the bug only on the machines that happened
  // to report EPERM.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const rename = flaky([code]);
    renameWithRetry('a.tmp', 'b', { rename, sleep: () => {} });
    assert.strictEqual(rename.calls.length, 2, `${code} must be retried`);
  }
});

test('a rename that never recovers throws, and throws the REAL error', () => {
  // Fails closed and fails honestly. The caller has to be able to tell EPERM
  // from a full disk, so the original error is rethrown rather than wrapped
  // in something generic -- and the save must NOT be reported as done.
  const rename = flaky(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']);
  assert.throws(() => renameWithRetry('a.tmp', 'b', { rename, sleep: () => {} }),
    (err) => err.code === 'EBUSY' && /rename/.test(err.message));
  assert.strictEqual(rename.calls.length, 5, 'bounded: it must give up, not spin forever');
});

test('the wait BACKS OFF, so five attempts cover more than an instant', () => {
  // A fixed 10ms x 4 is 40ms of cover, which is shorter than the antivirus
  // scan that causes this. Backing off spans long enough to outlast a real
  // handle without making the happy path wait at all.
  const rename = flaky(['EPERM', 'EPERM', 'EPERM', 'EPERM']);
  const slept = [];
  renameWithRetry('a.tmp', 'b', { rename, sleep: (ms) => slept.push(ms) });
  assert.strictEqual(slept.length, 4);
  for (let i = 1; i < slept.length; i++) {
    assert.ok(slept[i] > slept[i - 1], `wait ${i} (${slept[i]}ms) must exceed ${slept[i - 1]}ms`);
  }
  const total = slept.reduce((a, b) => a + b, 0);
  assert.ok(total >= 150, `only ${total}ms of cover is not worth the complexity`);
});

test('a rename that works first time never sleeps', () => {
  // The cost of this helper on the overwhelmingly common path must be zero.
  const rename = flaky([]);
  let slept = 0;
  renameWithRetry('a.tmp', 'b', { rename, sleep: () => { slept++; } });
  assert.strictEqual(rename.calls.length, 1);
  assert.strictEqual(slept, 0);
});

// --- the real defaults, exercised against a real filesystem -------------------

const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-atomic-'));
}

test('with no options it renames a real file using the real fs', () => {
  // The injected `rename` above is what makes the retry testable, but it also
  // means every test so far would pass with no default wired up at all.
  const dir = tmpdir();
  const from = path.join(dir, 'x.tmp');
  const to = path.join(dir, 'x');
  fs.writeFileSync(from, 'payload');

  renameWithRetry(from, to);

  assert.strictEqual(fs.readFileSync(to, 'utf8'), 'payload');
  assert.strictEqual(fs.existsSync(from), false, 'the temp must be gone');
});

test('the default sleep actually blocks, and does not spin the CPU', () => {
  // Both callers are synchronous, so the wait has to be synchronous too.
  // setTimeout cannot be used and a busy loop would burn a core for 300ms on
  // a machine already under the load that caused the EPERM.
  const { sleepSync } = require('../host/atomic-write');
  const t0 = Date.now();
  sleepSync(40);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 35, `slept ${elapsed}ms, expected to block for about 40`);
  assert.ok(elapsed < 400, `slept ${elapsed}ms, which is not a 40ms sleep`);
});
