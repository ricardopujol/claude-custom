'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { stopPty } = require('../host/pty-stop');

test('the process tree is killed first, then the pty is closed', () => {
  const calls = [];
  const term = { kill: () => calls.push('kill') };
  stopPty(term, { killChildTree: (t) => { assert.strictEqual(t, term); calls.push('tree'); } });
  assert.deepStrictEqual(calls, ['tree', 'kill']);
});

test('a failing tree kill does not stop the pty from being closed, and a failing close is swallowed', () => {
  let closed = false;
  stopPty({ kill: () => { closed = true; throw new Error('gone'); } }, { killChildTree: () => { throw new Error('taskkill'); } });
  assert.strictEqual(closed, true);
});

test('no pty is nothing to do', () => {
  assert.doesNotThrow(() => stopPty(null, { killChildTree: () => { throw new Error('never'); } }));
});
