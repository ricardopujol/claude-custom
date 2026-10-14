'use strict';
/**
 * "Ask the repo" wiring that only a running host has (BACKLOG #33): a frame of an unlisted type is TYPED into the pty as JSON (it has
 * happened twice in this repo), so the `ask` type must be listed, dispatched, and never reach a host that does not know it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseControlFrame, CONTROL_TYPES } = require('../host/control');

const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the ask frame is a known control type, never pty input', () => {
  assert.ok(CONTROL_TYPES.has('ask'));
  assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: 'ask', op: 'status', seq: 1 })), { type: 'ask', op: 'status', seq: 1 });
});

test('host.js dispatches ask to the service and answers on the same socket', () => {
  const at = HOST_SRC.indexOf("msg.type === 'ask'");
  assert.ok(at !== -1, 'dispatchControl must handle ask');
  const branch = HOST_SRC.slice(at, HOST_SRC.indexOf("if (msg.type ===", at + 10));
  assert.match(branch, /askService\.handle\(msg\)/);
  assert.match(branch, /ws\.send\(JSON\.stringify\(reply\)\)/);
  assert.match(branch, /return;/);
});

test('the host builds the Claude answerer from the claude it resolved for the session, with no API key of its own', () => {
  assert.match(HOST_SRC, /createClaudeAnswerer\(\{ claudeBin: CLAUDE_BIN, anchor: CWD \}\)/, 'the tab\'s own cwd anchors a relative CLAUDE_CONFIG_DIR (PR #169 Dexter N5)');
  assert.doesNotMatch(HOST_SRC, /ANTHROPIC_API_KEY/);
});
