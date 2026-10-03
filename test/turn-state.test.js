'use strict';
/**
 * Is a turn running in the session's MAIN conversation, or is a dialog waiting on you (host/turn-state.js)?
 * PR #93 Dexter F1 / F2: the Type /merged gate read the subagent roster (blind to a main-session turn) and
 * "not looked at yet" (cleared by a glance). These pin the gate's new input: what the CLI's own hooks say.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createTurnState } = require('../host/turn-state');

const ev = (event, payload = {}) => ({ event, payload });
const run = (events) => {
  const t = createTurnState();
  for (const e of events) t.handle(e);
  return t.snapshot();
};
const START = ev('SessionStart', { source: 'startup' });

test('nothing is known until this host has seen the session start: unknown is not idle', () => {
  assert.strictEqual(run([]), null);
  assert.strictEqual(run([ev('Stop')]), null);
  assert.strictEqual(run([ev('Notification', { notification_type: 'idle_prompt' })]), null);
  assert.strictEqual(run([START]), 'idle');
});

test('Dexter F1: a main-session turn with tool calls and no subagent is a turn, until it stops', () => {
  assert.strictEqual(run([START, ev('UserPromptSubmit', { prompt: 'address the findings' })]), 'turn');
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash' }),
    ev('PostToolUse', { tool_name: 'Bash' })]), 'turn');
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop')]), 'idle');
});

test('a main-session tool call opens the turn even if its UserPromptSubmit was lost; a subagent\'s does not', () => {
  assert.strictEqual(run([START, ev('PreToolUse', { tool_name: 'Bash' })]), 'turn');
  assert.strictEqual(run([START, ev('PostToolUse', { tool_name: 'Bash', agent_id: 'a1' })]), 'idle');
});

test('Dexter F2: an open dialog is "prompt", and nothing but the session moving on clears it', () => {
  const asked = [START, ev('UserPromptSubmit'), ev('Notification', { notification_type: 'permission_prompt' })];
  assert.strictEqual(run(asked), 'prompt');
  // Claude Code's own idle reminder doesn't answer a dialog
  assert.strictEqual(run([...asked, ev('Notification', { notification_type: 'idle_prompt' })]), 'prompt');
  // answered: the tool ran (still in the turn), then the turn ended
  assert.strictEqual(run([...asked, ev('PostToolUse', { tool_name: 'Bash' })]), 'turn');
  assert.strictEqual(run([...asked, ev('Stop')]), 'idle');
  for (const type of ['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
    assert.strictEqual(run([START, ev('Notification', { notification_type: type })]), 'prompt', type);
  }
  // an older CLI names no type: it can't be told apart, so it's read as a dialog
  assert.strictEqual(run([START, ev('Notification', {})]), 'prompt');
  // a login or quota notice is nothing to answer
  assert.strictEqual(run([START, ev('Notification', { notification_type: 'auth_success' })]), 'idle');
});

test('a Stop that lists background agents still running keeps the turn open: their results start the next one', () => {
  const bg = { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] };
  const held = [START, ev('UserPromptSubmit'), ev('Stop', bg)];
  assert.strictEqual(run(held), 'turn');
  // the agent ends, the follow-up turn runs and stops with nothing left
  assert.strictEqual(run([...held, ev('SubagentStop', { agent_id: 'a1' }), ev('Stop')]), 'idle');
  // Claude Code's idle_prompt ends it only once every agent it waited on has stopped
  assert.strictEqual(run([...held, ev('Notification', { notification_type: 'idle_prompt' })]), 'turn');
  assert.strictEqual(run([...held, ev('SubagentStop', { agent_id: 'a1' }), ev('Notification', { notification_type: 'idle_prompt' })]), 'idle');
  // an agent already seen to stop isn't waited on
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('SubagentStop', { agent_id: 'a1' }), ev('Stop', bg)]), 'idle');
  // one with no id can only be resolved by a later Stop
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop', { background_tasks: [{ type: 'subagent', status: 'running' }] }),
    ev('Notification', { notification_type: 'idle_prompt' })]), 'turn');
});

test('an interrupted turn (no Stop) ends at Claude Code\'s idle_prompt, or stays a turn: never idle on a guess', () => {
  const interrupted = [START, ev('UserPromptSubmit')];
  assert.strictEqual(run(interrupted), 'turn');
  assert.strictEqual(run([...interrupted, ev('Notification', { notification_type: 'idle_prompt' })]), 'idle');
});

test('/clear and a resume start clean; a compaction mid-turn changes nothing; SessionEnd is unknown again', () => {
  const mid = [START, ev('UserPromptSubmit')];
  assert.strictEqual(run([...mid, ev('SessionStart', { source: 'compact' })]), 'turn');
  assert.strictEqual(run([...mid, ev('SessionStart', { source: 'clear' })]), 'idle');
  assert.strictEqual(run([...mid, ev('SessionStart', { source: 'resume' })]), 'idle');
  assert.strictEqual(run([...mid, ev('SessionEnd')]), null);
});

test('handle answers whether the snapshot changed, so the host broadcasts only a change', () => {
  const t = createTurnState();
  assert.strictEqual(t.handle(START), true);
  assert.strictEqual(t.handle(ev('Stop')), false);
  assert.strictEqual(t.handle(ev('UserPromptSubmit')), true);
  assert.strictEqual(t.handle(ev('PreToolUse', { tool_name: 'Bash' })), false);
  assert.strictEqual(t.handle(null), false);
  assert.strictEqual(t.handle(ev('Status', { model: 'x' })), false);
});

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'Stop', 'SubagentStop', 'SessionEnd'];
const anyEvent = fc.record({
  event: fc.constantFrom(...EVENTS),
  payload: fc.record({
    source: fc.constantFrom('startup', 'resume', 'clear', 'compact'),
    notification_type: fc.option(fc.constantFrom('permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog'), { nil: undefined }),
    agent_id: fc.option(fc.constantFrom('a1', 'a2'), { nil: undefined }),
    background_tasks: fc.option(fc.array(fc.record({ id: fc.constantFrom('a1', 'a2'), type: fc.constant('subagent'), status: fc.constantFrom('running', 'completed') }), { maxLength: 2 }), { nil: undefined }),
  }, { requiredKeys: [] }),
});

test('property: right after a UserPromptSubmit or a dialog, whatever came before, the session is never idle', () => {
  fc.assert(fc.property(fc.array(anyEvent, { maxLength: 30 }), fc.constantFrom('UserPromptSubmit', 'permission_prompt'), (events, last) => {
    const t = createTurnState();
    t.handle(START);
    for (const e of events) t.handle(e);
    const s = t.snapshot();
    if (s === null) return;     // a SessionEnd: unknown, which is not idle either
    t.handle(last === 'UserPromptSubmit' ? ev('UserPromptSubmit') : ev('Notification', { notification_type: 'permission_prompt' }));
    assert.notStrictEqual(t.snapshot(), 'idle');
    assert.notStrictEqual(t.snapshot(), null);
  }));
});

test('property: the snapshot is always one of null, idle, turn, prompt', () => {
  fc.assert(fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
    const t = createTurnState();
    for (const e of events) t.handle(e);
    assert.ok([null, 'idle', 'turn', 'prompt'].includes(t.snapshot()));
  }));
});
