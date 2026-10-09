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

// ---- Mutation-survivor kills (backlog #58, release PR #101) ----

const task = (over) => ({ id: 'a1', type: 'subagent', status: 'running', ...over });
const stopWith = (tasks) => run([START, ev('UserPromptSubmit'), ev('Stop', { background_tasks: tasks })]);

test('a background task is waited on unless its status is one of the six ended statuses', () => {
  for (const status of ['completed', 'failed', 'killed', 'cancelled', 'stopped', 'error']) {
    assert.strictEqual(stopWith([task({ status })]), 'idle', `${status} has ended`);
    assert.strictEqual(stopWith([task({ status, type: undefined, agent_type: 'general' })]), 'idle', `${status} (agent_type)`);
  }
  for (const status of ['running', 'pending', 'weird', undefined]) {
    assert.strictEqual(stopWith([task({ status })]), 'turn', `${String(status)} is not known to have ended`);
  }
});

test('only a subagent-shaped task is waited on: type subagent, or a string agent_type', () => {
  assert.strictEqual(stopWith([task({ type: undefined, agent_type: 'general' })]), 'turn');
  assert.strictEqual(stopWith([task({ type: 'shell', agent_type: 'general' })]), 'turn');
  assert.strictEqual(stopWith([task({ type: 'subagent', agent_type: 7 })]), 'turn');
  assert.strictEqual(stopWith([task({ type: 'shell' })]), 'idle');
  assert.strictEqual(stopWith([task({ type: undefined, agent_type: 7 })]), 'idle');
  assert.strictEqual(stopWith([task({ type: undefined })]), 'idle');
  assert.strictEqual(stopWith([null]), 'idle');
  assert.strictEqual(stopWith([undefined, task({ status: 'completed' }), null]), 'idle');
  assert.strictEqual(stopWith([null, task()]), 'turn');
});

test('background_tasks that is not an array is read as no tasks, and never throws', () => {
  for (const bad of ['x', 7, { filter: () => [task()] }, null]) {
    assert.strictEqual(stopWith(bad), 'idle', JSON.stringify(bad));
  }
});

test('a freshly started session is at rest: a compact start (which resets nothing) is idle, not a turn or a dialog', () => {
  assert.strictEqual(run([ev('SessionStart', { source: 'compact' })]), 'idle');
});

test('SessionEnd forgets the turn, the dialog and every agent already seen to stop', () => {
  const compact = ev('SessionStart', { source: 'compact' });
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('SessionEnd'), compact]), 'idle');
  assert.strictEqual(run([START, ev('Notification', { notification_type: 'permission_prompt' }), ev('SessionEnd'), compact]), 'idle');
  // an id that stopped in the old session is not remembered in the new one
  assert.strictEqual(run([START, ev('SubagentStop', { agent_id: 'a1' }), ev('SessionEnd'), START,
    ev('UserPromptSubmit'), ev('Stop', { background_tasks: [task()] })]), 'turn');
});

test('a tool event proves a turn only for the MAIN session: no agent_id, an empty one or a non-string one', () => {
  assert.strictEqual(run([START, ev('PreToolUse', { agent_id: '' })]), 'turn');
  assert.strictEqual(run([START, ev('PreToolUse', { agent_id: 7 })]), 'turn');
  assert.strictEqual(run([START, ev('PostToolUseFailure', { tool_name: 'Bash' })]), 'turn');
  assert.strictEqual(run([START, ev('PostToolUse', { agent_id: 'a1' })]), 'idle');
  assert.strictEqual(run([START, ev('PreToolUse', { agent_id: 'a1' })]), 'idle');
  assert.strictEqual(run([START, ev('PostToolUseFailure', { agent_id: 'a1' })]), 'idle');
  // a subagent's tool call neither answers the main session's dialog nor opens a turn (PR #139 Dexter F2)
  const asked = [START, ev('Notification', { notification_type: 'permission_prompt' })];
  assert.strictEqual(run([...asked, ev('PreToolUse', { agent_id: 'a1' })]), 'prompt');
  assert.strictEqual(run([...asked, ev('PostToolUseFailure', {})]), 'turn');
});

test('SubagentStop remembers only a real (non-empty string) agent_id', () => {
  const stopOnly = (payload, tasks) => run([START, ev('UserPromptSubmit'), ev('SubagentStop', payload),
    ev('Stop', { background_tasks: tasks })]);
  assert.strictEqual(stopOnly({ agent_id: '' }, [task({ id: '' })]), 'turn');
  assert.strictEqual(stopOnly({}, [task({ id: undefined })]), 'turn');
  assert.strictEqual(stopOnly({ agent_id: 7 }, [task({ id: 7 })]), 'turn');
  assert.strictEqual(stopOnly({ agent_id: 'a1' }, [task()]), 'idle');
});

