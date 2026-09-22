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

// Shared by the sync and async validation tests, so the two cannot diverge.
//
// `undefined` is deliberately NOT here: it means "use the default", which is
// the documented way to call this, and adding it to the list made the async
// test fail -- correctly. The values below are the ones with no sensible
// reading, every one of which used to produce an unbounded loop.
const BAD_ATTEMPTS = [NaN, Infinity, -Infinity, 0, -1, 2.5, '5', null];

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
  // EXACT, not a tolerance. Dexter, Finding 4: the previous assertion was
  // `total >= 150`, and FIRST_WAIT_MS = 10 produces [10,20,40,80] = 150, which
  // passes ON the boundary while halving the cover the module argues it needs.
  // `wait *= 3` -> [20,60,180,540] passed too. Neither the starting wait nor
  // the doubling factor was pinned by anything.
  //
  // And nothing else pins them either: StrykerJS has no numeric-literal
  // mutator, so ATTEMPTS and FIRST_WAIT_MS generate ZERO mutants -- not a 0/0
  // line, simply absent from the report. This one assertion is what a numeric
  // mutant would have demanded if the tool could produce one.
  assert.deepStrictEqual(slept, [20, 40, 80, 160]);
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

test('a nonsense attempts count is REFUSED, not looped on forever', () => {
  // Dexter, Finding 6. `for (let i = 1; ; i++)` with `i >= attempts` as the
  // only exit never terminates for NaN: every comparison against NaN is false,
  // `wait` doubles to Infinity after ~1070 passes, and Atomics.wait with an
  // Infinity timeout blocks forever -- a synchronous, uninterruptible hang of
  // the calling process, which for the vault is Electron's main process.
  //
  // NOTE ON HOW THIS WAS VERIFIED: this test could not be watched go red in
  // process. With `sleep` injected as a no-op the pre-fix code is a synchronous
  // infinite loop, which blocks the event loop so node:test's own timeout can
  // never fire -- it hangs the runner rather than failing it. Its power was
  // proven instead by running it against the unfixed function in a subprocess
  // with a hard kill; see the commit message for the measurement.
  const alwaysEPERM = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  for (const attempts of BAD_ATTEMPTS) {
    assert.throws(
      () => renameWithRetry('a.tmp', 'b', { rename: alwaysEPERM, sleep: () => {}, attempts }),
      /positive integer/,
      `attempts: ${String(attempts)} must not hang`,
    );
  }
});

// --- the ASYNC sibling, for callers that cannot block ------------------------
// Dexter, Finding 5. host/openrouter.js:104 does the identical
// write-to-temp-then-rename with `await fsp.rename`, inside a try/catch that
// swallows everything. On the machine this whole module exists for -- where a
// handle is held briefly on every write -- that rename throws EPERM, gets
// swallowed, and the model catalogue cache is NEVER written. readCache then
// always returns null, every launch pays a network fetch, and nothing reports
// it, because the comment there says a cache that cannot be written is a
// slower panel rather than a broken one.
//
// The feature is meant to degrade on a FAILED write. It instead never works at
// all, and the graceful catch is exactly what hides that.

const { renameWithRetryAsync } = require('../host/atomic-write');

const flakyAsync = (codes) => {
  const calls = [];
  let i = 0;
  const fn = async (from, to) => {
    calls.push([from, to]);
    const code = codes[i++];
    if (code) { const e = new Error(`${code}: injected`); e.code = code; throw e; }
  };
  fn.calls = calls;
  return fn;
};

test('async: a transient rename is retried and the write survives', async () => {
  const rename = flakyAsync(['EPERM', 'EBUSY']);
  await renameWithRetryAsync('a.tmp', 'b', { rename, sleep: async () => {} });
  assert.strictEqual(rename.calls.length, 3);
});

test('async: a non-transient code is NOT retried', async () => {
  const rename = flakyAsync(['ENOENT']);
  await assert.rejects(
    () => renameWithRetryAsync('a.tmp', 'b', { rename, sleep: async () => {} }),
    /ENOENT/);
  assert.strictEqual(rename.calls.length, 1, 'retrying a missing file buys nothing');
});

