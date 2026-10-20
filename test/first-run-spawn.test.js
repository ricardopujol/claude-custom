'use strict';
/**
 * host/first-run.js's spawning wrapper against REAL processes. Its own file, apart from test/first-run.test.js, because it starts
 * node children (and so stays out of Stryker's command). The children are this very node, running a one-line script.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execOnce, checkClaude, CLAUDE_TIMEOUT_MS } = require('../host/first-run');

const node = process.execPath;

test('a real child that prints a version answers ok with its stdout', async () => {
  // execOnce passes argv as given: node -e "<script>" is the stand-in `claude`; the check reads whatever it prints
  const r = await execOnce(node, ['-e', 'console.log("2.1.304 (Claude Code)")'], 10000, process.env);
  assert.equal(r.ok, true);
  assert.match(r.stdout, /2\.1\.304 \(Claude Code\)/);
});

test('a real child that exits non-zero is a failure with its code, not a timeout', async () => {
  const r = await execOnce(node, ['-e', 'process.exit(3)'], 10000, process.env);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.error, 3);
});

test('a real child that hangs is killed at the timeout and reported as timedOut', async () => {
  const t0 = Date.now();
  const r = await execOnce(node, ['-e', 'setInterval(() => {}, 1000)'], 400, process.env);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('a missing executable is an error, and the check says Claude Code is not installed', async () => {
  const r = await execOnce('C:/no/such/dir/claude.exe', ['--version'], 2000, process.env);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  const c = await checkClaude({ run: async () => r });
  assert.match(c.fix, /isn't installed/);
});

test('a hung CLI through the real wrapper reads "didn\'t answer", not "isn\'t installed"', async () => {
  const c = await checkClaude({ run: () => execOnce(node, ['-e', 'setInterval(() => {}, 1000)'], 400, process.env) });
  assert.equal(c.status, 'fail');
  assert.match(c.detail, new RegExp(`didn't answer in ${CLAUDE_TIMEOUT_MS / 1000} s`));
  assert.ok(!/isn't installed/.test(c.fix));
});
