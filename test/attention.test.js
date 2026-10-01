'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createAttention } = require('../host/attention');

function harness(opts = {}) {
  let now = 1_000_000;
  const sent = [];
  const a = createAttention({ now: () => now, project: 'claude-custom', ...opts });
  a.on('attention', e => sent.push(e));
  return {
    a, sent,
    advance(ms) { now += ms; },
    fire(event, payload = {}) { a.handle({ event, payload }); },
  };
}

test('a Notification hook means the session wants input', () => {
  const h = harness();
  h.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'input-needed');
});

test('a Stop hook means the turn finished', () => {
  const h = harness();
  h.fire('Stop', {});
  assert.strictEqual(h.sent[0].kind, 'finished');
});

test('every notification names the project', () => {
  // Several windows can be open at once; "Claude is done" is useless without
  // saying which one.
  const h = harness({ project: 'komodo-agency' });
  h.fire('Stop', {});
  assert.strictEqual(h.sent[0].project, 'komodo-agency');
});

test('carries the hook message when there is one', () => {
  const h = harness();
  h.fire('Notification', { message: 'needs permission to run npm test' });
  assert.match(h.sent[0].body, /npm test/);
});

test('a finished turn still reads sensibly with no message', () => {
  const h = harness();
  h.fire('Stop', {});
  assert.ok(h.sent[0].title);
  assert.ok(h.sent[0].body);
});

test('repeated identical events inside the debounce window fire once', () => {
  // Stop can fire more than once around a single turn ending. Two toasts for
  // one event trains you to ignore them.
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', {});
  h.advance(100);
  h.fire('Stop', {});
  assert.strictEqual(h.sent.length, 1);
});

test('the same event fires again after the debounce window', () => {
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', {});
  h.advance(5001);
  h.fire('Stop', {});
  assert.strictEqual(h.sent.length, 2);
});

test('input-needed is not suppressed by a preceding finished', () => {
  // They are different kinds. Debouncing across kinds would swallow a request
  // for input because a turn happened to end moments earlier.
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', {});
  h.fire('Notification', { message: 'permission needed' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished', 'input-needed']);
});

test('input-needed outranks finished in urgency', () => {
  // A waiting prompt blocks progress; a finished turn does not.
  const h = harness();
  h.fire('Notification', { message: 'x' });
  h.fire('Stop', {});
  assert.ok(h.sent[0].urgent);
  assert.ok(!h.sent[1].urgent);
});

test('unrelated hook events raise nothing', () => {
  const h = harness();
  h.fire('PreToolUse', { tool_name: 'Bash' });
  h.fire('PostToolUse', { tool_name: 'Bash' });
  h.fire('SubagentStop', {});
  assert.deepStrictEqual(h.sent, []);
});

test('a SubagentStop is not a finished turn', () => {
  // Subagents stop constantly mid-task. Notifying on those would fire dozens of
  // times during one piece of work.
  const h = harness();
  h.fire('SubagentStop', {});
  assert.deepStrictEqual(h.sent, []);
});

// --- only when it needs you, or is really done (Ricardo, 2026-10-01) -------------
// Notification fires for many things that aren't a request for input, and Stop
// fires at the end of every TURN -- including one that ends while background
// agents are still working, which is not "finished".

test('a Notification raises only for the types that need your input', () => {
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
    const h = harness();
    h.fire('Notification', { message: 'x', notification_type: type });
    assert.deepStrictEqual(h.sent.map(e => e.kind), ['input-needed'], type);
  }
});

test('a Notification that does not need input raises nothing', () => {
  for (const type of ['idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response',
    'agent_completed', 'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
    'some_type_added_later', '', 5, null]) {
    const h = harness();
    h.fire('Notification', { message: 'Claude is waiting for your input', notification_type: type });
    assert.deepStrictEqual(h.sent, [], String(type));
  }
});

test('a Notification with no type (an older CLI) still raises: it cannot be told apart', () => {
  const h = harness();
  h.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['input-needed']);
});

test('a Stop while a subagent still runs is not finished: nothing is raised', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', agent_type: 'logic-reviewer' }] });
  assert.deepStrictEqual(h.sent, []);
});

test('the Stop after the last agent returns is finished', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] });
  assert.deepStrictEqual(h.sent, []);
  h.fire('Stop', { background_tasks: [] });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('a held-back Stop does not debounce the real one', () => {
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] });
  h.advance(100);
  h.fire('Stop', {});
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('only a RUNNING subagent holds back finished: a shell, or a done task, does not', () => {
  const cases = [
    [{ id: 's1', type: 'shell', status: 'running', description: 'npm run dev' }],
    [{ id: 'a1', type: 'subagent', status: 'completed' }],
    [{ id: 'a1', type: 'subagent', status: 'failed' }],
    [null, 'x', 5],
    'not a list',
  ];
  for (const background_tasks of cases) {
    const h = harness();
    h.fire('Stop', { background_tasks });
    assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished'], JSON.stringify(background_tasks));
  }
});

test('a subagent with no status, or no type but an agent_type, still counts as running', () => {
  for (const task of [{ id: 'a1', type: 'subagent' }, { id: 'a1', agent_type: 'Explore', status: 'running' }]) {
    const h = harness();
    h.fire('Stop', { background_tasks: [task] });
    assert.deepStrictEqual(h.sent, [], JSON.stringify(task));
  }
});

