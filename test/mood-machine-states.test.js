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
    // The CLI's real Notification: it NEVER carries agent_id (2.1.296: the one builder calls $d(session, mode) with no tool context).
    notify(type, message = 'Claude needs your permission to use Edit') { api.ev('Notification', { notification_type: type, message, title: undefined }); },
    // The CLI's real PermissionRequest hook input: the base fields, agent_id/agent_type when it fires inside a subagent, and the
    // tool (bundle 2.1.296: eK = base + tool_name, tool_input, permission_suggestions?, mcp_server?; built with $d(session, mode, ..., toolUseContext)).
    permission(by, tool = 'Edit', input = { file_path: 'C:/x' }) {
      api.ev('PermissionRequest', { session_id: 's', transcript_path: 't', cwd: 'c', permission_mode: 'default', hook_event_name: 'PermissionRequest',
        tool_name: tool, tool_input: input, permission_suggestions: [], ...(by ? { agent_id: by.id, agent_type: by.type } : {}) });
    },
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
  assert.strictEqual(r.detail('miguel'), 'working', 'the Bash was a newer call than the Edit, so the Edit is over (calls are sequential)');
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
  r.permission(a);
  assert.strictEqual(r.detail('miguel'), 'waiting');
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
});

test('a PermissionRequest from a subagent marks that agent, whatever the tool', () => {
  for (const tool of ['Edit', 'Write', 'Bash', 'WebFetch', 'mcp__x__y', 'AskUserQuestion']) {
    const r = rig();
    const a = started(r);
    r.permission(a, tool);
    assert.strictEqual(r.detail('miguel'), 'waiting', tool);
  }
});

test('a PermissionRequest with no agent_id belongs to the main session: no subagent card waits', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Edit', {});
  r.permission(null, 'Edit');
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
  const r2 = rig();
  r2.permission(null, 'Bash');
  assert.deepStrictEqual(r2.m.roster(), []);
});

test('a PermissionRequest from an agent this host never saw start marks nothing', () => {
  const r = rig();
  r.permission({ id: 'ghost', type: 'ghost' });
  assert.deepStrictEqual(r.m.roster(), []);
});

test('the real Notification shape (no agent_id) marks no card, of any type', () => {
  for (const type of ['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'idle_prompt', 'worker_permission_prompt', undefined]) {
    const r = rig();
    const a = started(r);
    r.pre(a, 'Edit', {});
    r.notify(type);
    assert.notStrictEqual(r.detail('miguel'), 'waiting', String(type));
  }
});

test('a waiting card is never judged by silence, nor reaped by the stall clock while it waits', () => {
  const r = rig({ stallMs: 30 * 60_000 });
  const a = started(r);
  r.permission(a);
  r.advance(STUCK_MS + 5 * 60_000);
  assert.strictEqual(r.detail('miguel'), 'waiting', 'not stuck');
  r.advance(15 * 60_000);
  assert.strictEqual(r.detail('miguel'), 'waiting', 'still there past the stall clock: the person has not answered');
  r.pre(a, 'Read', {});
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
});

test('the agent working again, or finishing, ends the wait', () => {
  const r = rig();
  const a = started(r);
  r.permission(a);
  r.pre(a, 'Bash', { command: 'x' });
  assert.strictEqual(r.detail('miguel'), 'running', 'its next call proves the prompt was answered');

  const r2 = rig();
  const b = started(r2);
  r2.permission(b);
  r2.ev('SubagentStop', { agent_id: b.id, agent_type: b.type });
  assert.strictEqual(r2.detail('miguel'), 'happy');
});

// PR #154 Dexter 1: an unnamed prompt is the MAIN session's (the CLI puts agent_id on a subagent's own hooks, and the machine already
// reads a call without one as the main session's: saysWho). It marks no card, however recently some subagent called a tool.
test('a notification that names nobody marks no agent, even right after that agent\'s tool call', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Edit', { file_path: 'C:/x' });
  r.advance(400);
  r.notify('permission_prompt');
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
});

test('...nor after a main-session call, nor with two agents active (Dexter 1 sequences)', () => {
  const r = rig();
  const b = started(r, 'builder');
  r.pre(b, 'Read', {});
  r.ev('PreToolUse', { tool_name: 'Bash', tool_input: {} });          // the main session's own call
  r.advance(200);
  r.notify('permission_prompt');
  assert.notStrictEqual(r.detail('builder'), 'waiting');

  const r2 = rig();
  const x = started(r2, 'agenta');
  const y = started(r2, 'agentb');
  r2.pre(x, 'Bash', { command: 'needs permission' });
  r2.advance(100);
  r2.pre(y, 'Read', {});
  r2.advance(200);
  r2.notify('permission_prompt');
  assert.notStrictEqual(r2.detail('agentb'), 'waiting');
  assert.notStrictEqual(r2.detail('agenta'), 'waiting');
});

test('a notification that names nobody never marks a sleeping agent', () => {
  const r = rig();
  r.notify('permission_prompt');
  assert.deepStrictEqual(r.m.roster(), []);
});

