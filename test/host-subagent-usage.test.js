'use strict';
/**
 * SubagentStop refreshes the token count at once (PR #46).
 *
 * Before, only the agent stats refreshed on SubagentStop, so the agents panel
 * updated instantly while the session token headline waited up to 5 seconds
 * for the usage timer. Miguel (#46 review) added that the milestone check must
 * ride along: otherwise the headline crosses a rung and the flourish still
 * waits for the next tick.
 *
 * SOURCE assertions, in the style of test/host-listen.test.js, because host.js
 * cannot be required in a unit test without spawning a pty.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

// From the SubagentStop `if` to the end of the hook-event handler. Bounded, or
// the slice runs on into the usage timer and borrows ITS checkMilestone call --
// which is exactly how the first draft of this test passed against the bug.
function subagentStopBranch() {
  const start = HOST.indexOf("ev.event === 'SubagentStop'");
  assert.ok(start !== -1, 'host.js must handle SubagentStop for this check to mean anything');
  const end = HOST.indexOf("hookBridge.on('parse-error'", start);
  assert.ok(end !== -1, 'the hook handler must end where this test expects');
  return HOST.slice(start, end);
}

test('SubagentStop refreshes usage through the shared, coalesced reader', () => {
  // refreshUsage(), not a new inline readUsage(): the shared promise is what
  // keeps this and the 5s timer from racing each other.
  const branch = subagentStopBranch();
  assert.ok(/refreshUsage\(\)/.test(branch), 'SubagentStop must call refreshUsage()');
  assert.ok(!/readUsage\(/.test(branch), 'SubagentStop must not read usage around the coalescing');
});

test('SubagentStop broadcasts the usage in the same shape as every other emitter', () => {
  assert.ok(/broadcastControl\(\{\s*type:\s*'usage',\s*usage\s*\}\)/.test(subagentStopBranch()),
    "SubagentStop must broadcast { type: 'usage', usage }");
});

test('SubagentStop checks the milestone with the fresh usage', () => {
  assert.ok(/checkMilestone\(usage\)/.test(subagentStopBranch()),
    'a rung crossed by a finished agent must not wait for the next timer tick');
});