// --- Dexter, notify F1 (High): a held-back "finished" must come back ---------
// Holding a Stop promises a later one that nothing guarantees: a resume that
// never notifies, a follow-up turn ending in StopFailure. Once every agent the
// held Stop waited on has stopped, Claude Code's own idle_prompt -- its own
// "nothing is happening" -- raises it. Ricardo, 2026-10-01: idle_prompt only.
// A settle timer was tried and fired into a working session (round 2, F1):
// the host never sees UserPromptSubmit, and its tool hooks cover Agent, Task
// and Bash only, so "the main session is quiet" can't be known from here.
const fs = require('fs');
const path = require('path');
const RUN = id => ({ id, type: 'subagent', status: 'running', agent_type: 'general-purpose' });

test('the real capture: Stop (1 running) -> SubagentStop -> Stop (0 running) raises finished once', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'hooks-real-subagent-failure.fixture.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  const h = harness();
  for (const l of lines) { const p = l.payload || l; h.a.handle({ event: p.hook_event_name, payload: p }); h.advance(10); }
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('no new turn after the last agent stops: the idle prompt is finished, once', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [RUN('r1')] });
  h.fire('SubagentStop', { agent_id: 'r1' });
  assert.deepStrictEqual(h.sent, []);
  h.fire('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
  h.advance(120000);
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

// Round 2, F1 (High), production-shaped: the session works on after the
// agent returns -- a 90 s `npm test` -- and its own Stop ends the turn.
test('the main session working on after the agent returns: one finished, at its own Stop', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [RUN('r1')] });
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  h.advance(90000);
  assert.deepStrictEqual(h.sent, [], 'nothing fires while it works');
  h.fire('PostToolUse', { tool_name: 'Bash' });
  h.fire('Stop', { background_tasks: [] });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished'], 'and the idle prompt after it adds nothing');
});

// Round 2, F2 (High): the agent's SubagentStop reaches the host BEFORE the
// Stop that still lists it as running (the list is read while that hook
// runs). An agent already seen to stop is not waited on.
test('SubagentStop before the Stop that still lists it as running: finished at that Stop', () => {
  const h = harness();
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('Stop', { background_tasks: [RUN('r1')] });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('one stale entry and one live agent: still held, then the idle prompt after the live one stops', () => {
  const h = harness();
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('Stop', { background_tasks: [RUN('r1'), RUN('r2')] });
  assert.deepStrictEqual(h.sent, []);
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent, [], 'r2 still runs');
  h.fire('SubagentStop', { agent_id: 'r2' });
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('an idle prompt while an agent still runs is not finished', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [RUN('r1'), RUN('r2')] });
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent, []);
  h.fire('SubagentStop', { agent_id: 'r2' });
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('an idle prompt with nothing held back is still nothing', () => {
  const h = harness();
  h.fire('Stop', {});
  h.fire('Notification', { notification_type: 'idle_prompt' });
  h.advance(10000);
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
});

test('a SubagentStop for an agent the held Stop did not list changes nothing', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [RUN('r1')] });
  h.fire('SubagentStop', { agent_id: 'other' });
  h.fire('SubagentStop', {});
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent, []);
});

test('a later Stop takes over from the held one', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [RUN('r1')] });
  h.fire('Stop', { background_tasks: [] });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished']);
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished'], 'nothing is still held');
});

test('SessionEnd drops anything held, and what it knew', () => {
  const h = harness();
  h.fire('Stop', { background_tasks: [RUN('r1')] });
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('SessionEnd', {});
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent, []);
});

// --- Dexter F2 (Low) / Miguel 2-3: which tasks hold it back ------------------
test('any running subagent in a mixed list holds it back', () => {
  for (const tasks of [
    [{ id: 'a', type: 'subagent', status: 'completed' }, RUN('b')],
    [RUN('b'), { id: 's', type: 'shell', status: 'running' }],
  ]) {
    const h = harness();
    h.fire('Stop', { background_tasks: tasks });
    assert.deepStrictEqual(h.sent, [], JSON.stringify(tasks));
  }
});

test('a list with no running subagent does not hold it back', () => {
  for (const tasks of [
    [{ id: 's', type: 'shell', status: 'running' }, { id: 'a', type: 'subagent', status: 'completed' }],
    [{ id: 'x', status: 'running' }],                       // neither a type nor an agent_type
  ]) {
    const h = harness();
    h.fire('Stop', { background_tasks: tasks });
    assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished'], JSON.stringify(tasks));
  }
});

test('an unknown status, or a new kind of agent, holds it back (fails closed, the backstop resolves it)', () => {
  for (const task of [
    { id: 'a', type: 'subagent', status: 'pending' },
    { id: 'a', type: 'remote_agent', status: 'running', agent_type: 'x' },
  ]) {
    const h = harness();
    h.fire('Stop', { background_tasks: [task] });
    assert.deepStrictEqual(h.sent, [], JSON.stringify(task));
    h.fire('SubagentStop', { agent_id: 'a' });
    h.fire('Notification', { notification_type: 'idle_prompt' });
    assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished'], JSON.stringify(task));
  }
});

test('the terminal statuses do not hold it back', () => {
  for (const status of ['completed', 'failed', 'killed', 'cancelled', 'stopped', 'error']) {
    const h = harness();
    h.fire('Stop', { background_tasks: [{ id: 'a', type: 'subagent', status }] });
    assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished'], status);
  }
});