test('a named prompt is open until that agent\'s next hooked event, not the approved call\'s result time (pinned: no signal says it was answered)', () => {
  const r = rig();
  const a = started(r);
  const id = r.pre(a, 'Bash', { command: 'npm test' });
  r.permission(a);
  r.advance(60_000);
  assert.strictEqual(r.detail('miguel'), 'waiting', 'silence is not an answer');
  r.post(a, 'Bash', 'some-other-call');
  assert.notStrictEqual(r.detail('miguel'), 'waiting', 'any hooked event of the agent ends it');
  void id;
});

test('another agent\'s events do not end this agent\'s wait', () => {
  const r = rig();
  const a = started(r, 'agenta');
  const b = started(r, 'agentb');
  r.permission(a);
  r.pre(b, 'Read', {});
  r.post(b, 'Bash', r.pre(b, 'Bash', {}));
  assert.strictEqual(r.detail('agenta'), 'waiting');
});

// PR #154 Dexter 2 / Miguel I1: a Bash PreToolUse that never gets its result (denied, blocked by a hook, lost) is not "in flight".
test('a Bash that was denied (no result ever) stops running at the agent\'s next call', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Bash', { command: 'rm -rf build' });
  assert.strictEqual(r.detail('miguel'), 'running');
  r.advance(10_000);
  r.pre(a, 'Read', {});
  r.advance(TOOL_LINGER_MS + 1);
  assert.strictEqual(r.detail('miguel'), 'working', 'not running for the rest of the run');
});

test('a newer Bash replaces an older one that never ended', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Bash', { command: 'denied' });
  const second = r.pre(a, 'Bash', { command: 'ok' });
  r.post(a, 'Bash', second);
  assert.strictEqual(r.detail('miguel'), 'working', 'the first one is not still in flight');
});

test('an in-flight Bash older than the stall clock no longer counts (a ceiling, as for any silent run)', () => {
  const r = rig({ stallMs: 100_000, maxInvocationMs: 10 ** 9 });
  const a = started(r);
  r.pre(a, 'Bash', { command: 'x' });
  for (let i = 0; i < 4; i++) { r.advance(40_000); r.post(a, 'Bash', 'unrelated-' + i, { command: 'u' + i }); }   // the run is alive, that one call is not
  assert.strictEqual(r.detail('miguel'), 'working');
});

// PR #154 Dexter 4: hooks see no WebSearch, WebFetch, MCP or TaskOutput, so silence can't tell stuck from a long unhooked call.
test('an agent that launched background work is never stuck by silence', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Bash', { command: 'npm test', run_in_background: true });
  r.advance(STUCK_MS + 5000);
  assert.strictEqual(r.detail('miguel'), 'bgwait', 'it is waiting on TaskOutput, which no hook sees: waiting, never stuck (BACKLOG #155)');

  const r2 = rig();
  const p = started(r2, 'paris');
  r2.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'bg', tool_input: { subagent_type: 'dexter', run_in_background: true }, agent_id: p.id, agent_type: p.type });
  r2.advance(STUCK_MS + 5000);
  assert.notStrictEqual(r2.detail('paris'), 'stuck');
});

test('silence-stuck waits longer than ten minutes: a long unhooked call is not stuck at ten', () => {
  assert.ok(STUCK_MS >= 20 * 60_000);
});

// PR #154 Miguel I2: cards are per NAME and a retry loop is counted per name, so two runs of one agent share it.
test('two runs of one agent: a retry loop in one is the card\'s, and the other\'s different call ends it', () => {
  const r = rig();
  const a1 = r.spawn('miguel');
  const a2 = r.spawn('miguel');
  r.post(a1, 'Bash', r.pre(a1, 'Bash', { command: 'x' }), { command: 'x' });
  r.post(a2, 'Bash', r.pre(a2, 'Bash', { command: 'y' }), { command: 'y' });
  for (let i = 0; i < 3; i++) r.post(a2, 'Bash', r.pre(a2, 'Bash', { command: 'loop' }), { command: 'loop' });
  assert.strictEqual(r.detail('miguel'), 'stuck', 'the card is stuck, whichever run retried');
  r.post(a1, 'Bash', r.pre(a1, 'Bash', { command: 'z' }), { command: 'z' });
  assert.strictEqual(r.detail('miguel'), 'working', 'the sibling\'s different call resets the name\'s loop');
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
  r.permission(p);
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
  r.permission(a);
  r.ev('SessionEnd', {});
  assert.strictEqual(r.detail('miguel'), 'sleeping');
});

test('detailOf an unknown agent is sleeping', () => {
  assert.strictEqual(rig().detail('nobody'), 'sleeping');
});

// PR #154 round 2, N2: a call whose only hook is its PostToolUse (SendMessage, Artifact) is also a newer call of the run.
test('a denied Bash followed only by Post-only calls stops running', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Bash', { command: 'denied' });
  r.ev('PostToolUse', { tool_name: 'SendMessage', tool_use_id: 'sm1', tool_input: { to: 'x' }, tool_response: { success: true }, agent_id: a.id, agent_type: a.type });
  r.advance(TOOL_LINGER_MS + 1);
  assert.strictEqual(r.detail('miguel'), 'working');
});

test('...and a Post-only call ends a file tool moment too', () => {
  const r = rig();
  const a = started(r);
  r.pre(a, 'Read', {});
  r.ev('PostToolUse', { tool_name: 'Artifact', tool_use_id: 'ar1', tool_input: {}, tool_response: { ok: true }, agent_id: a.id, agent_type: a.type });
  assert.strictEqual(r.detail('miguel'), 'working');
});
