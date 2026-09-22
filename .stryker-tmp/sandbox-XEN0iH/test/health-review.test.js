// @ts-nocheck
'use strict';
/**
 * Project HP — the defects two reviewers found, each pinned by a test.
 *
 * THE PATTERN BEHIND BOTH CRITICALS: the parser and its fixture shared one
 * author's wrong belief about an external tool's output format, so the suite
 * confirmed the bug instead of catching it. No amount of fixture-writing fixes
 * that, because the fixture author is the person holding the wrong belief.
 *
 * The only instrument that breaks the tie is running the real tool ON ITS
 * FAILURE PATH -- which is exactly the path neither the existing real-runner
 * test nor verify/probe-health.js ever exercised, because both ran a green
 * suite. Every string below was COPIED from a real run, not remembered.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseResults, healthFrom, detectRunner, RUNNERS } = require('../host/health');

// --- pytest: failed comes FIRST ----------------------------------------------
// Real output, captured 2026-09-14 from `python -m pytest -q` over a suite with
// one passing and one failing test:
//
//   1 failed, 1 passed in 59.87s
//
// pytest emits its categories in a fixed order (failed, passed, skipped,
// xfailed, xpassed, errors), so `failed` is ALWAYS to the left of `passed`.
// The parser anchored on "N passed" and searched only rightwards from there.

test('a red pytest suite is NOT healthy', () => {
  const parsed = parseResults('pytest', '1 failed, 1 passed in 59.87s');
  assert.deepStrictEqual(parsed, { passed: 1, failed: 1, total: 2 });
  assert.notStrictEqual(healthFrom(parsed).state, 'healthy');
});

test('pytest counts are read from the whole line, not a suffix of it', () => {
  assert.deepStrictEqual(parseResults('pytest', '===== 2 failed, 63 passed in 5.03s ====='),
    { passed: 63, failed: 2, total: 65 });
});

test('pytest errors are counted even when they follow passed', () => {
  // `errors` sorts AFTER `passed`, which is why the old suffix-based parser
  // found it and gave false confidence in the rest of the function.
  assert.deepStrictEqual(parseResults('pytest', '3 failed, 10 passed, 2 errors in 1s'),
    { passed: 10, failed: 5, total: 15 });
});

test('a pytest run where NOTHING passed is critical, not unknown', () => {
  // "3 failed in 0.12s" is what pytest prints when every test fails, and the
  // parser's entry condition was a `N passed` match -- so the worst possible
  // suite state was reported as "no result yet".
  const parsed = parseResults('pytest', '3 failed in 0.12s');
  assert.deepStrictEqual(parsed, { passed: 0, failed: 3, total: 3 });
  assert.strictEqual(healthFrom(parsed).state, 'critical');
});

test('a pytest collection error is a result, not an absence', () => {
  const parsed = parseResults('pytest', '2 errors in 0.10s');
  assert.deepStrictEqual(parsed, { passed: 0, failed: 2, total: 2 });
  assert.strictEqual(healthFrom(parsed).state, 'critical');
});

test('genuinely unrecognisable pytest output is still null', () => {
  // The distinction that must survive: ignorance is not catastrophe.
  assert.strictEqual(parseResults('pytest', ''), null);
  assert.strictEqual(parseResults('pytest', 'ImportError: no such module'), null);
});

test('pytest xpassed and xfailed are not mistaken for passed or failed', () => {
  assert.strictEqual(parseResults('pytest', '2 xfailed, 3 xpassed in 1s'), null);
});

// --- node:test: the failing-tests block comes AFTER the summary ---------------
// Real output, captured 2026-09-14 from `node --test` over a suite containing a
// test named "fail 0 times before giving up":
//
//   ℹ pass 1
//   ℹ fail 1
//   ...
//   ✖ failing tests:
//   ✖ fail 0 times before giving up (3.2397ms)
//
// Scanning the whole stream for the last /fail\s+(\d+)/ read the TEST NAME.

const INFO = String.fromCharCode(0x2139);
const CROSS = String.fromCharCode(0x2716);
const NL = String.fromCharCode(10);

const realFailingRun = [
  CROSS + ' fail 0 times before giving up (3.2397ms)',
  INFO + ' tests 2',
  INFO + ' suites 0',
  INFO + ' pass 1',
  INFO + ' fail 1',
  INFO + ' cancelled 0',
  INFO + ' skipped 0',
  INFO + ' todo 0',
  INFO + ' duration_ms 121.5',
  '',
  CROSS + ' failing tests:',
  '',
  'test at s.test.js:4:1',
  CROSS + ' fail 0 times before giving up (3.2397ms)',
  "  Error [ERR_TEST_FAILURE]: Expected values to be truthy",
].join(NL);

test('a test NAMED "fail 0 ..." does not make a red suite look green', () => {
  const parsed = parseResults('node-test', realFailingRun);
  assert.deepStrictEqual(parsed, { passed: 1, failed: 1, total: 2 });
  assert.notStrictEqual(healthFrom(parsed).state, 'healthy');
});

test('a test NAMED "pass N ..." does not shrink the pass count', () => {
  // The mirror case: it understates instead of overstating, turning a 99%
  // green suite into "critical 1/2".
  const out = [
    INFO + ' tests 100',
    INFO + ' pass 99',
    INFO + ' fail 1',
    INFO + ' duration_ms 90',
    '',
    CROSS + ' failing tests:',
    CROSS + ' pass 1 argument to the shim (2ms)',
  ].join(NL);
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 99, failed: 1, total: 100 });
});

test('cancelled tests stay in the denominator', () => {
  // A run aborted partway reported "healthy 40/40" for 12% of a suite.
  const out = [
    INFO + ' tests 319', INFO + ' pass 40', INFO + ' fail 0',
    INFO + ' cancelled 279', INFO + ' skipped 0', INFO + ' todo 0',
  ].join(NL);
  const parsed = parseResults('node-test', out);
  assert.strictEqual(parsed.total, 319);
  assert.notStrictEqual(healthFrom(parsed).state, 'healthy');
});

test('skipped and todo stay OUT of the denominator', () => {
  // They are deliberate, not broken. Counting them would make a suite look
  // unhealthy for doing what its author asked.
  const out = [
    INFO + ' tests 10', INFO + ' pass 8', INFO + ' fail 0',
    INFO + ' cancelled 0', INFO + ' skipped 2', INFO + ' todo 0',
  ].join(NL);
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 8, failed: 0, total: 8 });
});

test('the TAP reporter still parses', () => {
  const out = ['# tests 2', '# pass 1', '# fail 1'].join(NL);
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 1, failed: 1, total: 2 });
});

test('a stray line that is not a counter cannot be read as one', () => {
  const out = [
    INFO + ' tests 5', INFO + ' pass 5', INFO + ' fail 0',
    'some other output entirely', 'cancelled 99',
  ].join(NL);
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 5, failed: 0, total: 5 });
});

// --- the real runner, on its FAILURE path -------------------------------------

test('AGREES WITH THE REAL RUNNER ON A SUITE THAT FAILS', () => {
  // The check neither the old real-runner test nor probe-health.js performed:
  // both ran a GREEN suite, so the failing-tests block -- where both Criticals
  // live -- was never in the bytes being parsed.
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hp-red-'));
  fs.writeFileSync(path.join(dir, 'sample.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "test('ok one', () => assert.ok(true));",
    "test('ok two', () => assert.ok(true));",
    // Named to collide with the parser on purpose.
    "test('fail 0 times before giving up', () => assert.ok(false));",
  ].join(NL), 'utf8');

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;     // else the child writes nothing at all
  let out;
  try {
    out = execFileSync(process.execPath, ['--test', 'sample.test.js'],
      { encoding: 'utf8', cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    out = String((err && err.stdout) || '');   // a red suite exits non-zero
  }

  const parsed = parseResults('node-test', out);
  assert.ok(parsed, 'the parser returned null on a real failing run');
  assert.deepStrictEqual(parsed, { passed: 2, failed: 1, total: 3 });
  // 2/3 is 0.67, below the 0.75 hurt threshold.
  assert.strictEqual(healthFrom(parsed).state, 'critical');
});

// --- thresholds, which nothing pinned ----------------------------------------
// Only 90/100 and 40/100 were covered, so the boundary was free to move
// anywhere in (0.40, 0.90] without a test noticing.

test('the hurt/critical boundary is where it says it is', () => {
  assert.strictEqual(healthFrom({ passed: 75, failed: 25, total: 100 }).state, 'hurt');
  assert.strictEqual(healthFrom({ passed: 74, failed: 26, total: 100 }).state, 'critical');
});

test('ANY failure means not healthy, however small the fraction', () => {
  // Deliberately distinct from `fraction === 1`: at 1e17 passes and one
  // failure the fraction rounds to exactly 1 in floating point, and "healthy"
  // would then be decided by rounding rather than by the failure count.
  const hp = healthFrom({ passed: 1e17, failed: 1, total: 1e17 + 1 });
  assert.strictEqual(hp.fraction, 1);
  assert.notStrictEqual(hp.state, 'healthy');
});

// --- smaller findings ---------------------------------------------------------

test('the placeholder script is rejected whatever its case', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hp-ph-'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo "Error: No Test Specified" && exit 1' } }), 'utf8');
  assert.strictEqual(detectRunner(dir), null);
});

test('the runner command is a copy, not the shared constant', () => {
  // `command` was a reference to the module-level literal, so one push() or
  // shift() anywhere corrupted it for the life of the process.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hp-cmd-'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
  const runner = detectRunner(dir);
  runner.command.push('--mutated');
  assert.deepStrictEqual(RUNNERS.npm.command, ['npm', 'test']);
});

test('mocha output actually parses', () => {
  // The mocha parser had zero direct coverage: its entire body could be
  // removed and all 27 tests still passed.
  assert.deepStrictEqual(parseResults('mocha', '  12 passing (2s)' + NL + '  3 failing'),
    { passed: 12, failed: 3, total: 15 });
  assert.deepStrictEqual(parseResults('mocha', '  5 passing (1s)'),
    { passed: 5, failed: 0, total: 5 });
});

test('ANSI beyond simple colour is stripped', () => {
  // Spinners emit cursor-hide and erase-line sequences constantly. The one
  // ANSI test only ever used colour, so the extra robustness was unmeasured.
  const esc = String.fromCharCode(27);
  const out = [
    esc + '[?25l' + INFO + ' tests 2',
    esc + '[2K' + INFO + ' pass 2',
    esc + '[32m' + INFO + ' fail 0' + esc + '[0m',
    esc + '[?25h',
  ].join(NL);
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 2, failed: 0, total: 2 });
});

test('interleaved stderr cannot split a counter line in half', () => {
  // stdout and stderr were concatenated into one buffer with no line framing,
  // so a chunk boundary plus an npm warning spliced "ℹ pa" + "ss 319" and the
  // whole run parsed as null -- "no result yet" after a fully green suite.
  const spliced = INFO + ' tests 319' + NL + INFO + ' pa'
    + 'npm WARN config production is deprecated' + NL
    + 'ss 319' + NL + INFO + ' fail 0' + NL;
  // The parser cannot recover a torn line; what it MUST NOT do is report a
  // wrong number. Null is the honest answer, and the host now prevents the
  // tearing by buffering each stream separately.
  const parsed = parseResults('node-test', spliced);
  assert.ok(parsed === null || parsed.passed === 319, JSON.stringify(parsed));
});
