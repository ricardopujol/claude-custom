'use strict';
/**
 * What the host READS out of Claude Code's hook payloads.
 *
 * Every one of these fields is a guess about someone else's data until it is
 * checked against a real event. tool_name was such a guess: the host read
 * "Task", Claude Code sends "Agent", and the roster stayed empty through a
 * green suite, two passing probes and a screenshot -- because every fixture
 * supplied the shape it expected.
 *
 * This file lists the reads. verify/probe-payloads.js then drives the REAL CLI
 * and checks the list against what actually arrives, so the next rename shows
 * up as a failing probe instead of a feature that quietly does nothing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { CONTRACT, fieldsFor, checkPayload } = require('../host/payload-contract');

test('every event the settings file hooks is in the contract', () => {
  const { buildHarnessSettings } = require('../host/settings-writer');
  const hooked = Object.keys(buildHarnessSettings({ helperPath: 'C:/h/x.exe', pipeName: 'p' }).hooks);
  for (const event of hooked) {
    assert.ok(CONTRACT[event], `${event} is hooked but nothing records what the host reads from it`);
  }
});

// FF12 (2026-09-23): effort.level and permission_mode are hooks.md "common
// input fields" -- present on every real hooked event -- so every fixture in
// this file that claims `ok: true` must carry them too. This is exactly the
// file's own warning about fixtures supplying the shape they expect: a
// fixture missing a field every real payload has is not a passing case, it is
// a stale one.
const COMMON = { effort: { level: 'high' }, permission_mode: 'bypass' };

test('a payload carrying every required field passes', () => {
  const ok = checkPayload('PreToolUse', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'code-reviewer' },
    ...COMMON,
  });
  assert.deepStrictEqual(ok.missing, []);
  assert.strictEqual(ok.ok, true);
});

test('a missing field is named, not merely counted', () => {
  // "3 fields missing" sends you reading source. The NAME sends you to the fix.
  const res = checkPayload('PreToolUse', { hook_event_name: 'PreToolUse' });
  assert.ok(res.missing.includes('tool_name'), JSON.stringify(res.missing));
  assert.strictEqual(res.ok, false);
});

test('a field the host reads only for SOME tools is not reported missing', () => {
  // subagent_type exists on an agent launch and not on a Bash call. Flagging it
  // every time would train everyone to ignore the report.
  const res = checkPayload('PreToolUse', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    ...COMMON,
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res.missing));
});

test('effort.level and permission_mode are required on every event, since every real payload carries them', () => {
  for (const event of Object.keys(CONTRACT)) {
    const spec = CONTRACT[event];
    assert.ok(spec.fields['effort.level'], `${event} is missing effort.level from the contract`);
    assert.ok(spec.fields.permission_mode, `${event} is missing permission_mode from the contract`);
  }
});

test('an unknown event is reported rather than silently passing', () => {
  // A new hook event the host does not know about is exactly the thing this
  // exists to surface.
  const res = checkPayload('SomethingNew', {});
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /unknown event/i);
});

test('the contract records WHY each field is read, not just its name', () => {
  // A field with no stated consumer cannot be judged when it disappears: is
  // this a broken feature or a leftover?
  for (const [event, spec] of Object.entries(CONTRACT)) {
    for (const field of fieldsFor(event)) {
      assert.ok(spec.fields[field.path].used, `${event}.${field.path} records no consumer`);
    }
  }
});

test('the agent-launch tool names are listed, since that is the field that moved', () => {
  assert.ok(CONTRACT.PreToolUse.agentTools.includes('Agent'));
  assert.ok(CONTRACT.PreToolUse.agentTools.includes('Task'));
});

test('nested fields are addressed by path', () => {
  const res = checkPayload('PostToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'x' },
    tool_response: {},
    ...COMMON,
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res.missing));
});
