// @ts-nocheck
'use strict';
/**
 * Project HP — the test suite as one bar.
 *
 * The design says "test pass rate, coverage and lint as one bar. Needs a small
 * per-project command config, since every repo reports differently."
 *
 * v1 is PASS RATE ONLY, and says so. Coverage and lint are a second and third
 * number whose thresholds are a judgement call per project; inventing defaults
 * for them would produce a bar that moves for reasons nobody chose. A bar that
 * means one clear thing beats a composite nobody can decode.
 *
 * Detection and parsing are pure and live here. RUNNING the suite is the
 * host's job, because it is slow and must never block the event loop.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectRunner, parseResults, healthFrom, RUNNERS } = require('../host/health');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hp-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

// --- detection ---------------------------------------------------------------

test('detects the test script declared in package.json', () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }) });
  const runner = detectRunner(dir);
  assert.strictEqual(runner.kind, 'npm');
  assert.deepStrictEqual(runner.command, ['npm', 'test']);
});

test('reads the declared script to pick a PARSER, not just a command', () => {
  // `npm test` says nothing about output shape. What the script actually runs
  // is what decides whether "# pass 3" or "3 passed" is the thing to look for.
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }) });
  assert.strictEqual(detectRunner(dir).parser, 'node-test');
});

test('recognises jest, vitest and mocha from the script', () => {
  for (const [script, parser] of [['jest --ci', 'jest'], ['vitest run', 'jest'], ['mocha', 'mocha']]) {
    const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: script } }) });
    assert.strictEqual(detectRunner(dir).parser, parser, script);
  }
});

test('detects pytest from a python project with no package.json', () => {
  const dir = repo({ 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  const runner = detectRunner(dir);
  assert.strictEqual(runner.parser, 'pytest');
  assert.ok(runner.command.includes('pytest'), runner.command.join(' '));
});

test('a project with no recognisable suite reports none, rather than guessing', () => {
  // Running the wrong command in someone's repo is worse than admitting there
  // is nothing to run: `npm test` in a project without the script prints an
  // error that would parse as zero tests, i.e. as zero health.
  const dir = repo({ 'README.md': '# nothing here' });
  assert.strictEqual(detectRunner(dir), null);
});

test('a package.json with no test script is not a node runner', () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) });
  assert.strictEqual(detectRunner(dir), null);
});

test('the placeholder npm test script is not a test suite', () => {
  // `npm init` writes a script that exits 1 with "no test specified". Treating
  // it as a suite reports 0% health for a project that simply has no tests.
  const dir = repo({
    'package.json': JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
  });
  assert.strictEqual(detectRunner(dir), null);
});

test('malformed package.json does not throw', () => {
  assert.strictEqual(detectRunner(repo({ 'package.json': '{ not json' })), null);
});

// --- parsing -----------------------------------------------------------------

test('parses node:test output', () => {
  const out = ['# tests 319', '# suites 0', '# pass 319', '# fail 0'].join('\n');
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 319, failed: 0, total: 319 });
});

test('parses node:test with failures', () => {
  const out = ['# tests 25', '# pass 23', '# fail 2'].join('\n');
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 23, failed: 2, total: 25 });
});

test('parses pytest', () => {
  assert.deepStrictEqual(parseResults('pytest', '= 63 passed, 2 failed in 5.03s ='),
    { passed: 63, failed: 2, total: 65 });
});

test('parses pytest with only passes', () => {
  assert.deepStrictEqual(parseResults('pytest', '===== 42 passed in 5.03s ====='),
    { passed: 42, failed: 0, total: 42 });
});

test('pytest errors count as failures, not as absent', () => {
  // An erroring test is a broken test. Counting only "failed" would report a
  // suite that cannot even import as perfectly healthy.
  assert.deepStrictEqual(parseResults('pytest', '= 10 passed, 1 failed, 2 errors in 1s ='),
    { passed: 10, failed: 3, total: 13 });
});

test('parses jest', () => {
  const out = 'Tests:       2 failed, 118 passed, 120 total';
  assert.deepStrictEqual(parseResults('jest', out), { passed: 118, failed: 2, total: 120 });
});

test('unparseable output yields null, never zero', () => {
  // Zero passed reads as "everything is broken". Unknown must be its own state,
  // or a parser that falls behind a tool's format change reports catastrophe.
  assert.strictEqual(parseResults('node-test', 'command not found'), null);
  assert.strictEqual(parseResults('pytest', ''), null);
});

test('an unknown parser yields null rather than throwing', () => {
  assert.strictEqual(parseResults('nonsense', '# pass 1'), null);
});

test('takes the LAST summary when a run prints several', () => {
  // A watch-mode or multi-project run prints one summary per project; the final
  // one is the total.
  // Each block now includes its `tests N` header, because that is what node
  // actually prints and the parser anchors on it -- a summary without one is
  // not output any reporter produces.
  const out = ['# tests 3', '# pass 3', '# fail 0',
               '# tests 11', '# pass 10', '# fail 1'].join('\n');
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 10, failed: 1, total: 11 });
});

// --- the bar -----------------------------------------------------------------

test('full health is a fully green bar', () => {
  const hp = healthFrom({ passed: 319, failed: 0, total: 319 });
  assert.strictEqual(hp.fraction, 1);
  assert.strictEqual(hp.state, 'healthy');
});

test('one failure out of many is NOT still healthy', () => {
  // A red test is a red suite. Rounding 318/319 to "healthy" is how a broken
  // build hides behind a bar that looks full.
  const hp = healthFrom({ passed: 318, failed: 1, total: 319 });
  assert.ok(hp.fraction < 1);
  assert.notStrictEqual(hp.state, 'healthy');
});

test('health states escalate as failures mount', () => {
  const hurt = healthFrom({ passed: 90, failed: 10, total: 100 });
  const critical = healthFrom({ passed: 40, failed: 60, total: 100 });
  assert.strictEqual(hurt.state, 'hurt');
  assert.strictEqual(critical.state, 'critical');
});

test('an empty suite is unknown, not dead', () => {
  // 0/0 is not 0%. A project with no tests has unknown health, and showing it
  // as an empty red bar is a false accusation.
  assert.strictEqual(healthFrom({ passed: 0, failed: 0, total: 0 }).state, 'unknown');
  assert.strictEqual(healthFrom(null).state, 'unknown');
});

test('unknown health has no fraction to draw', () => {
  assert.strictEqual(healthFrom(null).fraction, null);
});

test('the bar reports what it measured, so nobody reads it as coverage', () => {
  // v1 measures pass rate only. The label has to say that, or the number gets
  // quoted as though it included coverage and lint.
  assert.match(healthFrom({ passed: 1, failed: 0, total: 1 }).measures, /pass rate/i);
});

test('every runner declares both a command and a parser', () => {
  for (const [name, spec] of Object.entries(RUNNERS)) {
    assert.ok(Array.isArray(spec.command) && spec.command.length, name);
    assert.ok(spec.parser, name);
  }
});

// --- the shapes the tools ACTUALLY emit -------------------------------------
// The fixtures above were written from memory and all passed while the parser
// returned null on this project's own suite. Two reasons, both invisible in a
// plain-text fixture:
//   1. node:test's DEFAULT reporter is `spec`, which prints "ℹ pass 293",
//      not TAP's "# pass 293".
//   2. Runners COLOUR their output, and an ANSI escape contains digits, so any
//      pattern scanning for "not-a-digit, then the word pass" stops inside the
//      escape sequence and matches nothing.

test('parses the spec reporter, which is what node:test prints by default', () => {
  const out = ['ℹ tests 293', 'ℹ pass 293', 'ℹ fail 0'].join('\n');
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 293, failed: 0, total: 293 });
});

test('parses output that is COLOURED, as every runner colours it', () => {
  const green = '\u001b[32m';
  const reset = '\u001b[0m';
  const out = [green + 'ℹ tests 293' + reset,
               green + 'ℹ pass 293' + reset,
               green + 'ℹ fail 0' + reset].join('\n');
  assert.deepStrictEqual(parseResults('node-test', out), { passed: 293, failed: 0, total: 293 });
});

test("AGREES WITH THE REAL node:test REPORTER, bytes and all", () => {
  // The check that is not a fixture. Everything above states what I BELIEVE the
  // format to be, and my belief was wrong twice: the default reporter is `spec`
  // (not TAP), and its output is ANSI-coloured, which breaks any pattern
  // scanning for "not-a-digit then the word pass" because an escape sequence
  // contains digits.
  //
  // So this runs the real runner over a throwaway suite in a temp directory and
  // parses whatever really comes out. A temp suite rather than this project's:
  // invoking `npm test` from inside `npm test` recurses forever, which is
  // exactly what the first version of this test did.
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hp-run-'));
  fs.writeFileSync(path.join(dir, 'sample.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "test('a', () => assert.ok(true));",
    "test('b', () => assert.ok(true));",
    "test('c', () => assert.ok(true));",
  ].join(String.fromCharCode(10)), 'utf8');

  let out;
  try {
    // NODE_TEST_CONTEXT MUST NOT BE INHERITED. A `node --test` child that sees
    // it switches from the human reporter to the v8 serializer protocol and
    // writes NOTHING to stdout -- so this test read an empty string and
    // concluded the parser was broken, when the parser was never given output.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    out = execFileSync(process.execPath, ['--test', 'sample.test.js'],
      { encoding: 'utf8', cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    out = String((err && err.stdout) || '');   // a failing suite still prints a summary
  }

  const parsed = parseResults('node-test', out);
  assert.ok(parsed, 'the parser returned null on the real reporter output');
  assert.deepStrictEqual(parsed, { passed: 3, failed: 0, total: 3 });
});