test('async: a rename that never recovers still REJECTS', async () => {
  // Same fail-closed rule as the sync version. The caller may choose to
  // swallow it -- openrouter does -- but that has to be the caller's decision,
  // taken knowingly, not something this helper hides.
  const rename = flakyAsync(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
  await assert.rejects(
    () => renameWithRetryAsync('a.tmp', 'b', { rename, sleep: async () => {}, attempts: 5 }),
    /EPERM/);
  assert.strictEqual(rename.calls.length, 5, 'bounded at ATTEMPTS, like the sync version');
});

test('async: the backoff schedule matches the synchronous one', async () => {
  const rename = flakyAsync(['EPERM', 'EPERM', 'EPERM', 'EPERM']);
  const slept = [];
  await renameWithRetryAsync('a.tmp', 'b', {
    rename, sleep: async (ms) => { slept.push(ms); },
  });
  assert.deepStrictEqual(slept, [20, 40, 80, 160]);
});

test('async: a nonsense attempts count is refused, not looped on', async () => {
  const alwaysEPERM = async () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  // The SAME list as the sync version. Miguel: asymmetry between twins is
  // exactly how twins drift, and this guard is literally shared code.
  for (const attempts of BAD_ATTEMPTS) {
    await assert.rejects(
      () => renameWithRetryAsync('a.tmp', 'b', { rename: alwaysEPERM, sleep: async () => {}, attempts }),
      /positive integer/,
      `attempts: ${String(attempts)}`);
  }
});

test('async: the default sleep really waits, and does not block the loop', async () => {
  // The whole reason for a separate async version: this caller CAN yield, so
  // it must, rather than freezing the thread the way Atomics.wait does.
  const rename = flakyAsync(['EPERM']);
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const t0 = Date.now();
  await renameWithRetryAsync('a.tmp', 'b', { rename });
  const took = Date.now() - t0;
  assert.ok(took >= 18, `waited only ${took}ms -- the default async sleep is not real`);
  assert.ok(ticked, 'the event loop must have kept turning during the wait');
});

// --- the invariants, enumerated exhaustively ---------------------------------
// CLAUDE.md expects property-based tests for any module with an invariant worth
// stating. There is no property library in devDependencies, and this input
// space is small enough that adding one would buy less than enumerating it.
//
// PRECISELY WHAT IS ENUMERATED, because the first version of this comment
// overclaimed and Miguel caught it: every (attempts 1..8) x (k) x (code)
// combination for HOMOGENEOUS sequences -- always-fail, or fail k times with
// one code and then succeed. That is exhaustive over those three dimensions
// and NOT over failure patterns generally. Mixed sequences are covered
// separately and explicitly at the end of this file, because the one that
// matters -- a transient code followed by a fatal one -- is the quarantine
// scenario this module's own header documents, and nothing here reached it.

const NON_TRANSIENT = ['ENOENT', 'ENOSPC', 'EROFS', 'EXDEV', 'EISDIR', 'EMFILE', 'EINVAL'];
const ALL_TRANSIENT = ['EPERM', 'EACCES', 'EBUSY'];

test('INVARIANT: a non-transient code is never retried, at any attempts setting', () => {
  for (const code of NON_TRANSIENT) {
    for (let attempts = 1; attempts <= 8; attempts++) {
      const rename = flaky([code]);
      let slept = 0;
      assert.throws(
        () => renameWithRetry('a.tmp', 'b', { rename, sleep: () => { slept++; }, attempts }),
        new RegExp(code),
        `${code} at attempts=${attempts}`);
      assert.strictEqual(rename.calls.length, 1, `${code} must not be retried`);
      assert.strictEqual(slept, 0, `${code} must not sleep`);
    }
  }
});

test('INVARIANT: the rename is never called more than `attempts` times', () => {
  for (const code of ALL_TRANSIENT) {
    for (let attempts = 1; attempts <= 8; attempts++) {
      // Always fails, so the loop runs to its bound every time.
      const rename = flaky(Array(attempts + 5).fill(code));
      assert.throws(
        () => renameWithRetry('a.tmp', 'b', { rename, sleep: () => {}, attempts }),
        new RegExp(code));
      assert.strictEqual(rename.calls.length, attempts,
        `${code} at attempts=${attempts} ran ${rename.calls.length} times`);
    }
  }
});

test('INVARIANT: success at attempt k costs exactly k calls and k-1 sleeps', () => {
  for (const code of ALL_TRANSIENT) {
    for (let attempts = 1; attempts <= 8; attempts++) {
      for (let k = 1; k <= attempts; k++) {
        const rename = flaky(Array(k - 1).fill(code));   // fails k-1 times, then works
        const slept = [];
        renameWithRetry('a.tmp', 'b', { rename, sleep: ms => slept.push(ms), attempts });
        assert.strictEqual(rename.calls.length, k, `${code} k=${k}/${attempts}`);
        assert.strictEqual(slept.length, k - 1, `${code} k=${k}/${attempts} slept wrong`);
      }
    }
  }
});

test('INVARIANT: total sleep is bounded by the doubling schedule, never unbounded', () => {
  // The bound that matters operationally: whatever the caller asks for, the
  // wait is a prefix of 20,40,80,160,... and nothing ever waits longer than
  // the sum of it. This is what makes "300ms of cover" a ceiling and not just
  // a typical case.
  for (let attempts = 1; attempts <= 8; attempts++) {
    const rename = flaky(Array(attempts + 5).fill('EBUSY'));
    const slept = [];
    assert.throws(
      () => renameWithRetry('a.tmp', 'b', { rename, sleep: ms => slept.push(ms), attempts }),
      /EBUSY/);
    const expected = [];
    for (let i = 0; i < attempts - 1; i++) expected.push(20 * (2 ** i));
    assert.deepStrictEqual(slept, expected, `schedule at attempts=${attempts}`);
    const total = slept.reduce((a, b) => a + b, 0);
    assert.strictEqual(total, attempts === 1 ? 0 : 20 * (2 ** (attempts - 1) - 1));
  }
});

test('INVARIANT: the error that escapes is always the LAST one seen', () => {
  // Not the first, and never a stale binding from an earlier pass. Distinct
  // messages per attempt make a stale one unmistakable.
  for (let attempts = 2; attempts <= 6; attempts++) {
    let n = 0;
    const rename = () => {
      n++;
      const e = new Error(`EPERM attempt ${n}`);
      e.code = 'EPERM';
      throw e;
    };
    assert.throws(
      () => renameWithRetry('a.tmp', 'b', { rename, sleep: () => {}, attempts }),
      new RegExp(`attempt ${attempts}$`),
      `attempts=${attempts} should surface attempt ${attempts}'s error`);
  }
});

test('INVARIANT: a transient code followed by a NON-transient one stops at once', () => {
  // Miguel, code review of the fixed branch, Importante 4. The invariants
  // above are exhaustive over (attempts, k, code) for HOMOGENEOUS sequences --
  // always-fail, or fail-k-times-with-one-code-then-succeed -- and the header
  // overclaimed by calling that exhaustive over failure patterns. It is not.
  //
  // The missing pattern is not hypothetical: it is the one this module's own
  // comment documents. The antivirus QUARANTINES the temp between the write
  // and the rename, which is EPERM on attempt 1 and ENOENT on attempt 2. A
  // mixed sequence was not covered anywhere in this file.
  for (const first of ALL_TRANSIENT) {
    for (const then of NON_TRANSIENT) {
      const rename = flaky([first, then]);
      const slept = [];
      assert.throws(
        () => renameWithRetry('a.tmp', 'b', { rename, sleep: ms => slept.push(ms) }),
        new RegExp(then),
        `${first} then ${then} must surface ${then}`);
      assert.strictEqual(rename.calls.length, 2,
        `${first} then ${then} must stop on the second attempt, not run to ATTEMPTS`);
      assert.deepStrictEqual(slept, [20],
        'exactly one wait: after the transient, never after the fatal one');
    }
  }
});

test('INVARIANT: a non-transient code mid-sequence stops there, however late', () => {
  // The same shape deeper into the retry, since "it stops" and "it stops at
  // the right attempt" are different claims.
  for (let at = 1; at <= 4; at++) {
    const codes = Array(at - 1).fill('EBUSY').concat('ENOSPC');
    const rename = flaky(codes);
    assert.throws(
      () => renameWithRetry('a.tmp', 'b', { rename, sleep: () => {} }),
      /ENOSPC/);
    assert.strictEqual(rename.calls.length, at, `fatal at attempt ${at}`);
  }
});

test('the retry policy cannot be widened from outside this module', () => {
  // Miguel: the transient set used to be exported as a live Set, so any
  // consumer could TRANSIENT.add('ENOENT') and turn a deliberate fail-fast
  // into five attempts against a file that will never exist -- a policy change
  // from the outside, invisible, with every test still green.
  //
  // Object.freeze is the obvious fix and it SILENTLY DOES NOTHING: freezing a
  // Set freezes its own properties, not its internal data. Measured, not
  // assumed -- Object.freeze(new Set(['EPERM'])).add('ENOENT') gives size 2.
  // So the container is private and only the predicate is exported.
  const mod = require('../host/atomic-write');
  assert.strictEqual(mod.TRANSIENT, undefined, 'the mutable Set must not be exported');

  // The snapshot is a copy: mutating it must not reach the policy.
  assert.ok(Array.isArray(mod.TRANSIENT_CODES));
  assert.throws(() => mod.TRANSIENT_CODES.push('ENOENT'), TypeError);

  // And the policy itself still refuses a non-transient code.
  assert.strictEqual(mod.isTransient({ code: 'ENOENT' }), false);
  const rename = flaky(['ENOENT']);
  assert.throws(() => renameWithRetry('a.tmp', 'b', { rename, sleep: () => {} }), /ENOENT/);
  assert.strictEqual(rename.calls.length, 1);
});

// --- mutation-driven kills ---------------------------------------------------
// Mortimer's run on this branch: host/atomic-write.js scored 95.2% with three
// survivors, and all three were real gaps rather than equivalent mutants.

test('the published policy snapshot says exactly which codes are transient', () => {
  // Survivor: ArrayDeclaration at the TRANSIENT_CODES line, mutated to `[]`.
  // The existing test asserted it was an array and that pushing to it threw --
  // both still true of an EMPTY array. Nothing asserted its CONTENTS, so the
  // snapshot could have published nothing at all and no test would notice.
  const mod = require('../host/atomic-write');
  assert.deepStrictEqual([...mod.TRANSIENT_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
  // And the snapshot must agree with the predicate it claims to describe --
  // two sources of one truth are exactly what drifts.
  for (const code of mod.TRANSIENT_CODES) {
    assert.strictEqual(mod.isTransient({ code }), true, `${code} must be transient`);
  }
  assert.strictEqual(mod.isTransient({ code: 'ENOENT' }), false);
});

test('async INVARIANT: success at attempt k costs exactly k calls and k-1 sleeps', async () => {
  // Survivors: ConditionalExpression -> `true` and `i < attempts` -> `i <=
  // attempts`, BOTH on the async twin's inner sleep guard. The sync version
  // has this invariant and the async one did not, so a mutant making the
  // async version sleep after its FINAL attempt survived untouched.
  //
  // This is Miguel's "asymmetry between twins is how twins drift", caught by
  // measurement rather than by reading: the two functions were reviewed as a
  // pair, and the tests were not.
  for (const code of ALL_TRANSIENT) {
    for (let attempts = 1; attempts <= 6; attempts++) {
      for (let k = 1; k <= attempts; k++) {
        const rename = flakyAsync(Array(k - 1).fill(code));
        const slept = [];
        await renameWithRetryAsync('a.tmp', 'b', {
          rename, sleep: async ms => { slept.push(ms); }, attempts,
        });
        assert.strictEqual(rename.calls.length, k, `${code} k=${k}/${attempts}`);
        assert.strictEqual(slept.length, k - 1,
          `${code} k=${k}/${attempts}: must not sleep after the last attempt`);
      }
    }
  }
});

test('async INVARIANT: an exhausted retry never sleeps after its final attempt', async () => {
  // The same guard from the failing side, which is where the mutant actually
  // shows: with `i <= attempts` the loop sleeps once more than it should
  // before giving up, adding a wait nobody asked for to every permanent
  // failure.
  for (let attempts = 1; attempts <= 6; attempts++) {
    const rename = flakyAsync(Array(attempts + 3).fill('EBUSY'));
    const slept = [];
    await assert.rejects(() => renameWithRetryAsync('a.tmp', 'b', {
      rename, sleep: async ms => { slept.push(ms); }, attempts,
    }), /EBUSY/);
    assert.strictEqual(slept.length, attempts - 1,
      `attempts=${attempts}: ${slept.length} sleeps for ${attempts} attempts`);
  }
});
