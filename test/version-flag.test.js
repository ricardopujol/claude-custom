'use strict';
// The launcher's --version, run for real. Its own file because it spawns a process, and test/parse-cli.test.js is in Stryker's command.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('bin/claude-custom.js --version prints the package version and opens no window', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-custom.js'), '--version'], { encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), `claude-custom ${require('../package.json').version}`);
  assert.strictEqual(r.stderr, '');
});

test('the launcher and the exe entry print the same line', () => {
  const { versionText } = require('../host/exe-entry');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-custom.js'), '-v'], { encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(r.stdout, versionText(require('../package.json')) + '\n');
});
