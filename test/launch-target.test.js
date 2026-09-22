'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLaunchTarget } = require('../host/launch-target');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-'));

test('no argument means the folder you are standing in', () => {
  const dir = tmpDir();
  assert.strictEqual(resolveLaunchTarget(undefined, { cwd: dir }), path.resolve(dir));
});

test('a relative argument resolves against where you ran it', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.strictEqual(
    resolveLaunchTarget('sub', { cwd: dir }),
    path.join(path.resolve(dir), 'sub'),
  );
});

test('a folder that is not there is refused, and named', () => {
  // The launcher is the first thing a new user runs and a typo is the likeliest
  // way to get it wrong. Refusing here means one clear line; accepting means a
  // window opens on a folder that does not exist and claude fails inside the
  // pty, where the message is buried in a TUI.
  const dir = tmpDir();
  assert.throws(
    () => resolveLaunchTarget('nope', { cwd: dir }),
    /nope/,
  );
});

test('a FILE is not a project', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.throws(
    () => resolveLaunchTarget('notes.txt', { cwd: dir }),
    /not a folder/i,
  );
});
