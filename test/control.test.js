'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { validResizeDims, classifyFrame } = require('../host/control');

test('validResizeDims rejects the exact inputs that throw in node-pty or silently clamp in xterm', () => {
  // Miguel, code review 2026-09-14: node-pty throws on cols/rows <= 0 or NaN;
  // @xterm/headless instead clamps to a minimum of 2. Unvalidated, the two
  // resize targets disagree and the replay buffer desyncs permanently.
  assert.strictEqual(validResizeDims(0, 30), false);
  assert.strictEqual(validResizeDims(-5, 30), false);
  assert.strictEqual(validResizeDims(null, 30), false);
  assert.strictEqual(validResizeDims(80, undefined), false);
  assert.strictEqual(validResizeDims(1.5, 30), false);
  assert.strictEqual(validResizeDims(80, 30), true);
});

test('validResizeDims rejects a size large enough to be a mistake rather than a real terminal', () => {
  assert.strictEqual(validResizeDims(100000, 30), false);
});

test('classifyFrame treats literal text starting with "{" as input when it is not valid JSON', () => {
  assert.strictEqual(classifyFrame('{not json'), null);
});

test('classifyFrame treats plain typed text as input', () => {
  assert.strictEqual(classifyFrame('ls -la\r'), null);
});

test('classifyFrame treats valid JSON with no recognized type as input, not a control message', () => {
  // A user could genuinely type or paste a JSON object with no `type` field.
  assert.strictEqual(classifyFrame('{"foo":"bar"}'), null);
});

test('classifyFrame returns the parsed message when it is valid JSON with a string type', () => {
  assert.deepStrictEqual(
    classifyFrame('{"type":"resize","cols":0,"rows":30}'),
    { type: 'resize', cols: 0, rows: 30 },
  );
});
