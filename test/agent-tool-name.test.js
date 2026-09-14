'use strict';
/**
 * The subagent tool is called "Agent", not "Task".
 *
 * Verified against the real CLI (verify/probe-live-agent.js), which sends:
 *
 *   {"hook_event_name":"PreToolUse","tool_name":"Agent",
 *    "tool_input":{"description":...,"prompt":...,"subagent_type":"code-reviewer"}}
 *
 * Every test and probe in this repo hand-fired tool_name:"Task", so all of them
 * passed while the roster stayed empty in every real session. The fixtures
 * encoded the assumption they were supposed to be checking -- the same failure
 * that hid the portrait path mismatch.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createMoodMachine } = require('../host/mood-machine');
const { buildHarnessSettings } = require('../host/settings-writer');

// The payload verbatim from the real CLI, trimmed to the fields the host reads.
const realAgentLaunch = {
  event: 'PreToolUse',
  payload: {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'Say OK', prompt: 'say OK', subagent_type: 'code-reviewer' },
  },
};

test('a real agent launch puts the agent on the roster', () => {
  const mood = createMoodMachine();
  mood.handle(realAgentLaunch);
  assert.deepStrictEqual(mood.stack(), ['code-reviewer']);
});

test('a real agent launch sets it working', () => {
  const mood = createMoodMachine();
  const seen = [];
  mood.on('change', e => seen.push(`${e.agent}:${e.state}`));
  mood.handle(realAgentLaunch);
  assert.ok(seen.includes('code-reviewer:working'), JSON.stringify(seen));
});

test('the older Task name still works', () => {
  // Older Claude Code versions, and anything that still sends it. Accepting
  // both costs nothing; guessing wrong costs the whole roster.
  const mood = createMoodMachine();
  mood.handle({
    event: 'PreToolUse',
    payload: { tool_name: 'Task', tool_input: { subagent_type: 'code-reviewer' } },
  });
  assert.deepStrictEqual(mood.stack(), ['code-reviewer']);
});

test('a tool that is not an agent launch does not create a roster entry', () => {
  // Bash is matched too, for the process panel. It must not invent an agent.
  const mood = createMoodMachine();
  mood.handle({
    event: 'PreToolUse',
    payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
  });
  assert.deepStrictEqual(mood.stack(), []);
});

test('an agent launch with no subagent_type is ignored, not named "Agent"', () => {
  const mood = createMoodMachine();
  mood.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: {} } });
  assert.deepStrictEqual(mood.stack(), []);
});

test('the settings matcher includes Agent', () => {
  // The hook happens to fire today without it, but relying on that is relying
  // on how Claude Code resolves a matcher that does not match.
  const s = buildHarnessSettings({ helperPath: 'C:/h/x.exe', pipeName: 'p' });
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const m = s.hooks[event][0].matcher;
    assert.ok(/\bAgent\b/.test(m), `${event} matcher is ${m}`);
    assert.ok(/\bBash\b/.test(m), `${event} matcher is ${m}`);
  }
});

test('the matcher still does not tax ordinary file tools', () => {
  const s = buildHarnessSettings({ helperPath: 'C:/h/x.exe', pipeName: 'p' });
  const m = s.hooks.PreToolUse[0].matcher;
  for (const tool of ['Read', 'Grep', 'Edit', 'Write', 'Glob']) {
    assert.ok(!new RegExp(`\b${tool}\b`).test(m), `${tool} must not be matched`);
  }
});