test('the ended-agent memory holds 200 ids and then forgets the oldest first', () => {
  const stops = (n) => Array.from({ length: n }, (_, i) => ev('SubagentStop', { agent_id: `x${i}` }));
  const after = (n, id) => run([START, ev('UserPromptSubmit'), ...stops(n),
    ev('Stop', { background_tasks: [task({ id })] })]);
  assert.strictEqual(after(200, 'x0'), 'idle', '200 ids all remembered');
  assert.strictEqual(after(200, 'x199'), 'idle');
  assert.strictEqual(after(201, 'x0'), 'turn', 'the 201st evicts the oldest');
  assert.strictEqual(after(201, 'x1'), 'idle', 'and only the oldest');
  assert.strictEqual(after(201, 'x200'), 'idle');
});

test('a payload that is missing or null is read as an empty one', () => {
  const t = createTurnState();
  assert.strictEqual(t.handle({ event: 'SessionStart' }), true);
  assert.strictEqual(t.snapshot(), 'idle');
  assert.strictEqual(t.handle({ event: 'UserPromptSubmit', payload: null }), true);
  assert.strictEqual(t.handle({ event: 'Stop', payload: null }), true);
  assert.strictEqual(t.snapshot(), 'idle');
  assert.strictEqual(t.handle({ event: 'Stop' }), false);
  assert.strictEqual(t.handle({ event: 5 }), false);
  assert.strictEqual(t.handle({}), false);
});

test('every clean start (startup, resume, clear) drops an open turn, dialog and held agents; compact keeps them', () => {
  const bg = { background_tasks: [task()] };
  for (const source of ['startup', 'resume', 'clear']) {
    const start = ev('SessionStart', { source });
    assert.strictEqual(run([START, ev('UserPromptSubmit'), start]), 'idle', `${source}: turn`);
    assert.strictEqual(run([START, ev('Notification', { notification_type: 'permission_prompt' }), start]), 'idle', `${source}: dialog`);
    // held agents are forgotten too: a later main-session call opens a turn that idle_prompt then ends
    assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop', bg), start, ev('PreToolUse'),
      ev('Notification', { notification_type: 'idle_prompt' })]), 'idle', `${source}: held`);
  }
  const compact = ev('SessionStart', { source: 'compact' });
  assert.strictEqual(run([START, ev('Notification', { notification_type: 'permission_prompt' }), compact]), 'prompt');
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop', bg), compact, ev('Notification', { notification_type: 'idle_prompt' })]), 'turn');
});

// --- BACKLOG #77 R1: a turn that only reads and edits ---------------------------------------------------------

test('R1: Stop, then a blocked stop\'s continuation that only Reads and Edits, is a turn again', () => {
  const edit = ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'CURRENT-feat-a.md' } });
  const read = ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'CURRENT-feat-a.md' } });
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop'), read, edit]), 'turn');
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop'), edit]), 'turn');
});

test('R1: a Stop with no continuation is idle, and a subagent\'s Edit after it opens nothing', () => {
  const edit = ev('PreToolUse', { tool_name: 'Edit', agent_id: 'a1' });
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Edit' }), ev('Stop')]), 'idle');
  assert.strictEqual(run([START, ev('UserPromptSubmit'), ev('Stop'), edit]), 'idle');
});

// Dexter F2 (PR #139): "a tool moved, so the dialog was answered" is true only of the MAIN session's tools.
test('F2: a subagent\'s or teammate\'s Read does not close the main session\'s open dialog; the main session\'s does', () => {
  const dialog = [START, ev('UserPromptSubmit'), ev('Notification', { notification_type: 'permission_prompt' })];
  assert.strictEqual(run(dialog), 'prompt');
  assert.strictEqual(run([...dialog, ev('PreToolUse', { tool_name: 'Read', agent_id: 'a1' })]), 'prompt');
  assert.strictEqual(run([...dialog, ev('PostToolUse', { tool_name: 'Bash', agent_id: 'a1' })]), 'prompt');
  assert.strictEqual(run([...dialog, ev('PreToolUse', { tool_name: 'Read' })]), 'turn');
  assert.strictEqual(run([...dialog, ev('PostToolUse', { tool_name: 'Bash', agent_id: '' })]), 'turn', 'an empty id is not a subagent');
});
