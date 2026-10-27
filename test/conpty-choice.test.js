'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { choosePtyBackend, bundledFilesPresent } = require('../host/conpty-choice');

const here = () => true;
const gone = () => false;

test('on Windows the bundled ConPTY is used, so the CLI query and DA1 sentinel reach the host', () => {
  const c = choosePtyBackend({ env: {}, platform: 'win32', present: here });
  assert.deepStrictEqual(c, { options: { useConptyDll: true }, backend: 'bundled', hostAnswersQueries: true, reason: null });
});

test('CLAUDE_CUSTOM_CONPTY=builtin turns it off, and then a windowless host does NOT answer queries (conhost does)', () => {
  const c = choosePtyBackend({ env: { CLAUDE_CUSTOM_CONPTY: 'builtin' }, platform: 'win32', present: here });
  assert.deepStrictEqual(c.options, {});
  assert.strictEqual(c.backend, 'builtin');
  assert.strictEqual(c.hostAnswersQueries, false);
  assert.match(c.reason, /CLAUDE_CUSTOM_CONPTY=builtin/);
});

test('any other value of the switch leaves it on; case is not significant', () => {
  assert.strictEqual(choosePtyBackend({ env: { CLAUDE_CUSTOM_CONPTY: 'bundled' }, platform: 'win32', present: here }).backend, 'bundled');
  assert.strictEqual(choosePtyBackend({ env: { CLAUDE_CUSTOM_CONPTY: 'BUILTIN' }, platform: 'win32', present: here }).backend, 'builtin');
});

test('missing bundled files fall back to the OS ConPTY with a reason, never a throw', () => {
  const c = choosePtyBackend({ env: {}, platform: 'win32', present: gone });
  assert.strictEqual(c.backend, 'builtin');
  assert.deepStrictEqual(c.options, {});
  assert.strictEqual(c.hostAnswersQueries, false);
  assert.match(c.reason, /missing/);
});

test('off Windows there is nothing to choose and nothing is checked', () => {
  let asked = false;
  for (const platform of ['linux', 'darwin']) {
    const c = choosePtyBackend({ env: {}, platform, present: () => { asked = true; return true; } });
    assert.deepStrictEqual(c.options, {});
    assert.strictEqual(c.hostAnswersQueries, false);
  }
  assert.strictEqual(asked, false);
});

test('bundledFilesPresent needs BOTH files, together, in the build dir or the prebuild dir', () => {
  const root = path.join('X', 'node-pty');
  const has = (...files) => (p) => files.includes(p);
  const b = path.join(root, 'build', 'Release', 'conpty');
  const pre = path.join(root, 'prebuilds', 'win32-x64', 'conpty');
  const probe = (exists) => bundledFilesPresent({ nodePtyDir: root, arch: 'x64', exists });
  assert.strictEqual(probe(has(path.join(b, 'conpty.dll'), path.join(b, 'OpenConsole.exe'))), true);
  assert.strictEqual(probe(has(path.join(pre, 'conpty.dll'), path.join(pre, 'OpenConsole.exe'))), true);
  assert.strictEqual(probe(has(path.join(b, 'conpty.dll'))), false, 'the dll alone is not enough');
  assert.strictEqual(probe(has(path.join(b, 'conpty.dll'), path.join(pre, 'OpenConsole.exe'))), false, 'the two files must sit together');
  assert.strictEqual(probe(() => false), false);
});

test('on Windows the installed node-pty has the bundled files', { skip: process.platform !== 'win32' }, () => {
  assert.strictEqual(bundledFilesPresent(), true);
});

test('package.json pins node-pty to a version that has useConptyDll (>= 1.1.0), and that is what is installed', () => {
  const dep = require('../package.json').dependencies['node-pty'];
  assert.match(dep, /^\^1\.([1-9]\d*)\.\d+$/);
  const installed = require('node-pty/package.json').version.split('.').map(Number);
  assert.ok(installed[0] > 1 || installed[1] >= 1, 'installed ' + installed.join('.'));
});
