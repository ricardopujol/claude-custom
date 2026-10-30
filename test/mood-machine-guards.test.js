'use strict';
/**
 * The mood machine's malformed-payload guards and bounded-memory edges (backlog #60, Mortimer's release-#101
 * part 2: 178 single-guard survivors in 914 mutants). The existing suites are strong on the happy and the
 * known-regression paths; this file holds what was left: one fixture per accepted spelling of a spawn result
 * with a near miss each, how a teammate is identified, the guards on SendMessage, Stop's `background_tasks`,
 * the adopt/swap rules, which clocks a call refreshes, and the REMEMBER_MAX bound at its exact edge.
 *
 * Everything is driven through handle / tick / stateOf / stack / invocations / bookkeeping, never a private.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createMoodMachine, REMEMBER_MAX, WORKING, SLEEPING, HAPPY, STRESSED } = require('../host/mood-machine');

const MIN = 60_000;

function rig(opts = {}) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, ...opts });
  let n = 0;
  const api = {
    m,
    advance(ms) { t += ms; return api; },
    tick(ms = 0) { t += ms; m.tick(); return api; },
    send(event, payload) { m.handle({ event, payload }); return api; },
    // A spawn (PreToolUse Agent). `by` is the spawner's own agent_id (absent: the main session).
    spawn(type, { key = `k${++n}`, by, agentType, input = {} } = {}) {
      const payload = { tool_name: 'Agent', tool_input: { subagent_type: type, ...input } };
      if (key !== null) payload.tool_use_id = key;
      if (by) { payload.agent_id = by; payload.agent_type = agentType || 'x'; }
      m.handle({ event: 'PreToolUse', payload });
      return key;
    },
    // The spawn's own result (PostToolUse / PostToolUseFailure of the Agent tool), by tool_use_id.
    result(key, response, { event = 'PostToolUse', by, agentType, tool = 'Agent', input = {} } = {}) {
      const payload = { tool_name: tool, tool_input: input, tool_response: response };
      if (key !== null) payload.tool_use_id = key;
      if (by) { payload.agent_id = by; payload.agent_type = agentType || 'x'; }
      m.handle({ event, payload });
      return api;
    },
    // A call by a subagent (carries its agent_id and type), or by the main session when `id` is undefined.
    call(id, type, { tool = 'Bash', input = { c: Math.random() }, response = { exit_code: 0 }, event = 'PostToolUse' } = {}) {
      const payload = { tool_name: tool, tool_input: input, tool_response: response };
      if (id !== undefined) { payload.agent_id = id; payload.agent_type = type; }
      m.handle({ event, payload });
      return api;
    },
    stop(id, type) {
      const payload = {};
      if (id !== undefined) payload.agent_id = id;
      if (type !== undefined) payload.agent_type = type;
      m.handle({ event: 'SubagentStop', payload });
      return api;
    },
    mainStop(tasks) { m.handle({ event: 'Stop', payload: tasks === undefined ? {} : { background_tasks: tasks } }); return api; },
    send_(to, response, key) {
      const payload = { tool_name: 'SendMessage', tool_input: { to, message: 'm' }, tool_response: response };
      if (key !== undefined) payload.tool_use_id = key;
      m.handle({ event: 'PostToolUse', payload });
      return api;
    },
    ids() { return m.invocations().map((i) => [i.name, i.agentId]); },
    bg() { return m.invocations().map((i) => i.background); },
  };
  return api;
}

// ---- a spawn result: how the run was launched ----

test('a result that says isAsync: true, or status async_launched, makes the run background, even with no agentId', () => {
  for (const response of [{ isAsync: true }, { status: 'async_launched' }, { isAsync: true, status: 'async_launched' }, { isAsync: false, status: 'async_launched' }, { isAsync: true, status: 'x' }]) {
    const r = rig();
    const k = r.spawn('t');
    r.result(k, response);
    assert.deepStrictEqual(r.bg(), [true], JSON.stringify(response));
  }
});

test('near misses of an async launch leave the run foreground', () => {
  for (const response of [{ isAsync: 'true' }, { isAsync: 1 }, { isAsync: false }, { status: 'async' }, { status: 'ASYNC_LAUNCHED' }, { isAsync: false, status: 'running' },
    {}, null, undefined, 'async_launched', 5, []]) {
    const r = rig();
    const k = r.spawn('t');
    r.result(k, response);
    assert.deepStrictEqual(r.bg(), [false], JSON.stringify(response));
    assert.deepStrictEqual(r.m.stack(), ['t']);
  }
});

test('a completed result ends the run, with or without an agentId; near misses of "completed" do not', () => {
  for (const response of [{ status: 'completed' }, { status: 'completed', agentId: 'a1' }]) {
    const r = rig();
    const k = r.spawn('t');
    r.result(k, response);
    assert.deepStrictEqual(r.m.stack(), [], JSON.stringify(response));
    assert.strictEqual(r.m.stateOf('t'), HAPPY);
  }
  for (const response of [{ status: 'complete' }, { status: 'COMPLETED' }, { status: ['completed'] }, 'completed', { done: true }]) {
    const r = rig();
    const k = r.spawn('t');
    r.result(k, response);
    assert.deepStrictEqual(r.m.stack(), ['t'], JSON.stringify(response));
  }
});

test('a result with no body at all leaves the run open and foreground, and says nothing about who is who', () => {
  const r = rig();
  const k = r.spawn('t');
  assert.doesNotThrow(() => r.result(k, undefined));
  assert.deepStrictEqual(r.bg(), [false]);
  assert.deepStrictEqual(r.m.stack(), ['t']);
  // saysWho stayed false: a main-session call with no agent_id is still pinned on the foreground run, so three
  // identical ones read as a retry loop on it
  for (let i = 0; i < 3; i++) r.call(undefined, undefined, { input: { same: 1 } });
  assert.strictEqual(r.m.stateOf('t'), STRESSED);
});

test('an unknown status naming a run by agentId or agent_id is taken as RUNNING in the background; naming nobody it is not', () => {
  const logs = [];
  const real = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const named = (response) => { const r = rig(); const k = r.spawn('t'); r.result(k, response); return r.bg()[0]; };
    assert.strictEqual(named({ status: 'weird', agentId: 'a1' }), true);
    assert.strictEqual(named({ status: 'weird', agent_id: 'a1' }), true);
    assert.strictEqual(named({ status: 'weird', agentId: '', agent_id: 'a1' }), true, 'an empty agentId is skipped for agent_id');
    assert.strictEqual(named({ status: 'weird', agentId: 7, agent_id: 'a1' }), true, 'a non-string agentId is skipped for agent_id');
    assert.strictEqual(named({ status: 'weird' }), false);
    assert.strictEqual(named({ status: 'weird', agentId: '' }), false);
    assert.strictEqual(named({ status: 'weird', agentId: 7, agent_id: 7 }), false);
    assert.strictEqual(named({ status: 'weird', agent_id: '' }), false);
    assert.strictEqual(named('weird'), false);
    assert.strictEqual(named(null), false);
  } finally {
    console.log = real;
  }
  assert.strictEqual(logs.length, 4, 'one log line per renamed status that named a run');
  assert.ok(logs.every((l) => /unrecognised spawn status/.test(l)));
});

test('a result that names a run by a non-string agentId is not adopted', () => {
  const r = rig();
  const k = r.spawn('t');
  r.result(k, { status: 'async_launched', agentId: 5 });
  assert.deepStrictEqual(r.ids(), [['t', null]]);
});

// ---- the result of a spawn that closed already (lateResult) ----

// A crosswise binding: a's SubagentStop arrives first and closes the OLDER record (kA); then b speaks late, bound to
// the other record (kB). The result for kA names b's id, so b's holder finishes.
function crosswise() {
  const r = rig();
  const kA = r.spawn('t');
  const kB = r.spawn('t');
  r.stop('idA', 't');                      // binds the oldest unbound (record kA) and ends it
  r.call('idB', 't');                      // binds the other record
  assert.deepStrictEqual(r.ids(), [['t', 'idB']]);
  return { r, kA, kB };
}

test('a completed result for a closed record finishes the run that holds the id it names', () => {
  const { r, kA } = crosswise();
  r.result(kA, { status: 'completed', agentId: 'idB' });
  assert.deepStrictEqual(r.m.stack(), []);
});

test('a late result finishes nobody unless it is a PostToolUse, completed, and names a held id', () => {
  const cases = [
    ['a failure event', { status: 'completed', agentId: 'idB' }, { event: 'PostToolUseFailure' }],
    ['a running status', { status: 'running', agentId: 'idB' }, {}],
    ['no id named', { status: 'completed' }, {}],
    ['an id nobody holds', { status: 'completed', agentId: 'idZ' }, {}],
    ['no body', undefined, {}],
  ];
  for (const [label, response, opts] of cases) {
    const { r, kA } = crosswise();
    r.result(kA, response, opts);
    assert.deepStrictEqual(r.m.stack(), ['t'], label);
  }
});

test('a result that names an id already ended is not about this run: it is ignored and the run goes on', () => {
  const r = rig();
  r.spawn('t');
  const kB = r.spawn('t');
  r.stop('X', 't');                         // ends the first record, remembers X
  r.result(kB, { status: 'completed', agentId: 'X' });
  assert.deepStrictEqual(r.m.stack(), ['t']);
});

test('a result naming a new id while the run holds a different live id swaps with an unbound sibling of its type, and only of its type', () => {
  const r = rig();
  const kA = r.spawn('t');
  r.spawn('t');
  r.call('wrong', 't');                     // binds the oldest: A
  r.result(kA, { status: 'async_launched', agentId: 'right' });
  assert.deepStrictEqual(r.ids(), [['t', 'right'], ['t', 'wrong']]);
});

test('the swap partner is the first UNBOUND sibling: a bound one in between is skipped', () => {
  const r = rig();
  const kA = r.spawn('t');
  r.spawn('t');                             // C
  r.spawn('t');                             // B
  r.call('w1', 't');                        // A
  r.call('w2', 't');                        // C
  r.result(kA, { status: 'async_launched', agentId: 'right' });
  assert.deepStrictEqual(r.ids(), [['t', 'right'], ['t', 'w2'], ['t', 'w1']]);
});

test('a sibling of ANOTHER type is not a swap partner; with none the result is refused, and the run goes on', () => {
  const r = rig();
  const kA = r.spawn('t');
  r.spawn('other');
  r.call('w', 't');
  r.result(kA, { status: 'completed', agentId: 'right' });
  assert.deepStrictEqual(r.ids(), [['t', 'w'], ['other', null]], 'untouched');
  assert.deepStrictEqual(r.m.stack(), ['t', 'other']);
});

test('a swap moves the children along with the ids', () => {
  const r = rig();
  const kA = r.spawn('t');
  r.spawn('t');
  r.call('wrong', 't');                                       // A holds `wrong`
  r.spawn('child', { by: 'wrong', agentType: 't' });          // a child spawned by that RUN
  const before = r.m.invocations();
  assert.strictEqual(before[2].parentId, before[0].id);
  r.result(kA, { status: 'async_launched', agentId: 'right' });
  const after = r.m.invocations();
  assert.strictEqual(after[2].parentId, after[1].id, 'the child follows the id `wrong` to its new record');
});

// ---- teammates ----

const tm = (r, response, { type = 'worker', input = {} } = {}) => {
  const k = r.spawn(type, { input });
  r.result(k, response, { input });
  return k;
};

test('a teammate result is recognised by status or by an agent_id with an "@": background, and found by its name', () => {
  const probe = (response) => {
    const r = rig();
    tm(r, response, { input: { name: 'bob' } });
    r.call('zzz', 'bob');
    return [r.bg()[0], r.ids()[0][1]];
  };
  for (const response of [{ status: 'teammate_spawned' }, { agent_id: 'bob@team' }, { status: 'teammate_spawned', agent_id: 'bob@team' }]) {
    assert.deepStrictEqual(probe(response), [true, 'zzz'], JSON.stringify(response));
  }
  // not a teammate: an agent_id with no "@", a non-string one, a status that only resembles it. Naming a run
  // still makes it background (an unknown status), but nothing is registered under a name to bind by.
  assert.deepStrictEqual(probe({ agent_id: 'bob' }), [true, null]);
  assert.deepStrictEqual(probe({ agent_id: 5 }), [false, null]);
  assert.deepStrictEqual(probe({ status: 'teammate_spawned2' }), [false, null]);
  assert.deepStrictEqual(probe({ agent_id: '' }), [false, null]);
  assert.deepStrictEqual(probe({ status: 'async', agent_id: 'x' }), [true, null]);
});

test('a teammate is found by the name its result gives: r.name first, then tool_input.name, then the address\' name', () => {
  const find = (response, input) => {
    const r = rig();
    tm(r, response, { input });
    r.call('zzz', 'alice');                                   // an unknown id whose agent_type is the name
    return r.ids()[0][1];
  };
  assert.strictEqual(find({ status: 'teammate_spawned', name: 'alice', agent_id: 'bob@t' }, { name: 'carol' }), 'zzz', 'r.name wins');
  assert.strictEqual(find({ status: 'teammate_spawned', name: 7, agent_id: 'bob@t' }, { name: 'alice' }), 'zzz', 'a non-string r.name falls to tool_input.name');
  assert.strictEqual(find({ status: 'teammate_spawned', name: '', agent_id: 'bob@t' }, { name: 'alice' }), 'zzz', 'an empty r.name too');
  assert.strictEqual(find({ status: 'teammate_spawned' }, { name: 'alice' }), 'zzz', 'tool_input.name with no address');
  assert.strictEqual(find({ agent_id: 'alice@team' }, {}), 'zzz', 'the address\' name');
  assert.strictEqual(find({ status: 'teammate_spawned', name: 'alice' }, { name: 'carol' }), 'zzz');
  assert.strictEqual(find({ status: 'teammate_spawned', name: 'bob', agent_id: 'alice@t' }, {}), null, 'r.name is bob, so alice is nobody');
  assert.strictEqual(find({ status: 'teammate_spawned' }, {}), null, 'no name anywhere: no teammate record to bind');
});

test('a teammate result with no name still makes the run background', () => {
  const r = rig();
  tm(r, { status: 'teammate_spawned' });
  assert.deepStrictEqual(r.bg(), [true]);
});

test('a teammate binds by its address, its runtime id (a + name + - + 8 or more hex), or its name or address as agent_type', () => {
  const bound = (agentId, agentType) => {
    const r = rig();
    tm(r, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@team' });
    r.call(agentId, agentType);
    return r.ids()[0][1];
  };
  assert.strictEqual(bound('bob@team', 'q'), 'bob@team', 'by address');
  assert.strictEqual(bound('abob-0123456789abcdef', 'q'), 'abob-0123456789abcdef', 'by runtime id');
  assert.strictEqual(bound('abob-01234567', 'q'), 'abob-01234567', 'eight hex is enough');
  assert.strictEqual(bound('anything', 'bob'), 'anything', 'by name as agent_type');
  assert.strictEqual(bound('anything', 'bob@team'), 'anything', 'by address as agent_type');
  assert.strictEqual(bound('abob-0123456', 'q'), null, 'seven hex is not');
  assert.strictEqual(bound('abob-0123456789abcdeg', 'q'), null, 'non-hex');
  assert.strictEqual(bound('bbob-0123456789abcdef', 'q'), null, 'must start with a');
  assert.strictEqual(bound('xabob-0123456789abcdef', 'q'), null, 'anchored at the start');
  assert.strictEqual(bound('abob-0123456789abcdef!', 'q'), null, 'anchored at the end');
  assert.strictEqual(bound('anything', 'rob'), null, 'another name');
  assert.strictEqual(bound('anything', undefined), null, 'no agent_type');
});

test('a teammate\'s name is matched literally in its runtime id: a dot is a dot', () => {
  const bound = (agentId) => {
    const r = rig();
    tm(r, { status: 'teammate_spawned', name: 'a.b', agent_id: 'a.b@team' });
    r.call(agentId, 'q');
    return r.ids()[0][1];
  };
  assert.strictEqual(bound('aa.b-0123456789abcdef'), 'aa.b-0123456789abcdef');
  assert.strictEqual(bound('aaxb-0123456789abcdef'), null);
  assert.strictEqual(bound('aab-0123456789abcdef'), null);
});

test('respawning a teammate under its name keeps the address it already had when the new result gives none', () => {
  const r = rig();
  tm(r, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@team' });
  r.stop('abob-0123456789abcdef', 'bob');
  tm(r, { status: 'teammate_spawned', name: 'bob' });
  r.call('bob@team', 'q');
  assert.strictEqual(r.ids()[0][1], 'bob@team');
  // and a new address replaces the old one
  const r2 = rig();
  tm(r2, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@old' });
  r2.stop('abob-0123456789abcdef', 'bob');
  tm(r2, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@new' });
  r2.call('bob@new', 'q');
  assert.strictEqual(r2.ids()[0][1], 'bob@new');
});

test('a plain subagent of the same type does not take a teammate record by first come', () => {
  const r = rig();
  tm(r, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@team' }, { type: 'worker' });
  r.call('someone', 'worker');
  assert.deepStrictEqual(r.ids(), [['worker', null]]);
});

// ---- waking a teammate ----

function endedMate(r, name, type = 'worker') {
  tm(r, { status: 'teammate_spawned', name, agent_id: `${name}@team` }, { type });
  r.call(`a${name}-0123456789abcdef`, name);
  r.stop(`a${name}-0123456789abcdef`, name);
}

test('a message to an ended teammate wakes it, and its next call reopens it; to another name it does not', () => {
  const r = rig();
  endedMate(r, 'bob');
  r.call('abob-0123456789abcdef', 'bob');
  assert.deepStrictEqual(r.m.stack(), [], 'without a wake it is an echo');
  r.send_('bob', { success: true });
  r.call('abob-0123456789abcdef', 'bob');
  assert.deepStrictEqual(r.m.stack(), ['worker']);
  assert.strictEqual(r.m.stateOf('worker'), WORKING);
});

test('a message is addressed by name or by address; a stranger\'s or a non-string address wakes nobody', () => {
  for (const [to, woken] of [['bob', true], ['bob@team', true], ['rob', false], ['rob@team', false], [5, false], [{ x: 1 }, false], [undefined, false], ['', false]]) {
    const r = rig();
    endedMate(r, 'bob');
    assert.doesNotThrow(() => r.send_(to, { success: true }), String(to));
    r.call('abob-0123456789abcdef', 'bob');
    assert.deepStrictEqual(r.m.stack(), woken ? ['worker'] : [], String(to));
  }
});

test('a message that did not succeed wakes nobody', () => {
  for (const response of [{ success: false }, {}, { success: 'true' }, { success: 1 }, 'ok', null, undefined, 5]) {
    const r = rig();
    endedMate(r, 'bob');
    r.send_('bob', response);
    r.call('abob-0123456789abcdef', 'bob');
    assert.deepStrictEqual(r.m.stack(), [], JSON.stringify(response));
  }
});

test('only a PostToolUse of SendMessage counts: other tools and other events do not wake anyone', () => {
  const r = rig();
  endedMate(r, 'bob');
  r.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { to: 'bob' }, tool_response: { success: true } } });
  r.m.handle({ event: 'PreToolUse', payload: { tool_name: 'SendMessage', tool_input: { to: 'bob' }, tool_response: { success: true } } });
  r.m.handle({ event: 'PostToolUseFailure', payload: { tool_name: 'SendMessage', tool_input: { to: 'bob' }, tool_response: { success: true } } });
  r.call('abob-0123456789abcdef', 'bob');
  assert.deepStrictEqual(r.m.stack(), []);
});

test('a woken teammate is the one the event matches, not just the first ended one (each reopens under its own card)', () => {
  const r = rig();
  endedMate(r, 'ann', 'cardA');
  endedMate(r, 'bob', 'cardB');
  r.send_('ann', { success: true });
  r.send_('bob', { success: true });
  r.call('abob-0123456789abcdef', 'bob');
  assert.deepStrictEqual(r.m.stack(), ['cardB'], "bob's call woke bob, not ann");
  assert.deepStrictEqual(r.ids(), [['cardB', 'abob-0123456789abcdef']]);
  r.call('aann-0123456789abcdef', 'ann');
  assert.deepStrictEqual(r.m.stack(), ['cardB', 'cardA'], 'the other was still waiting to be woken');
});

test('a woken teammate is also matched by the runtime id it was bound to, whatever agent_type its call carries', () => {
  const r = rig();
  tm(r, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@team' });
  r.call('odd-runtime-id', 'bob');                    // bound by its name as agent_type
  r.stop('odd-runtime-id', 'bob');
  r.send_('bob', { success: true });
  r.call('odd-runtime-id', 'something-else');         // not its name, not its address, not shaped like a runtime id
  assert.deepStrictEqual(r.m.stack(), ['worker']);
});

test('a reaped teammate that speaks again comes back; one that merely finished does not', () => {
  const r = rig({ stallMs: 10 * MIN });
  tm(r, { status: 'teammate_spawned', name: 'bob', agent_id: 'bob@team' });
  r.call('abob-0123456789abcdef', 'bob');
  r.tick(11 * MIN);
  assert.deepStrictEqual(r.m.stack(), [], 'reaped for silence');
  r.call('abob-0123456789abcdef', 'bob');
  assert.deepStrictEqual(r.m.stack(), ['worker']);
});

// ---- SendMessage: resume and queue ----

function endedRun(r, id = 'A', type = 't') {
  r.spawn(type);
  r.call(id, type);
  r.stop(id, type);
  assert.deepStrictEqual(r.m.stack(), []);
}

test('a SendMessage result that resumed an ended run reopens it as a background run, with the next id', () => {
  const r = rig();
  endedRun(r);
  const before = r.m.invocations().length;
  r.send_('A', { success: true, resumedAgentId: 'A' }, 'sm1');
  assert.deepStrictEqual(r.m.stack(), ['t']);
  assert.strictEqual(r.m.stateOf('t'), WORKING);
  assert.deepStrictEqual(r.bg(), [true]);
  assert.strictEqual(before, 0);
  assert.strictEqual(r.m.invocations()[0].id, 2, 'ids count up from 1: the first spawn was 1');
  assert.strictEqual(r.m.invocations()[0].agentId, 'A');
});

test('a SendMessage result is read only when it is an object that says success: true', () => {
  for (const response of [{ success: false, resumedAgentId: 'A' }, { resumedAgentId: 'A' }, { success: 'true', resumedAgentId: 'A' }, null, undefined, 'x', 7]) {
    const r = rig();
    endedRun(r);
    assert.doesNotThrow(() => r.send_('A', response));
    assert.deepStrictEqual(r.m.stack(), [], JSON.stringify(response));
  }
});

test('a resumedAgentId that is not a non-empty string reopens nothing', () => {
  for (const resumedAgentId of ['', 5, null, {}, ['A']]) {
    const r = rig();
    endedRun(r);
    r.send_('A', { success: true, resumedAgentId });
    assert.deepStrictEqual(r.m.stack(), [], JSON.stringify(resumedAgentId));
  }
});

test('a resumed id this host never saw end reopens nothing', () => {
  const r = rig();
  r.send_('Q', { success: true, resumedAgentId: 'never-seen' });
  assert.deepStrictEqual(r.m.stack(), []);
});

test('a pin on a run that is still going is queued; on one that is not running, or with no pin, nothing is', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');
  assert.strictEqual(r.m.bookkeeping().queued, 0);
  r.send_('A', { success: true, pin: { id: 'A' } });
  assert.strictEqual(r.m.bookkeeping().queued, 1);
  r.send_('A', { success: true, pin: { id: 'nobody' } });
  r.send_('A', { success: true, pin: { id: 5 } });
  r.send_('A', { success: true, pin: {} });
  r.send_('A', { success: true, pin: null });
  assert.doesNotThrow(() => r.send_('A', { success: true }));
  assert.strictEqual(r.m.bookkeeping().queued, 1);
});

test('an empty resumedAgentId does not hide the pin beside it: the run is queued and its next event after its end reopens it', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');
  r.send_('A', { success: true, resumedAgentId: '', pin: { id: 'A' } });
  assert.strictEqual(r.m.bookkeeping().queued, 1);
  r.stop('A', 't');
  r.call('A', 't');
  assert.deepStrictEqual(r.m.stack(), ['t']);
});

test('a run whose tool round completed has its queued message drained: its next event after the end is an echo', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');
  r.send_('A', { success: true, pin: { id: 'A' } });
  r.call('A', 't');                                       // a completed tool round drains it
  assert.strictEqual(r.m.bookkeeping().queued, 0);
  r.stop('A', 't');
  r.call('A', 't');
  assert.deepStrictEqual(r.m.stack(), []);
});

test('a SendMessage delivered twice (same tool_use_id) while the run is open reopens it once', () => {
  const r = rig();
  endedRun(r);
  r.send_('A', { success: true, resumedAgentId: 'A' }, 'sm1');
  r.stop('A', 't');
  r.send_('A', { success: true, resumedAgentId: 'A' }, 'sm1');
  assert.deepStrictEqual(r.m.stack(), [], 'the redelivery after the end is recognised');
});

// ---- Stop's background_tasks ----

test('Stop ends the main session\'s foreground runs and keeps the ones it lists as running by id', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');
  r.spawn('t');
  r.mainStop([{ id: 'A', agent_type: 't' }]);
  assert.deepStrictEqual(r.ids(), [['t', 'A']]);
  assert.deepStrictEqual(r.bg(), [true]);
});

test('a listed id that is found by id wins over a same-type guess by name', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');
  r.spawn('t');                                            // unbound sibling of the same type
  r.mainStop([{ id: 'A', agent_type: 't' }]);
  assert.deepStrictEqual(r.ids(), [['t', 'A']]);
  assert.strictEqual(r.m.invocations()[0].id, 1, 'the run that holds the id survives, not the unbound sibling');
});

test('a listed task that names no run by id is matched by type, only when exactly one unbound run fits, and by description when given', () => {
  const survivors = (tasks, spawns) => {
    const r = rig();
    for (const s of spawns) r.spawn(s.type, { input: s.description === undefined ? {} : { description: s.description } });
    r.mainStop(tasks);
    return r.ids();
  };
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't' }], [{ type: 't' }]), [['t', 'N']], 'one fit');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't' }], [{ type: 't' }, { type: 't' }]), [], 'ambiguous: nobody is re-keyed');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 'other' }], [{ type: 't' }]), [], 'another type');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't', description: 'd1' }], [{ type: 't', description: 'd1' }]), [['t', 'N']], 'same description');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't', description: 'd2' }], [{ type: 't', description: 'd1' }]), [], 'a different description');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't', description: 'd1' }], [{ type: 't' }]), [], 'the run has none');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't', description: null }], [{ type: 't', description: 'd1' }]), [['t', 'N']], 'the task gives none');
  assert.deepStrictEqual(survivors([{ id: 'N', agent_type: 't' }], [{ type: 't', description: 'd1' }]), [['t', 'N']], 'the task gives none');
});

test('a listed run that is already bound to another id, or is not the main session\'s foreground work, is not a guess target', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');                                        // bound to A
  r.mainStop([{ id: 'N', agent_type: 't' }]);
  assert.deepStrictEqual(r.m.stack(), [], 'bound to a different id: N names nobody here');
  const bg = rig();
  const k = bg.spawn('t');
  bg.result(k, { status: 'async_launched' });              // a background run
  bg.mainStop([{ id: 'N', agent_type: 't' }]);
  assert.deepStrictEqual(bg.ids(), [['t', null]], 'background work is not Stop\'s to end, nor to re-key');
});

test('a listed id that already ended is not proof it came back: it re-keys nothing', () => {
  const r = rig();
  endedRun(r, 'E');
  r.spawn('t');                                            // another unbound run of the same type
  r.mainStop([{ id: 'E', agent_type: 't' }]);
  assert.deepStrictEqual(r.m.stack(), [], 'the new run was Stop\'s to end');
});

test('junk among the listed tasks is skipped without throwing', () => {
  const r = rig();
  r.spawn('t');
  assert.doesNotThrow(() => r.mainStop([null, undefined, {}, { id: '' }, { id: 0 }, 'x', 5, { id: 'N', agent_type: 'nobody' }]));
  assert.deepStrictEqual(r.m.stack(), []);
  for (const tasks of [undefined, null, 'x', {}, 5]) {
    const q = rig();
    q.spawn('t');
    assert.doesNotThrow(() => q.mainStop(tasks));
    assert.deepStrictEqual(q.m.stack(), []);
  }
});

// ---- who a call belongs to ----

test('a tool named like a spawn tool is not a spawn result: its tool_use_id is not matched against spawns', () => {
  const r = rig();
  const k = r.spawn('t');
  r.result(k, { status: 'completed' }, { tool: 'Bash' });
  assert.deepStrictEqual(r.m.stack(), ['t']);
});

test('an Agent call whose tool_use_id is not a known spawn is an ordinary call of its caller', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't');
  for (let i = 0; i < 3; i++) r.call('A', 't', { tool: 'Agent', input: { same: 1 }, response: { exit_code: 0 } });
  // identical Agent calls by A with no tool_use_id are three identical calls: a retry loop
  assert.strictEqual(r.m.stateOf('t'), STRESSED);
  const q = rig();
  q.spawn('t');
  q.call('A', 't');
  for (let i = 0; i < 3; i++) q.result(`unknown${i}`, { exit_code: 0 }, { by: 'A', agentType: 't', input: { same: 1 } });
  assert.strictEqual(q.m.stateOf('t'), STRESSED, 'unknown keys fall through to the ordinary-call path');
});

test('the same tool and input twice are a retry only when the tool AND the input both match: names that run into the input do not', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't', { tool: 'X1', input: 1 });
  r.call('A', 't', { tool: 'X', input: 11 });
  r.call('A', 't', { tool: 'X1', input: 1 });
  r.call('A', 't', { tool: 'X', input: 11 });
  assert.strictEqual(r.m.stateOf('t'), WORKING);
});

test('an interrupt flag on a PostToolUse is not a failure, however the response reads; on a failure event it is still a failure', () => {
  const r = rig();
  r.spawn('t');
  r.call('A', 't', { response: { interrupted: true, exit_code: 1 } });
  assert.strictEqual(r.m.stateOf('t'), WORKING);
  r.call('A', 't', { response: { interrupted: true, success: false } });
  assert.strictEqual(r.m.stateOf('t'), WORKING);
  r.call('A', 't', { response: { interrupted: false, exit_code: 1 } });
  assert.strictEqual(r.m.stateOf('t'), STRESSED);
  const f = rig();
  f.spawn('t');
  f.call('A', 't');
  f.call('A', 't', { event: 'PostToolUseFailure', response: { interrupted: true } });
  assert.strictEqual(f.m.stateOf('t'), STRESSED);
  const s = rig();
  s.spawn('t');
  s.call('A', 't', { response: 'interrupted' });
  assert.strictEqual(s.m.stateOf('t'), WORKING);
});

test('a flag of "interrupted" that is not exactly true does not excuse a failure', () => {
  for (const interrupted of ['true', 1, 'yes']) {
    const r = rig();
    r.spawn('t');
    r.call('A', 't', { response: { interrupted, exit_code: 2 } });
    assert.strictEqual(r.m.stateOf('t'), STRESSED, String(interrupted));
  }
});

// ---- clocks: what a call or a spawn keeps alive ----

test('spawning a child is a sign of life of its parent', () => {
  const r = rig({ stallMs: 10 * MIN, maxInvocationMs: 100 * MIN });
  r.spawn('P');
  r.call('P1', 'P');                                       // binds P
  r.advance(8 * MIN);
  r.spawn('C', { by: 'P1', agentType: 'P' });
  r.stop(undefined, 'C');
  r.tick(7 * MIN);                                         // 15 min after P's own start, 7 after the spawn
  assert.deepStrictEqual(r.m.stack(), ['P']);
});

test('the result of a child\'s spawn, delivered by its spawner, is a sign of life of that spawner', () => {
  const r = rig({ stallMs: 10 * MIN, maxInvocationMs: 100 * MIN });
  r.spawn('P');
  r.call('P1', 'P');
  r.advance(1 * MIN);
  const kc = r.spawn('C', { by: 'P1', agentType: 'P' });
  r.advance(8 * MIN);
  r.result(kc, { status: 'async_launched', isAsync: true, agentId: 'C1' }, { by: 'P1', agentType: 'P' });
  r.tick(5 * MIN);                                         // 14 min after P's start, 5 after the result
  assert.deepStrictEqual(r.m.stack(), ['P'], 'P lives on the strength of the result; C, silent since it was spawned, was reaped');
});

test('a child\'s calls keep its WHOLE foreground chain alive up to the main session', () => {
  const r = rig({ stallMs: 10 * MIN, maxInvocationMs: 100 * MIN });
  r.spawn('P');
  r.call('P1', 'P');
  r.spawn('C', { by: 'P1', agentType: 'P' });
  r.call('C1', 'C');
  r.advance(9 * MIN);
  r.call('C1', 'C');
  r.stop('C1', 'C');                                       // the child is done; the parent is alone
  r.tick(2 * MIN);                                         // 11 min after P's own last event
  assert.deepStrictEqual(r.m.stack(), ['P'], 'the child\'s call at 9 min refreshed P');
});

test('a background run\'s own calls do not keep its spawner alive', () => {
  // quietStallMs: a spawner that launched background work has its own, longer silence limit (BACKLOG #155); here it is the stall's
  const r = rig({ stallMs: 10 * MIN, maxInvocationMs: 100 * MIN, quietStallMs: 10 * MIN });
  r.spawn('P');
  r.call('P1', 'P');
  const kb = r.spawn('B', { by: 'P1', agentType: 'P', input: { run_in_background: true } });
  void kb;
  r.call('B1', 'B');
  for (let i = 0; i < 4; i++) { r.advance(3 * MIN); r.call('B1', 'B'); }
  r.tick(0);                                               // 12 min of silence from P, B alive
  assert.deepStrictEqual(r.m.stack(), ['B'], 'P was reaped and B was not');
});

test('a call from a subagent keeps its own card awake even when the main session is quiet', () => {
  const r = rig({ stallMs: 10 * MIN, maxInvocationMs: 100 * MIN });
  r.spawn('P');
  r.call('P1', 'P');
  r.advance(9 * MIN);
  r.call('P1', 'P');
  r.tick(5 * MIN);
  assert.deepStrictEqual(r.m.stack(), ['P']);
  r.tick(6 * MIN);
  assert.deepStrictEqual(r.m.stack(), []);
});

// ---- the ids a spawn gets, and the bookkeeping ----

test('invocation ids count up from 1 in spawn order', () => {
  const r = rig();
  r.spawn('a');
  r.spawn('b');
  r.spawn('c');
  assert.deepStrictEqual(r.m.invocations().map((i) => i.id), [1, 2, 3]);
});

test('a spawn with no tool_use_id is tracked in no table, and ending it leaves no tombstone and no remembered id', () => {
  const r = rig();
  r.spawn('t', { key: null });
  assert.deepStrictEqual(r.m.bookkeeping(), { spawns: 0, endedKeys: 0, endedIds: 0, queued: 0 });
  r.stop(undefined, 't');
  assert.deepStrictEqual(r.m.bookkeeping(), { spawns: 0, endedKeys: 0, endedIds: 0, queued: 0 });
});

test('a spawn with a tool_use_id and a bound id leaves one tombstone and one remembered id when it ends', () => {
  const r = rig();
  r.spawn('t', { key: 'k1' });
  assert.strictEqual(r.m.bookkeeping().spawns, 1);
  r.call('A', 't');
  r.stop('A', 't');
  assert.deepStrictEqual(r.m.bookkeeping(), { spawns: 0, endedKeys: 1, endedIds: 1, queued: 0 });
  assert.strictEqual(r.m.watchedEnd('A'), true);
  assert.strictEqual(r.m.watchedEnd('B'), false);
  for (const v of [undefined, null, 5, {}, ['A']]) assert.strictEqual(r.m.watchedEnd(v), false);
});

test('a run that ends unbound leaves nothing in the ended-ids table', () => {
  const r = rig();
  r.spawn('t', { key: 'k1' });
  r.stop(undefined, 't');
  assert.strictEqual(r.m.bookkeeping().endedIds, 0);
});

test('a spawn delivered twice, or after it ended, is not a second run', () => {
  const r = rig();
  r.spawn('t', { key: 'k1' });
  r.spawn('t', { key: 'k1' });
  assert.strictEqual(r.m.stack().length, 1);
  r.stop(undefined, 't');
  r.spawn('t', { key: 'k1' });
  assert.strictEqual(r.m.stack().length, 0);
  r.spawn('t', { key: 'k2' });
  assert.strictEqual(r.m.stack().length, 1);
});

test('a parent finishing cuts its foreground child off (it sleeps) while the parent flashes happy', () => {
  const r = rig();
  r.spawn('P');
  r.call('P1', 'P');
  r.spawn('C', { by: 'P1', agentType: 'P' });
  r.call('C1', 'C');
  r.stop('P1', 'P');
  assert.strictEqual(r.m.stateOf('P'), HAPPY);
  assert.strictEqual(r.m.stateOf('C'), SLEEPING);
  assert.deepStrictEqual(r.m.stack(), []);
});

// ---- the memory bound, at its exact edge ----

test('the ended-keys table holds exactly REMEMBER_MAX tombstones; the oldest is the one forgotten, and not before', () => {
  const r = rig();
  const run = (i) => { r.spawn('t', { key: `k${i}` }); r.stop(undefined, 't'); };
  for (let i = 0; i < REMEMBER_MAX; i++) run(i);
  assert.strictEqual(r.m.bookkeeping().endedKeys, REMEMBER_MAX);
  r.spawn('t', { key: 'k0' });
  assert.strictEqual(r.m.stack().length, 0, 'at exactly the bound nothing was forgotten yet');
  run(REMEMBER_MAX);
  assert.strictEqual(r.m.bookkeeping().endedKeys, REMEMBER_MAX);
  r.spawn('t', { key: 'k0' });
  assert.strictEqual(r.m.stack().length, 1, 'the oldest tombstone is gone, so that key is a fresh spawn');
  r.stop(undefined, 't');
  r.spawn('t', { key: `k${REMEMBER_MAX}` });
  assert.strictEqual(r.m.stack().length, 0, 'the newest is still remembered');
});

test('the ended-ids table is bounded the same way, oldest first', () => {
  const r = rig();
  const run = (i) => { r.spawn('t', { key: `k${i}` }); r.call(`id${i}`, 't'); r.stop(`id${i}`, 't'); };
  for (let i = 0; i < REMEMBER_MAX; i++) run(i);
  assert.strictEqual(r.m.bookkeeping().endedIds, REMEMBER_MAX);
  assert.strictEqual(r.m.watchedEnd('id0'), true);
  run(REMEMBER_MAX);
  assert.strictEqual(r.m.bookkeeping().endedIds, REMEMBER_MAX);
  assert.strictEqual(r.m.watchedEnd('id0'), false);
  assert.strictEqual(r.m.watchedEnd('id1'), true);
});

test('the teammate table is bounded the same way: the oldest is forgotten past REMEMBER_MAX, not at it', () => {
  const woken = (extra, refreshFirst) => {
    const r = rig();
    endedMate(r, 'm0');
    for (let i = 1; i < REMEMBER_MAX + extra; i++) tm(r, { status: 'teammate_spawned', name: `m${i}`, agent_id: `m${i}@team` });
    if (refreshFirst) { /* handled by the caller */ }
    r.send_('m0', { success: true });
    r.call('am0-0123456789abcdef', 'm0');
    return r.m.stack().includes('worker') && r.m.invocations().some((i) => i.agentId === 'am0-0123456789abcdef');
  };
  assert.strictEqual(woken(0, false), true, 'exactly REMEMBER_MAX teammates: the first is still known');
  assert.strictEqual(woken(1, false), false, 'one more: the first is forgotten');
});

