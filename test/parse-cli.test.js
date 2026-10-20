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

// Dexter, PR #83 F8: `claude-custom "" --stop` (an unset variable in a script)
// must not quietly mean "the folder you are standing in".
test('an empty folder name is an error', () => {
  assert.throws(() => parseCli(['', '--stop'], { cwd: CWD }), /empty folder name/);
  assert.throws(() => parseCli(['  '], { cwd: CWD }), /empty folder name/);
});

test('two folders is an error, not "the first one wins"', () => {
  assert.throws(() => parseCli(['a', 'b'], { cwd: CWD }), /one folder/);
  assert.throws(() => parseCli(['a', '--stop', 'b'], { cwd: CWD }), /one folder/);
});

test('--version or -v asks for the version, and wins over a folder', () => {
  assert.deepStrictEqual(parseCli(['--version'], { cwd: CWD }), { cmd: 'version' });
  assert.deepStrictEqual(parseCli(['-v'], { cwd: CWD }), { cmd: 'version' });
  assert.deepStrictEqual(parseCli(['x', '--version'], { cwd: CWD }), { cmd: 'version' });
});

test('--help still wins over --version', () => {
  assert.deepStrictEqual(parseCli(['--version', '--help'], { cwd: CWD }), { cmd: 'help' });
});

test('versionLine names the app and its version, and says so when the version is unreadable', () => {
  const { versionLine } = require('../host/launch-target');
  assert.strictEqual(versionLine({ version: '0.0.1' }), 'claude-custom 0.0.1');
  assert.strictEqual(versionLine({ version: '1.2.3' }, '33.4.0'), 'claude-custom 1.2.3 (Electron 33.4.0)');
  for (const bad of [null, undefined, {}, { version: 5 }, { version: '' }]) {
    assert.strictEqual(versionLine(bad), 'claude-custom (version unknown)');
  }
});

// The installed build (claude-custom.exe) has no launcher script: a folder on its command line, or the folder it was started in, is the project.
const { packagedLaunchCwd } = require('../host/launch-target');
const INSTALL = path.resolve('C:/Users/x/AppData/Local/Programs/claude-custom');
const HOME = path.resolve('C:/Users/x');
const statOf = (set) => (p) => { if (!set.has(path.resolve(p))) throw new Error('ENOENT'); return { isDirectory: () => true }; };

test('packagedLaunchCwd: a folder argument wins, resolved against where it was started', () => {
  const dirs = new Set([path.resolve('C:/work/proj')]);
  assert.strictEqual(packagedLaunchCwd({ args: ['C:/work/proj'], cwd: HOME, installDir: INSTALL, home: HOME, stat: statOf(dirs) }), path.resolve('C:/work/proj'));
  assert.strictEqual(packagedLaunchCwd({ args: ['proj'], cwd: path.resolve('C:/work'), installDir: INSTALL, home: HOME, stat: statOf(dirs) }), path.resolve('C:/work/proj'));
});

test('packagedLaunchCwd: options are skipped, and a folder that is not there falls back to where it started', () => {
  const dirs = new Set();
  assert.strictEqual(packagedLaunchCwd({ args: ['--inspect', 'nope'], cwd: path.resolve('C:/work'), installDir: INSTALL, home: HOME, stat: statOf(dirs) }), path.resolve('C:/work'));
});

test('packagedLaunchCwd: no folder means the folder it was started in', () => {
  assert.strictEqual(packagedLaunchCwd({ args: [], cwd: path.resolve('C:/work/proj'), installDir: INSTALL, home: HOME, stat: statOf(new Set()) }), path.resolve('C:/work/proj'));
});

test('packagedLaunchCwd: started from the Start menu (inside its own install folder) opens the home folder, not the install', () => {
  assert.strictEqual(packagedLaunchCwd({ args: [], cwd: INSTALL, installDir: INSTALL, home: HOME, stat: statOf(new Set()) }), HOME);
  assert.strictEqual(packagedLaunchCwd({ args: [], cwd: path.join(INSTALL, 'resources'), installDir: INSTALL, home: HOME, stat: statOf(new Set()) }), HOME);
  // a sibling that only shares the prefix is not inside it
  const sib = INSTALL + '-projects';
  assert.strictEqual(packagedLaunchCwd({ args: [], cwd: sib, installDir: INSTALL, home: HOME, stat: statOf(new Set()) }), sib);
});
