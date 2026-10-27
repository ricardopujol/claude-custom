'use strict';
/**
 * BACKLOG #119 A2: the mod's `$.agent.list()` statuses are a SECOND source for the mood machine's finer states. Hooks keep the
 * identity and the lifecycle (they carry agent_id and the spawn); the mod can only add `waiting` to a run the hooks already opened
 * and bound. Precedence pinned here:
 *   - the mod never opens, binds, ends or sleeps a card, whatever the statuses say;
 *   - `waiting` from the mod shows as the card's `waiting` detail, like a PermissionRequest hook's;
 *   - a snapshot that no longer says waiting (or no longer lists the agent) clears it;
 *   - the agent's own next hooked event clears it too (the prompt was answered), same as the hook's;
 *   - a waiting card is not reaped by silence, as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createMoodMachine, STALL_MS } = require('../host/mood-machine');

function rig() {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t });
  let n = 0;
  const api = {
    m,
    now: () => t,
    advance(ms) { t += ms; m.tick(); },
    ev(event, payload) { m.handle({ event, payload }); },
    spawn(type) {
      const key = 'toolu_' + (++n);
      api.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type } });
      return { key, type, id: 'a' + type + '-' + String(n).padStart(16, '0') };
    },
    pre(a, tool, input = {}) { api.ev('PreToolUse', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: input, agent_id: a.id, agent_type: a.type }); },
    detail: name => m.detailOf(name),
  };
  return api;
}
function started(r, type = 'miguel') { const a = r.spawn(type); r.pre(a, 'Bash', { command: 'true' }); return a; }
const row = (a, status) => ({ id: a.id, status });

test('a waiting status from the mod shows the card as waiting; the base state is unchanged', () => {
  const r = rig();
  const a = started(r);
  r.m.observeAgents([row(a, 'waiting')]);
  assert.strictEqual(r.detail('miguel'), 'waiting');
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
});

test('a snapshot that no longer says waiting clears it; so does one that no longer lists the agent', () => {
  const r = rig();
  const a = started(r);
  r.m.observeAgents([row(a, 'waiting')]);
  r.m.observeAgents([row(a, 'running')]);
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
  r.m.observeAgents([row(a, 'waiting')]);
  r.m.observeAgents([]);
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
});

test('the agent\'s own next hooked event clears it: the prompt was answered', () => {
  const r = rig();
  const a = started(r);
  r.m.observeAgents([row(a, 'waiting')]);
  r.pre(a, 'Read', { file_path: 'x' });
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
});

test('a waiting agent is not reaped by silence past the stall clock while the mod keeps saying so', () => {
  const r = rig();
  const a = started(r);
  r.m.observeAgents([row(a, 'waiting')]);
  for (let i = 0; i < 2; i++) {
    r.advance(STALL_MS * 0.6);
    r.m.observeAgents([row(a, 'waiting')]);          // a fresh snapshot inside every stall window
  }
  assert.strictEqual(r.detail('miguel'), 'waiting');
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
});

test('PR #197 Miguel G2: a waiting the mod stops repeating lapses after the stall window, and the stall clock applies again', () => {
  const r = rig();
  const a = started(r);
  r.m.observeAgents([row(a, 'waiting')]);
  r.advance(STALL_MS - 1000);
  assert.strictEqual(r.detail('miguel'), 'waiting', 'still inside the window');
  r.advance(2000);
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
  assert.strictEqual(r.m.invocations().length, 0, 'silent for the whole stall window, so it is reaped like any silent run');
});

test('PR #197 Dexter 8: a snapshot taken before the hook that cleared the prompt never re-raises waiting', () => {
  const r = rig();
  const a = started(r);
  r.ev('PermissionRequest', { tool_name: 'Edit', tool_input: {}, agent_id: a.id, agent_type: a.type });
  assert.strictEqual(r.detail('miguel'), 'waiting');
  const snapshotAt = r.now();                           // the mod takes its snapshot: a1 waiting
  r.advance(10);
  r.pre(a, 'Read', { file_path: 'x' });                 // the hook bridge delivers the answered prompt first
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
  r.m.observeAgents([row(a, 'waiting')], snapshotAt);   // ...and then the older HTTP snapshot lands
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
});

test('PR #197 Dexter 8: a snapshot taken after the clearing hook still raises waiting; one with no time is taken as current', () => {
  const r = rig();
  const a = started(r);
  r.advance(10);
  r.pre(a, 'Read', { file_path: 'x' });
  r.advance(10);
  r.m.observeAgents([row(a, 'waiting')], r.now());
  assert.strictEqual(r.detail('miguel'), 'waiting');
  r.m.observeAgents([row(a, 'running')]);
  r.m.observeAgents([row(a, 'waiting')]);
  assert.strictEqual(r.detail('miguel'), 'waiting');
});

test('an id the hooks never opened is ignored: the mod opens no card, binds no run', () => {
  const r = rig();
  r.m.observeAgents([{ id: 'ghost-1', status: 'waiting' }, { id: 'ghost-2', status: 'running' }]);
  assert.deepStrictEqual(r.m.roster(), []);
  assert.deepStrictEqual(r.m.invocations(), []);
});

test('a spawned run that has not spoken yet (no agent_id bound) is not matched by the mod either', () => {
  const r = rig();
  r.spawn('miguel');
  r.m.observeAgents([{ id: 'whatever', status: 'waiting' }]);
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
  assert.deepStrictEqual(r.m.invocations().map(i => i.agentId), [null]);
});

test('completed, failed, killed and idle statuses end and sleep nothing: the lifecycle is the hooks\'', () => {
  for (const status of ['completed', 'failed', 'killed', 'idle', 'pending', 'running', 'something-new']) {
    const r = rig();
    const a = started(r);
    r.m.observeAgents([row(a, status)]);
    assert.strictEqual(r.m.stateOf('miguel'), 'working', status);
    assert.strictEqual(r.m.invocations().length, 1, status);
  }
});

test('only the named agent waits: a sibling of the same type keeps its detail', () => {
  const r = rig();
  const a = started(r, 'miguel');
  const b = started(r, 'dexter');
  r.m.observeAgents([row(a, 'waiting'), row(b, 'running')]);
  assert.strictEqual(r.detail('miguel'), 'waiting');
  assert.notStrictEqual(r.detail('dexter'), 'waiting');
});

test('the mod\'s waiting is announced as a change, once', () => {
  const r = rig();
  const a = started(r);
  const seen = [];
  r.m.on('change', c => seen.push(c));
  r.m.observeAgents([row(a, 'waiting')]);
  r.m.observeAgents([row(a, 'waiting')]);
  assert.deepStrictEqual(seen, [{ agent: 'miguel', state: 'working', detail: 'waiting' }]);
});

test('a garbage list does nothing and never throws', () => {
  const r = rig();
  const a = started(r);
  for (const bad of [undefined, null, 'x', 5, {}, [null], [{}], [{ id: 5, status: 'waiting' }], [{ id: a.id }], [{ id: a.id, status: 5 }]]) {
    assert.doesNotThrow(() => r.m.observeAgents(bad));
  }
  assert.notStrictEqual(r.detail('miguel'), 'waiting');
});

test('a hook-raised waiting and the mod\'s agree: both can hold, either alone shows it', () => {
  const r = rig();
  const a = started(r);
  r.ev('PermissionRequest', { tool_name: 'Edit', tool_input: {}, agent_id: a.id, agent_type: a.type });
  assert.strictEqual(r.detail('miguel'), 'waiting');
  r.m.observeAgents([row(a, 'waiting')]);
  assert.strictEqual(r.detail('miguel'), 'waiting');
  r.m.observeAgents([row(a, 'running')]);
  assert.strictEqual(r.detail('miguel'), 'waiting', 'the hook\'s own prompt still stands until the agent moves on');
});