test('respawning a teammate makes it the newest in the table, so it is not the next one forgotten', () => {
  const r = rig();
  endedMate(r, 'm0');
  for (let i = 1; i < REMEMBER_MAX; i++) tm(r, { status: 'teammate_spawned', name: `m${i}`, agent_id: `m${i}@team` });
  tm(r, { status: 'teammate_spawned', name: 'm0', agent_id: 'm0@team' });       // refreshed
  r.call('am0-0123456789abcdef', 'm0');
  r.stop('am0-0123456789abcdef', 'm0');
  tm(r, { status: 'teammate_spawned', name: `m${REMEMBER_MAX}`, agent_id: `m${REMEMBER_MAX}@team` });   // evicts the oldest: m1
  r.send_('m0', { success: true });
  r.call('am0-0123456789abcdef', 'm0');
  assert.ok(r.m.invocations().some((i) => i.agentId === 'am0-0123456789abcdef'), 'm0 survived');
});

// ---- reaped runs, and the resumed-id shapes ----

test('a reaped background run comes back once; after it ends normally a late call from it is an echo again', () => {
  const r = rig({ stallMs: 10 * MIN });
  const k = r.spawn('t');
  r.result(k, { status: 'async_launched', agentId: 'B1' });
  r.tick(11 * MIN);
  assert.deepStrictEqual(r.m.stack(), [], 'reaped for silence');
  r.call('B1', 't');
  assert.deepStrictEqual(r.m.stack(), ['t'], 'it was only quiet');
  r.stop('B1', 't');
  assert.deepStrictEqual(r.m.stack(), []);
  r.call('B1', 't');
  assert.deepStrictEqual(r.m.stack(), [], 'it finished: nothing brings it back now');
});

