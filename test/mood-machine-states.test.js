'use strict';
/**
 * BACKLOG #55: the states a card shows ON TOP of working/stressed -- reading,
 * writing, running, waiting on you, stuck, waiting on a helper. Each is read
 * from a signal the CLI really sends (see host/mood-machine.js, "DETAIL"):
 *
 *   reading / writing   PreToolUse of Read|Grep|Glob / Edit|Write|NotebookEdit. Their PostToolUse isn't hooked
 *                       (host/settings-writer.js OCCUPANCY_MATCHER), so the state lasts a short while, not "until done"
 *   running             a Bash call in flight (PreToolUse .. PostToolUse), not a run_in_background one
 *   waiting on you      a Notification that waits on a person (permission_prompt ...) for that agent
 *   stuck               the same call repeated (the retry detector), or a long silence
 *   waiting on a helper a foreground child it launched is still running
 *
 * `state` is unchanged (sleeping/working/happy/stressed): everything that reads it keeps working. `detail` is the
 * finer name, and equals `state` when nothing finer is true.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createMoodMachine, TOOL_LINGER_MS, STUCK_MS } = require('../host/mood-machine');

function rig(opts = {}) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, ...opts });
  const changes = [];
  m.on('change', c => changes.push(c));
  let n = 0;
  const api = {
    m, changes,
    advance(ms) { t += ms; m.tick(); },
    ev(event, payload) { m.handle({ event, payload }); },
    spawn(type, extra = {}) {
      const key = 'toolu_' + (++n);
      api.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type, ...extra.input }, ...extra.by });
      return { key, type, id: 'a' + type + '-' + String(n).padStart(16, '0') };
    },
    pre(a, tool, input = {}) { api.ev('PreToolUse', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: input, agent_id: a.id, agent_type: a.type }); return 'tu' + n; },
    post(a, tool, id, input = {}) { api.ev('PostToolUse', { tool_name: tool, tool_use_id: id, tool_input: input, tool_response: { success: true }, agent_id: a.id, agent_type: a.type }); },
    notify(type, by) { api.ev('Notification', { notification_type: type, message: 'x', ...(by ? { agent_id: by.id, agent_type: by.type } : {}) }); },
    detail: name => m.detailOf(name),
  };
  return api;
}

// An agent that has spoken once, so the machine knows its id.
function started(r, type = 'miguel') {
  const a = r.spawn(type);
  r.post(a, 'Bash', r.pre(a, 'Bash', { command: 'true' }));
  return a;
}

test('a plain working agent has no finer detail', () => {
  const r = rig();
  started(r);
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
  assert.strictEqual(r.detail('miguel'), 'working');
});

test('a Bash call in flight is running, and ends with its result', () => {
  const r = rig();
  const a = started(r);
  const id = r.pre(a, 'Bash', { command: 'npm test' });
  assert.strictEqual(r.detail('miguel'), 'running');
  assert.strictEqual(r.m.stateOf('miguel'), 'working', 'the base state is untouched');
  r.post(a, 'Bash', id, { command: 'npm test' });
  assert.strictEqual(r.detail('miguel'), 'working');
});

test('a Bash call that failed also stops running', () => {
  const r = rig();
  const a = started(r);
  const id = r.pre(a, 'Bash', { command: 'false' });
  r.ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: id, agent_id: a.id, agent_type: a.type });
  assert.strictEqual(r.detail('miguel'), 'stressed');
});

test('a background Bash returns at once and is not "running"', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Bash', { command: 'sleep 99', run_in_background: true });
  assert.strictEqual(r.detail('miguel'), 'working');
});

test('Read, Grep and Glob read; Edit, Write and NotebookEdit write', () => {
  for (const [tool, want] of [['Read', 'reading'], ['Grep', 'reading'], ['Glob', 'reading'],
    ['Edit', 'writing'], ['Write', 'writing'], ['NotebookEdit', 'writing']]) {
    const r = rig();
    const a = started(r);
    r.pre(a, tool, { file_path: 'C:/x' });
    assert.strictEqual(r.detail('miguel'), want, tool);
  }
});

test('reading lingers a short while (no PostToolUse is hooked), then it is plain working', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Read', { file_path: 'C:/x' });
  r.advance(TOOL_LINGER_MS - 1);
  assert.strictEqual(r.detail('miguel'), 'reading');
  r.advance(2);
  assert.strictEqual(r.detail('miguel'), 'working');
  assert.ok(r.changes.some(c => c.agent === 'miguel' && c.detail === 'working' && c.state === 'working'));
});

test('the newest tool decides: Edit after Read is writing, and a Bash in flight outranks an older Read', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Read', {});
  r.advance(100);
  r.pre(a, 'Edit', {});
  assert.strictEqual(r.detail('miguel'), 'writing');
  r.advance(100);
  const id = r.pre(a, 'Bash', { command: 'x' });
  assert.strictEqual(r.detail('miguel'), 'running');
  r.post(a, 'Bash', id);
  assert.strictEqual(r.detail('miguel'), 'writing', 'the Edit is still recent');
});

test('a main-session tool call (no agent_id) touches no card', () => {
  const r = rig();
  started(r);
  r.ev('PreToolUse', { tool_name: 'Read', tool_input: {} });
  assert.strictEqual(r.detail('miguel'), 'working');
});

test('a tool call from an agent that never started here changes nothing', () => {
  const r = rig();
  r.ev('PreToolUse', { tool_name: 'Read', tool_input: {}, agent_id: 'ghost', agent_type: 'ghost' });
  assert.deepStrictEqual(r.m.roster(), []);
});

test('a permission prompt that names the agent makes it wait on you, beating running', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Bash', { command: 'rm x' });
  r.notify('permission_prompt', a);
  assert.strictEqual(r.detail('miguel'), 'waiting');
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
});

test('every notification type that waits on a person counts; idle_prompt and unknown types do not', () => {
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', undefined]) {
    const r = rig();
    const a = started(r);
    r.notify(type, a);
    assert.strictEqual(r.detail('miguel'), 'waiting', String(type));
  }
  for (const type of ['idle_prompt', 'auth_success', 'something_new']) {
    const r = rig();
    const a = started(r);
    r.notify(type, a);
    assert.strictEqual(r.detail('miguel'), 'working', type);
  }
});

test('the agent working again, or finishing, ends the wait', () => {
  const r = rig();
  const a = started(r);
  r.notify('permission_prompt', a);
  r.pre(a, 'Bash', { command: 'x' });
  assert.strictEqual(r.detail('miguel'), 'running', 'its next call proves the prompt was answered');

  const r2 = rig();
  const b = started(r2);
  r2.notify('permission_prompt', b);
  r2.ev('SubagentStop', { agent_id: b.id, agent_type: b.type });
  assert.strictEqual(r2.detail('miguel'), 'happy');
});

test('a notification that names nobody belongs to the agent whose tool call came last, if that was just now', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Edit', { file_path: 'C:/x' });
  r.advance(500);
  r.notify('permission_prompt');
  assert.strictEqual(r.detail('miguel'), 'waiting');
});

test('...not when the main session called a tool after it, nor when it was long ago', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Edit', { file_path: 'C:/x' });
  r.ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:/y' } });   // the main session's own
  r.notify('permission_prompt');
  assert.notStrictEqual(r.detail('miguel'), 'waiting');

  const r2 = rig();
  const b = started(r2);
  r2.pre(b, 'Edit', {});
  r2.advance(60_000);
  r2.notify('permission_prompt');
  assert.notStrictEqual(r2.detail('miguel'), 'waiting');
});

test('a notification that names nobody never marks a sleeping agent', () => {
  const r = rig();
  r.notify('permission_prompt');
  assert.deepStrictEqual(r.m.roster(), []);
});

test('the same call three times is stuck: state stressed, detail stuck', () => {
  const r = rig();
  const a = started(r);
  for (let i = 0; i < 3; i++) r.post(a, 'Bash', r.pre(a, 'Bash', { command: 'same' }), { command: 'same' });
  assert.strictEqual(r.m.stateOf('miguel'), 'stressed');
  assert.strictEqual(r.detail('miguel'), 'stuck');
  r.post(a, 'Bash', r.pre(a, 'Bash', { command: 'other' }), { command: 'other' });
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
  assert.strictEqual(r.detail('miguel'), 'working');
});

test('an error is stressed, not stuck', () => {
  const r = rig();
  const a = started(r);
  r.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'e', tool_input: { command: 'x' }, tool_response: { exit_code: 1 }, agent_id: a.id, agent_type: a.type });
  assert.strictEqual(r.m.stateOf('miguel'), 'stressed');
  assert.strictEqual(r.detail('miguel'), 'stressed');
});

test('a long silence with nothing in flight is stuck; a Bash in flight is not silence', () => {
  const r = rig();
  const a = started(r);
  r.advance(STUCK_MS - 1000);
  assert.strictEqual(r.detail('miguel'), 'working');
  r.advance(2000);
  assert.strictEqual(r.detail('miguel'), 'stuck');
  r.pre(a, 'Bash', { command: 'x' });
  assert.strictEqual(r.detail('miguel'), 'running', 'it spoke again');

  const r2 = rig();
  const b = started(r2);
  r2.pre(b, 'Bash', { command: 'long job' });
  r2.advance(STUCK_MS + 5000);
  assert.strictEqual(r2.detail('miguel'), 'running');
});

test('a parent waiting on a foreground child waits on a helper; the child is working', () => {
  const r = rig();
  const p = started(r, 'paris');
  r.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'kid', tool_input: { subagent_type: 'dexter' }, agent_id: p.id, agent_type: p.type });
  assert.strictEqual(r.detail('paris'), 'helper');
  assert.strictEqual(r.detail('dexter'), 'working');
  r.ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'kid', tool_input: { subagent_type: 'dexter' },
    tool_response: { status: 'completed', agentId: 'adexter-0000000000000001' }, agent_id: p.id, agent_type: p.type });
  assert.strictEqual(r.detail('paris'), 'working');
});

test('a parent whose child is in the background carries on: not waiting', () => {
  const r = rig();
  const p = started(r, 'paris');
  r.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'kid', tool_input: { subagent_type: 'dexter', run_in_background: true }, agent_id: p.id, agent_type: p.type });
  assert.strictEqual(r.detail('paris'), 'working');
});

test('priority: waiting on you > stuck > waiting on a helper > running > writing > reading', () => {
  const r = rig();
  const p = started(r, 'paris');
  r.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'kid', tool_input: { subagent_type: 'dexter' }, agent_id: p.id, agent_type: p.type });
  r.pre(p, 'Read', {});
  assert.strictEqual(r.detail('paris'), 'helper', 'helper beats reading');
  const bash = r.pre(p, 'Bash', { command: 'x' });
  assert.strictEqual(r.detail('paris'), 'helper', 'helper beats running');
  r.post(p, 'Bash', bash, { command: 'x' });
  for (let i = 0; i < 2; i++) r.post(p, 'Bash', r.pre(p, 'Bash', { command: 'x' }), { command: 'x' });
  assert.strictEqual(r.detail('paris'), 'stuck', 'stuck beats helper');
  r.post(p, 'Bash', r.pre(p, 'Bash', { command: 'y' }), { command: 'y' });
  assert.strictEqual(r.detail('paris'), 'helper', 'a different call ended the retry loop');
  r.notify('permission_prompt', p);
  assert.strictEqual(r.detail('paris'), 'waiting');
});

test('of two recent file tools the newer one decides', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Edit', {});
  r.advance(10);
  r.pre(a, 'Read', {});
  assert.strictEqual(r.detail('miguel'), 'reading', 'the newest tool wins, as the card shows what it does now');
});

test('the change event carries the detail, and fires when only the detail moves', () => {
  const r = rig();
  const a = started(r);
  r.changes.length = 0;
  r.pre(a, 'Read', {});
  assert.deepStrictEqual(r.changes, [{ agent: 'miguel', state: 'working', detail: 'reading' }]);
  r.changes.length = 0;
  r.pre(a, 'Read', {});
  assert.deepStrictEqual(r.changes, [], 'nothing moved, nothing said');
});

test('the roster carries the detail', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Edit', {});
  assert.deepStrictEqual(r.m.roster(), [{ agent: 'miguel', state: 'working', detail: 'writing' }]);
});

test('sleeping, happy and a cut-off card show their state as the detail', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Read', {});
  r.ev('SubagentStop', { agent_id: a.id, agent_type: a.type });
  assert.deepStrictEqual(r.m.roster(), [{ agent: 'miguel', state: 'happy', detail: 'happy' }]);
  r.advance(60_000);
  assert.deepStrictEqual(r.m.roster(), [{ agent: 'miguel', state: 'sleeping', detail: 'sleeping' }]);
});

test('SessionEnd clears a wait and every tool', () => {
  const r = rig();
  const a = started(r);
  r.notify('permission_prompt', a);
  r.ev('SessionEnd', {});
  assert.strictEqual(r.detail('miguel'), 'sleeping');
});

test('detailOf an unknown agent is sleeping', () => {
  assert.strictEqual(rig().detail('nobody'), 'sleeping');
});
