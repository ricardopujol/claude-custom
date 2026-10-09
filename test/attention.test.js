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

test('only a RUNNING subagent or young shell holds back finished: a done task does not', () => {
  const cases = [
    [{ id: 's1', type: 'shell', status: 'completed', description: 'npm run dev' }],
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

test('a list with no running subagent or shell does not hold it back', () => {
  for (const tasks of [
    [{ id: 's', type: 'shell', status: 'completed' }, { id: 'a', type: 'subagent', status: 'completed' }],
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

// --- BACKLOG #78 follow-up: "finished" waits for background shells younger than 10 minutes ----------------------
// Ricardo, 2026-10-09: a dev server or a watcher doesn't hold it back forever. The shape is measured, not guessed:
// verify/probe-background-shell.js (a Stop's background_tasks entry for a shell is { id, type: 'shell', status,
// description, command }, with NO start time, so age comes from the task's own output file or from first sight).
const { makeShellStartedAt, SHELL_MAX_AGE_MS } = require('../host/attention');
const { tmpDir } = require('./tmp-dir');
const MIN = 60000;
const SHELL = (id, extra = {}) => ({ id, type: 'shell', status: 'running', description: 'npm run dev', command: 'npm run dev', ...extra });

function shellHarness({ startedAt = {}, ...opts } = {}) {
  let now = 1_000_000;
  const sent = [];
  const timers = [];
  const a = createAttention({
    now: () => now, project: 'p',
    shellStartedAt: (task) => (task.id in startedAt ? startedAt[task.id] : null),
    setTimer: (fn, ms) => { const t = { fn, ms, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    ...opts,
  });
  a.on('attention', e => sent.push(e));
  return {
    a, sent, timers,
    fire(event, payload = {}) { a.handle({ event, payload }); },
    kinds() { return sent.map(e => e.kind); },
    live() { return timers.filter(t => t.live); },
    // Time passes; every timer that came due runs, earliest first.
    advance(ms) {
      const to = now + ms;
      for (;;) {
        const due = timers.filter(t => t.live && t.at <= to).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        now = due.at; due.live = false; due.fn();
      }
      now = to;
    },
  };
}
const AGO = n => 1_000_000 - n;

test('a young shell holds finished back; nothing is raised at the Stop', () => {
  const h = shellHarness({ startedAt: { s1: AGO(2 * MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.deepStrictEqual(h.sent, []);
});

test('the Stop after the young shell ends is finished, once', () => {
  const h = shellHarness({ startedAt: { s1: AGO(2 * MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  h.advance(3 * MIN);
  h.fire('Stop', { background_tasks: [] });
  assert.deepStrictEqual(h.kinds(), ['finished']);
  h.advance(30 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished'], 'the old timer is gone: no second one');
});

test('a shell already older than 10 minutes does not hold finished back', () => {
  const h = shellHarness({ startedAt: { s1: AGO(10 * MIN + 1) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.deepStrictEqual(h.kinds(), ['finished']);
  assert.deepStrictEqual(h.live(), [], 'and nothing is left waiting');
});

test('exactly 10 minutes old counts as old (the boundary)', () => {
  const h = shellHarness({ startedAt: { s1: AGO(SHELL_MAX_AGE_MS) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('the limit is 10 minutes', () => {
  assert.strictEqual(SHELL_MAX_AGE_MS, 10 * MIN);
});

test('a shell that turns 10 minutes old while the turn is over: finished fires once, at that moment', () => {
  const h = shellHarness({ startedAt: { s1: AGO(4 * MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.strictEqual(h.live().length, 1);
  assert.strictEqual(h.live()[0].ms, 6 * MIN, 'the timer is set for the remaining 6 minutes');
  h.advance(5 * MIN);
  assert.deepStrictEqual(h.sent, []);
  h.advance(1 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished']);
  h.advance(60 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished'], 'once');
});

test('an unknown age is young, anchored at the first Stop that listed it: it never blocks forever', () => {
  const h = shellHarness();                                  // startedAt gives null for everything
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.deepStrictEqual(h.sent, []);
  h.advance(9 * MIN);
  assert.deepStrictEqual(h.sent, []);
  h.advance(1 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('an unknown age keeps its first-seen anchor across Stops (a later Stop does not restart the 10 minutes)', () => {
  const h = shellHarness();
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  h.advance(8 * MIN);
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.strictEqual(h.live().length, 1);
  assert.strictEqual(h.live()[0].ms, 2 * MIN);
  h.advance(2 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('a shell with no id still waits, for 10 minutes from this Stop', () => {
  const h = shellHarness();
  h.fire('Stop', { background_tasks: [SHELL(undefined)] });
  assert.deepStrictEqual(h.sent, []);
  h.advance(10 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('only a shell holds it back: the other task types and ended shells do not', () => {
  for (const t of [
    { id: 'm1', type: 'monitor', status: 'running' },
    { id: 'w1', type: 'workflow', status: 'running' },
    SHELL('s1', { status: 'completed' }), SHELL('s2', { status: 'killed' }), SHELL('s3', { status: 'failed' }),
  ]) {
    const h = shellHarness({ startedAt: { [t.id]: AGO(MIN) } });
    h.fire('Stop', { background_tasks: [t] });
    assert.deepStrictEqual(h.kinds(), ['finished'], JSON.stringify(t));
  }
});

test('a shell with a status that is not a known end is read as running (fails closed)', () => {
  const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1', { status: 'pending' })] });
  assert.deepStrictEqual(h.sent, []);
});

test('the youngest shell sets the wait; an old shell does not hold it', () => {
  const h = shellHarness({ startedAt: { old: AGO(30 * MIN), mid: AGO(7 * MIN), fresh: AGO(1 * MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('old'), SHELL('mid'), SHELL('fresh')] });
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.live().length, 1, 'one timer');
  assert.strictEqual(h.live()[0].ms, 9 * MIN, 'for the LAST young shell to turn 10 minutes old');
  h.advance(9 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('subagent and shell: finished waits for both', () => {
  const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
  h.fire('Stop', { background_tasks: [RUN('r1'), SHELL('s1')] });
  h.fire('SubagentStop', { agent_id: 'r1' });
  assert.deepStrictEqual(h.sent, [], 'the agent is done, the shell is young');
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.sent, [], 'the idle prompt does not release a young shell');
  h.advance(9 * MIN);
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('subagent and shell: the shell is old by the time the agent stops, so the idle prompt releases it', () => {
  const h = shellHarness({ startedAt: { s1: AGO(9 * MIN) } });
  h.fire('Stop', { background_tasks: [RUN('r1'), SHELL('s1')] });
  h.advance(2 * MIN);                                        // the timer comes due while the agent still runs
  assert.deepStrictEqual(h.sent, [], 'the agent still runs');
  h.fire('SubagentStop', { agent_id: 'r1' });
  h.fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test('a subagent that outlives the shell: the shell timer alone does not raise finished', () => {
  const h = shellHarness({ startedAt: { s1: AGO(9 * MIN) } });
  h.fire('Stop', { background_tasks: [RUN('r1'), SHELL('s1')] });
  h.advance(60 * MIN);
  assert.deepStrictEqual(h.sent, []);
});

test('a turn that follows (tool use) cancels the wait: its own Stop decides, not a timer firing into a working session', () => {
  const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  h.fire('PreToolUse', { tool_name: 'Read' });
  assert.deepStrictEqual(h.live(), []);
  h.advance(60 * MIN);
  assert.deepStrictEqual(h.sent, []);
  h.fire('Stop', { background_tasks: [SHELL('s1', { status: 'completed' })] });
  assert.deepStrictEqual(h.kinds(), ['finished']);
});

test("a subagent's own tool events do not cancel the wait", () => {
  const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  h.fire('PreToolUse', { tool_name: 'Read', agent_id: 'r9' });
  h.fire('PostToolUse', { tool_name: 'Read', agent_id: 'r9' });
  assert.strictEqual(h.live().length, 1);
});

test('every main-session activity event cancels the wait', () => {
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit']) {
    const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
    h.fire('Stop', { background_tasks: [SHELL('s1')] });
    h.fire(event, {});
    assert.deepStrictEqual(h.live(), [], event);
  }
});

test('a later Stop replaces the wait; SessionEnd drops it', () => {
  const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  assert.strictEqual(h.live().length, 1, 'the first timer was cleared');
  h.fire('SessionEnd', {});
  assert.deepStrictEqual(h.live(), []);
  h.advance(60 * MIN);
  assert.deepStrictEqual(h.sent, []);
});

test('input-needed is untouched by a waiting shell', () => {
  const h = shellHarness({ startedAt: { s1: AGO(MIN) } });
  h.fire('Stop', { background_tasks: [SHELL('s1')] });
  h.fire('Notification', { notification_type: 'permission_prompt', message: 'x' });
  assert.deepStrictEqual(h.kinds(), ['input-needed']);
});

test('the real default timer is cleared by SessionEnd and does not keep the process alive', () => {
  const a = createAttention({ now: () => 1_000_000, shellStartedAt: () => AGO(MIN) });
  a.handle({ event: 'Stop', payload: { background_tasks: [SHELL('s1')] } });
  a.handle({ event: 'SessionEnd', payload: {} });
});

// --- where a shell's start comes from: its own output file's birth time -----------------------------------------
const nodePath = require('path');
const SESS = nodePath.join('C:', 't', 'claude', 'proj', 'sess');
const SCRATCH = nodePath.join(SESS, 'scratchpad');

test('the start is the birth time of <scratchpad_dir>/../tasks/<id>.output', () => {
  const seen = [];
  const f = makeShellStartedAt((p) => { seen.push(p); return { birthtimeMs: 12345 }; });
  assert.strictEqual(f({ id: 'bk3j2' }, { scratchpad_dir: SCRATCH }), 12345);
  assert.deepStrictEqual(seen, [nodePath.join(SESS, 'tasks', 'bk3j2.output')]);
});

test('no scratchpad_dir, no id, an unreadable file or a nonsense time: unknown (null), never a guess', () => {
  const ok = () => ({ birthtimeMs: 5 });
  const boom = () => { throw new Error('ENOENT'); };
  assert.strictEqual(makeShellStartedAt(ok)({ id: 'b1' }, {}), null);
  assert.strictEqual(makeShellStartedAt(ok)({ id: 'b1' }, { scratchpad_dir: 5 }), null);
  assert.strictEqual(makeShellStartedAt(ok)({ id: 'b1' }, { scratchpad_dir: '' }), null);
  assert.strictEqual(makeShellStartedAt(ok)({ id: 'b1' }), null);
  assert.strictEqual(makeShellStartedAt(ok)({}, { scratchpad_dir: SCRATCH }), null);
  assert.strictEqual(makeShellStartedAt(ok)({ id: '' }, { scratchpad_dir: SCRATCH }), null);
  assert.strictEqual(makeShellStartedAt(boom)({ id: 'b1' }, { scratchpad_dir: SCRATCH }), null);
  for (const bad of [0, -1, NaN, Infinity, null, '5', undefined]) {
    assert.strictEqual(makeShellStartedAt(() => ({ birthtimeMs: bad }))({ id: 'b1' }, { scratchpad_dir: SCRATCH }), null, String(bad));
  }
});

test('an id that could climb out of the tasks folder is not looked up', () => {
  let called = false;
  const f = makeShellStartedAt(() => { called = true; return { birthtimeMs: 5 }; });
  for (const id of ['..\\x', '../x', 'a/b', 'a\\b', '..']) assert.strictEqual(f({ id }, { scratchpad_dir: SCRATCH }), null, id);
  assert.strictEqual(called, false);
});

test('the default reads a real file: a file made just now is a young shell', () => {
  const dir = tmpDir('att-shell-');
  fs.mkdirSync(path.join(dir, 'scratchpad')); fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'bq1.output'), 'x');
  const at = makeShellStartedAt()({ id: 'bq1' }, { scratchpad_dir: path.join(dir, 'scratchpad') });
  assert.ok(Math.abs(Date.now() - at) < 60000, 'birth time is now-ish');
});