test('a resumedAgentId of the wrong type does not hide the pin beside it', () => {
  for (const resumedAgentId of [5, true, {}]) {
    const r = rig();
    r.spawn('t');
    r.call('A', 't');
    r.send_('A', { success: true, resumedAgentId, pin: { id: 'A' } });
    assert.strictEqual(r.m.bookkeeping().queued, 1, JSON.stringify(resumedAgentId));
  }
});

test('queuing the same run again makes it the newest, so a full queue forgets a different run first', () => {
  const r = rig();
  const N = REMEMBER_MAX;
  for (let i = 0; i <= N; i++) { r.spawn('t', { key: `k${i}` }); r.call(`id${i}`, 't'); }
  const queue = (id) => r.send_('x', { success: true, pin: { id } });
  for (let i = 0; i < N; i++) queue(`id${i}`);                // id0 is the oldest of exactly N
  assert.strictEqual(r.m.bookkeeping().queued, N);
  queue('id0');                                                // moves to the newest
  assert.strictEqual(r.m.bookkeeping().queued, N);
  queue(`id${N}`);                                             // one past the bound: the oldest goes, and that is id1
  assert.strictEqual(r.m.bookkeeping().queued, N);
  r.stop('id0', 't');
  const open = r.m.invocations().length;
  r.call('id0', 't');
  assert.strictEqual(r.m.invocations().length, open + 1, 'id0 is still marked: its next event reopens it');
  r.stop('id1', 't');
  const open1 = r.m.invocations().length;
  r.call('id1', 't');
  assert.strictEqual(r.m.invocations().length, open1, 'id1 was the one forgotten: its late call is an echo');
});

