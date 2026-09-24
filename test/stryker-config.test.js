'use strict';
/**
 * The mutation gate's own config, checked rather than trusted.
 *
 * `stryker.conf.json` runs a CURATED SUBSET of the suite, because
 * `coverageAnalysis: "off"` makes every mutant re-run the whole command. That
 * design has exactly one failure mode: a module in `mutate` whose tests are not
 * in `command` is measured against a suite that cannot see them, and **the report
 * does not say so**. Its survivors are phantoms -- real kills that were never
 * given the chance to happen.
 *
 * THIS TEST EXISTS BECAUSE I WROTE THAT RULE INTO THE CONFIG IN CAPITALS AND THEN
 * BROKE IT BY HAND TWICE, in the two commits immediately after writing it.
 *
 * Miguel found the first instance: `app/secret-service.js` in `mutate` with
 * `test/secret-ipc.test.js` absent, plus all three lock suites missing. I fixed
 * those, added the rule as a comment, and then added
 * `test/vault-damaged-path.test.js` and `test/vault-lock-pass3.test.js` in the
 * next two commits without touching `command` -- so H1 through H5 and I1, the
 * newest code on the branch, were all outside the run. Mortimer found that before
 * quoting a number, which is the only reason it did not become the number.
 *
 * A rule written in a comment is a rule nothing enforces. So it is derived here
 * FROM THE REQUIRES rather than restated: the check reads which test files
 * actually import which modules, so a new test file joins the obligation
 * automatically and cannot be forgotten.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.conf.json'), 'utf8'));

// Test files whose subject is the REPOSITORY rather than a function. These kill
// no mutant -- nothing they assert is an expression a mutator can reach -- and
// some cannot even pass under Stryker, whose instrumentation adds globals the
// shared-scope allow-list correctly refuses. Excluding them is deliberate; the
// config says so too, and this list is the machine-readable half of that.
const REPO_SCANNING = new Set([
  'renderer-scope.test.js',   // shared-scope allow-list + git-ls-files + control chars
  'sources-parse.test.js',    // node --check over the tree
  'project-dir.test.js',      // asserts about real directories
  'stryker-config.test.js',   // this file: its subject is the config
]);

const testFiles = fs.readdirSync(path.join(ROOT, 'test'))
  .filter(f => f.endsWith('.test.js'));

// Which local modules does each test file require? Read, not guessed.
function requiresOf(file) {
  const src = fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');
  return new Set(
    [...src.matchAll(/require\(['"]\.\.\/([^'"]+)['"]\)/g)]
      .map(m => (m[1].endsWith('.js') ? m[1] : `${m[1]}.js`)));
}

test('every module Stryker mutates has ALL of its tests in the command', () => {
  const cmd = conf.commandRunner.command;
  const inCommand = new Set(
    [...cmd.matchAll(/test\/([a-z0-9-]+\.test\.js)/g)].map(m => m[1]));
  assert.ok(inCommand.size > 20, `the command must run the suite (${inCommand.size})`);

  const mutated = new Set(conf.mutate);
  assert.ok(mutated.size > 10, 'the scan must find mutated modules');

  const missing = [];
  for (const file of testFiles) {
    if (REPO_SCANNING.has(file) || inCommand.has(file)) continue;
    for (const req of requiresOf(file)) {
      if (mutated.has(req)) {
        missing.push(`${file} exercises ${req}`);
        break;
      }
    }
  }
  assert.deepStrictEqual(missing, [],
    'these test files exercise a MUTATED module and are absent from '
    + 'stryker.conf.json\'s command, so their kills would be reported as '
    + `survivors: ${missing.join('; ')}`);
});

test('the command and mutate list name only files that exist', () => {
  // A renamed file silently narrows the run: Stryker does not fail on a test
  // path that matches nothing, it just runs fewer tests.
  const cmd = conf.commandRunner.command;
  for (const rel of [...cmd.matchAll(/test\/[a-z0-9-]+\.test\.js/g)].map(m => m[0])) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `command names a missing file: ${rel}`);
  }
  for (const rel of conf.mutate) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `mutate names a missing file: ${rel}`);
  }
});

test('the deliberate exclusions are still deliberate', () => {
  // If one of these is dropped or renamed, the exemption becomes a silent hole
  // rather than a decision. Asserted so the list cannot rot.
  for (const f of REPO_SCANNING) {
    if (f === 'stryker-config.test.js') continue;
    assert.ok(fs.existsSync(path.join(ROOT, 'test', f)),
      `${f} is exempted but no longer exists -- remove it from REPO_SCANNING`);
  }
  const cmd = conf.commandRunner.command;
  for (const f of REPO_SCANNING) {
    assert.ok(!cmd.includes(`test/${f}`),
      `${f} is a repo-scanning test and must NOT be in the Stryker command`);
  }
});

test('the timeout leaves room for the real key derivation', () => {
  // STRYKER COUNTS A TIMEOUT AS KILLED, so on a branch whose KDF is deliberately
  // ~200ms a low ceiling turns clocks into kills -- a phantom kill, the mirror of
  // a phantom survivor. Miguel raised this before the run rather than after.
  //
  // Pinned so nobody lowers it back to a value that scores well for the wrong
  // reason.
  assert.ok(conf.timeoutMS >= 60000,
    `timeoutMS is ${conf.timeoutMS}: too low for a 200ms scrypt under `
    + 'instrumentation, and a timeout is scored as a kill');
});
