'use strict';
/**
 * BACKLOG #10, the wire: a `{ type: 'agent-log' }` frame must be a CONTROL frame
 * (a type missing from the allow-list is typed into the pty, verbatim, in a
 * session that may be running with permissions bypassed), a malformed one must
 * do nothing, and the window's log must stop when the window goes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseControlFrame, handleFrame, validAgentLogRequest, MAX_AGENT_NAME } = require('../host/control');

test('an agent-log frame is recognised as control, not typed as input', () => {
  const frame = JSON.stringify({ type: 'agent-log', action: 'open', agent: 'code-reviewer' });
  assert.deepStrictEqual(parseControlFrame(frame), { type: 'agent-log', action: 'open', agent: 'code-reviewer' });
  const typed = [];
  const dispatched = [];
  handleFrame(frame, m => dispatched.push(m), t => typed.push(t));
  assert.strictEqual(typed.length, 0);
  assert.strictEqual(dispatched.length, 1);
});

test('validAgentLogRequest accepts open with an agent, and close with or without one', () => {
  assert.deepStrictEqual(validAgentLogRequest({ action: 'open', agent: 'rev' }), { action: 'open', agent: 'rev' });
  assert.deepStrictEqual(validAgentLogRequest({ action: 'close' }), { action: 'close', agent: null });
  assert.deepStrictEqual(validAgentLogRequest({ action: 'close', agent: 'rev' }), { action: 'close', agent: 'rev' });
});

test('validAgentLogRequest refuses everything else', () => {
  const bad = [
    null, undefined, 'open', 42, [],
    {}, { action: 'open' }, { action: 'open', agent: '' }, { action: 'open', agent: 7 },
    { action: 'open', agent: {} }, { action: 'open', agent: 'x'.repeat(MAX_AGENT_NAME + 1) },
    { action: 'delete', agent: 'rev' }, { action: 'OPEN', agent: 'rev' }, { agent: 'rev' },
  ];
  for (const b of bad) assert.strictEqual(validAgentLogRequest(b), null, JSON.stringify(b));
  // The bound is inclusive.
  assert.ok(validAgentLogRequest({ action: 'open', agent: 'x'.repeat(MAX_AGENT_NAME) }));
});

const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('host.js dispatches agent-log through the validator into a per-window session', () => {
  assert.ok(/msg\.type === 'agent-log'/.test(host), 'dispatchControl must handle agent-log');
  assert.ok(host.includes('validAgentLogRequest(msg)'), 'the frame must be validated before anything acts on it');
  assert.ok(host.includes('createLogSession({'), 'a log session is created per window');
  assert.ok(host.includes('mood.invocations()'), 'running state comes from the mood machine');
});

test('the window\'s log is closed when the window detaches', () => {
  const at = host.indexOf("ws.on('close'");
  assert.ok(at !== -1);
  const body = host.slice(at, host.indexOf('\n  });', at));
  assert.ok(body.includes('agentLog.close()'), 'a detached window must not leave a poll timer running');
});
