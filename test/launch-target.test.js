'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLaunchTarget, launchEnv } = require('../host/launch-target');

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

test('ELECTRON_RUN_AS_NODE never reaches the window we are launching', () => {
  // THE TRAP THIS PROJECT ALREADY PAID FOR, from its own CLAUDE.md:
  // "ELECTRON_RUN_AS_NODE is inherited ... any probe that spawns Electron from
  // a session must delete that variable or the child starts as plain Node --
  // with errors that name anything but the cause."
  //
  // It bites HERE for a reason that looks correct at every step. The host
  // spawns this launcher with ELECTRON_RUN_AS_NODE=1 on purpose: the host's own
  // execPath is electron, and the launcher is a node script, so it MUST be set.
  // The launcher then passed {...process.env} to electron, carrying it through
  // -- and electron dutifully started as Node, tried to execute the app
  // directory, and exited. Measured: the Projects panel logged "opening
  // project", no window ever appeared, and stdio:'ignore' meant nothing said
  // why.
  const out = launchEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1' }, 'C:/proj');
  assert.strictEqual('ELECTRON_RUN_AS_NODE' in out, false);
  assert.strictEqual(out.CLAUDE_CUSTOM_CWD, 'C:/proj');
  assert.strictEqual(out.PATH, '/x', 'the rest of the environment is passed through');
});

test('a port meant for the OLD project does not follow us to the new one', () => {
  // CLAUDE_CUSTOM_PORT is honoured exactly and never stepped. Inheriting it
  // into a different project would hand the new window the old project's port,
  // where main.js would find the old host, refuse it, and exit -- so the picker
  // would appear to do nothing at all.
  const out = launchEnv({ CLAUDE_CUSTOM_PORT: '7681' }, 'C:/proj');
  assert.strictEqual('CLAUDE_CUSTOM_PORT' in out, false);
});