// ---- a run that comes back: what is recorded, and where ----

test('a run that ended twice is remembered as the NEWEST ended id, so the bound forgets the one before it', () => {
  const r = rig();
  const run = (i) => { r.spawn('t', { key: `k${i}` }); r.call(`id${i}`, 't'); r.stop(`id${i}`, 't'); };
  for (let i = 0; i < REMEMBER_MAX; i++) run(i);
  // id0 comes back on its own id and ends again: it is now the freshest memory, not the oldest.
  r.send_('t', { success: true, resumedAgentId: 'id0' }, 'resume0');
  r.stop('id0', 't');
  assert.strictEqual(r.m.bookkeeping().endedIds, REMEMBER_MAX, 'ending it again did not add a second entry');
  run(REMEMBER_MAX);
  assert.strictEqual(r.m.watchedEnd('id0'), true, 'the re-ended run kept its place at the new end');
  assert.strictEqual(r.m.watchedEnd('id1'), false, 'the oldest remaining one went instead');
});

test('a woken teammate is linked to its reopened run: one more call of its own opens nothing else', () => {
  const r = rig();
  endedMate(r, 'bob');
  r.send_('bob', { success: true });
  r.call('abob-0123456789abcdef', 'bob');
  r.call('abob-0123456789abcdef', 'bob');
  r.call('abob-0123456789abcdef', 'bob');
  assert.strictEqual(r.m.invocations().length, 1, 'one reopened run, however many calls follow');
  r.stop('abob-0123456789abcdef', 'bob');
  assert.strictEqual(r.m.invocations().length, 0);
  r.call('abob-0123456789abcdef', 'bob');
  assert.strictEqual(r.m.invocations().length, 0, 'ended again, and not woken again, so a late call is an echo');
});

test('a resumed run is findable by the tool call that resumed it; a wake with no call id registers nothing', () => {
  const r = rig();
  r.spawn('t', { key: 'k0' });
  r.call('id0', 't');
  r.stop('id0', 't');
  const before = r.m.bookkeeping().spawns;
  r.send_('t', { success: true, resumedAgentId: 'id0' }, 'resume0');
  assert.strictEqual(r.m.bookkeeping().spawns, before + 1, 'the resuming call id is tracked while the run is open');
  r.stop('id0', 't');
  assert.strictEqual(r.m.bookkeeping().spawns, before, 'and dropped when it ends');

  const m = rig();
  endedMate(m, 'bob');
  const base = m.m.bookkeeping().spawns;
  m.send_('bob', { success: true });
  m.call('abob-0123456789abcdef', 'bob');
  assert.strictEqual(m.m.invocations().length, 1);
  assert.strictEqual(m.m.bookkeeping().spawns, base, 'a wake carries no call id, so nothing is tracked under one');
});
