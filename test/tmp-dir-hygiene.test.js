'use strict';
/**
 * No test makes a temp directory that outlives it.
 *
 * `test/tmp-dir.js` exists because 27 test files called `fs.mkdtempSync` and
 * none cleaned up -- 230 directories per run, enough to throttle the mutation
 * gate 22x and inflate its score through timeouts (see that file's header).
 * `bc1e5ac` fixed all 27. PR #34's `test/session-model.test.js`, written before
 * that fix and rebased after it, brought the pattern straight back: a fix that
 * lives only in the files it touched does not survive the next file.
 *
 * So the rule is a test. Scans the test directory rather than a list, so a new
 * file is covered the moment it exists.
 *
 * Like the other repo-scanning tests, this is deliberately NOT in Stryker's
 * command: its subject is the file tree, and it can kill no mutant.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const ALLOWED = new Set(['tmp-dir.js', path.basename(__filename)]);

test('no test file calls mkdtempSync directly -- use tmpDir() from test/tmp-dir.js', () => {
  const offenders = fs.readdirSync(TEST_DIR)
    .filter(f => f.endsWith('.js') && !ALLOWED.has(f))
    .filter(f => /\bmkdtempSync\s*\(/.test(fs.readFileSync(path.join(TEST_DIR, f), 'utf8')));
  assert.deepStrictEqual(offenders, [],
    `these call fs.mkdtempSync and leak a directory per call: ${offenders.join(', ')}`);
});
