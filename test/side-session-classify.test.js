'use strict';
// PR #232 Miguel G4 (and #122): the tool names read out of the installed CLI binary that sdk-tools.d.ts does not declare, so the
// declared-tools test (side-session-r2) cannot see them and only the live probe would. Pinned by name, with the reason each was classified.
const test = require('node:test');
const assert = require('node:assert');
const side = require('../host/side-session');

test('the four names CLI 2.1.318 reports for the MCP resource tools and ToolSearch are reviewed, and none is offered to a side session', () => {
  for (const t of ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'ToolSearch']) {
    assert.ok(side.SIDE_REVIEWED_TOOLS.includes(t), `${t} is reviewed`);
    assert.ok(!side.SIDE_ALLOWED_TOOLS.includes(t), `${t} stays off the allow-list`);
  }
});

test('REPL (alias Eval) runs a script that can call other tools: it is denied by name, and a denied tool is a reviewed one', () => {
  for (const t of ['REPL', 'Eval']) {
    assert.ok(side.SIDE_DENIED_TOOLS.includes(t), `${t} is denied`);
    assert.ok(side.SIDE_REVIEWED_TOOLS.includes(t));
    assert.ok(!side.SIDE_ALLOWED_TOOLS.includes(t));
  }
});

test('SendUserMessage (the CLI\'s Brief tool) is reviewed and left off the allow-list', () => {
  assert.ok(side.SIDE_REVIEWED_TOOLS.includes('SendUserMessage'));
  assert.ok(!side.SIDE_ALLOWED_TOOLS.includes('SendUserMessage'));
});
