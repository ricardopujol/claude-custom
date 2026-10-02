'use strict';
// The launcher's arguments (bin/claude-custom.js), Windowless sessions PR 3:
// `claude-custom [folder]`, `claude-custom [folder] --stop`, `--help`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseCli } = require('../host/launch-target');

const CWD = path.resolve('C:\\work\\proj');

test('no arguments, or a folder, opens it (the folder is resolved later, where it is checked)', () => {
  assert.deepStrictEqual(parseCli([], { cwd: CWD }), { cmd: 'open', arg: undefined });
  assert.deepStrictEqual(parseCli(['..\\other'], { cwd: CWD }), { cmd: 'open', arg: '..\\other' });
});

test('-h or --help anywhere asks for help', () => {
  assert.deepStrictEqual(parseCli(['--help'], { cwd: CWD }), { cmd: 'help' });
  assert.deepStrictEqual(parseCli(['x', '-h'], { cwd: CWD }), { cmd: 'help' });
  assert.deepStrictEqual(parseCli(['x', '--stop', '--help'], { cwd: CWD }), { cmd: 'help' });
});

test('--stop, before or after the folder, stops the sessions serving it, resolved against cwd', () => {
  assert.deepStrictEqual(parseCli(['C:\\proj\\feat-a', '--stop'], { cwd: CWD }), { cmd: 'stop', folder: path.resolve('C:\\proj\\feat-a') });
  assert.deepStrictEqual(parseCli(['--stop', 'feat-a'], { cwd: CWD }), { cmd: 'stop', folder: path.resolve(CWD, 'feat-a') });
});

test('--stop with no folder means the folder you are standing in', () => {
  assert.deepStrictEqual(parseCli(['--stop'], { cwd: CWD }), { cmd: 'stop', folder: CWD });
});

test('an unknown option is an error, never a folder called "--something"', () => {
  assert.throws(() => parseCli(['--stpo'], { cwd: CWD }), /unknown option: --stpo/);
  assert.throws(() => parseCli(['x', '-s'], { cwd: CWD }), /unknown option: -s/);
});

test('two folders is an error, not "the first one wins"', () => {
  assert.throws(() => parseCli(['a', 'b'], { cwd: CWD }), /one folder/);
  assert.throws(() => parseCli(['a', '--stop', 'b'], { cwd: CWD }), /one folder/);
});
