'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { ptyWindowsOptions } = require('../host/conpty-choice');

test('on Windows the bundled ConPTY is used, so the CLI\'s OSC 7501 query and DA1 sentinel reach the host', () => {
  assert.deepStrictEqual(ptyWindowsOptions({}, 'win32'), { useConptyDll: true });
});

test('CLAUDE_CUSTOM_CONPTY=builtin turns it off (the switch back to the OS\'s own ConPTY)', () => {
  assert.deepStrictEqual(ptyWindowsOptions({ CLAUDE_CUSTOM_CONPTY: 'builtin' }, 'win32'), {});
});

test('any other value of the switch leaves it on; case is not significant', () => {
  assert.deepStrictEqual(ptyWindowsOptions({ CLAUDE_CUSTOM_CONPTY: 'bundled' }, 'win32'), { useConptyDll: true });
  assert.deepStrictEqual(ptyWindowsOptions({ CLAUDE_CUSTOM_CONPTY: 'BUILTIN' }, 'win32'), {});
});

test('off Windows there is nothing to choose', () => {
  assert.deepStrictEqual(ptyWindowsOptions({}, 'linux'), {});
  assert.deepStrictEqual(ptyWindowsOptions({}, 'darwin'), {});
});
