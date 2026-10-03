'use strict';
/**
 * Bug (2026-10-03, suno-pipeline window): a named agent the CLI listed as
 * running for 21 minutes showed "Sleeping" on its roster card.
 *
 * MEASURED, from the session's own transcript
 * (~/.claude/projects/C--Users-ricar-VibeCode-suno-pipeline-dev/525f765a-*.jsonl):
 *   - The spawn was Agent { subagent_type: "mutation-tester", name:
 *     "mortimer-release" } -- a NAMED TEAMMATE. Its input carries NO
 *     run_in_background.
 *   - Its result was neither `async_launched` nor `completed`:
 *       { status: "teammate_spawned", teammate_id, agent_id:
 *         "mortimer-release@session-2e134ac8", agent_type: "mutation-tester",
 *         name: "mortimer-release", team_name, ... }
 *     (snake_case `agent_id`, not `agentId`).
 *   So the machine opened a FOREGROUND invocation, and the main session's next
 *   Stop ended it as finished: happy flash, then Sleeping, while the teammate
 *   kept working for hours.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createMoodMachine, WORKING, SLEEPING } = require('../host/mood-machine');

const MIN = 60_000;
const TEAMMATE = 'mortimer-release@session-2e134ac8';

function harness() {
  let now = 1_000_000;
  const m = createMoodMachine({ now: () => now });
  return {
    m,
    advance(ms) { now += ms; m.tick(); },
    spawnTeammate() {
      m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'toolu_T',
        tool_input: { subagent_type: 'mutation-tester', name: 'mortimer-release', description: 'gate' } } });
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'toolu_T',
        tool_input: { subagent_type: 'mutation-tester', name: 'mortimer-release' },
        tool_response: { status: 'teammate_spawned', teammate_id: TEAMMATE, agent_id: TEAMMATE,
          agent_type: 'mutation-tester', name: 'mortimer-release', team_name: 'session-2e134ac8' } } });
    },
    mainStop(tasks = []) { m.handle({ event: 'Stop', payload: { background_tasks: tasks } }); },
    own(agentId = TEAMMATE, type = 'mutation-tester') {
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'c' + Math.random() },
        tool_response: { exit_code: 0 }, agent_id: agentId, agent_type: type } });
    },
  };
}

test('a named teammate survives the main session\'s Stop: it is background work', () => {
  const h = harness();
  h.spawnTeammate();
  h.mainStop();
  assert.equal(h.m.stateOf('mutation-tester'), WORKING);
  assert.deepEqual(h.m.stack(), ['mutation-tester']);
  assert.equal(h.m.invocations()[0].background, true);
});

test('a teammate is bound by the agent_id its spawn result names', () => {
  const h = harness();
  h.spawnTeammate();
  assert.equal(h.m.invocations()[0].agentId, TEAMMATE);
  h.mainStop();
  h.own();
  assert.equal(h.m.invocations().length, 1, 'its own call attributes to the same run, not a new one');
});

test('a teammate whose own events carry its name as agent_type is still the same run', () => {
  const h = harness();
  h.spawnTeammate();
  h.own(TEAMMATE, 'mortimer-release');
  assert.equal(h.m.stateOf('mutation-tester'), WORKING);
});

test('hypothesis 2 ruled out: one 7-minute silent tool call does not sleep a running agent', () => {
  const h = harness();
  // A plain async launch: the idle rule alone, with no teammate involved.
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'toolu_B',
    tool_input: { subagent_type: 'mutation-tester', run_in_background: true } } });
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'toolu_B',
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'b1' } } });
  h.mainStop();
  h.advance(7 * MIN);
  assert.equal(h.m.stateOf('mutation-tester'), WORKING);
});

test('hypothesis 3: a background run that keeps working is not reaped at 45 minutes', () => {
  const h = harness();
  h.spawnTeammate();
  h.mainStop();
  for (let i = 0; i < 18; i++) { h.advance(10 * MIN); h.own(); }   // 3 hours, a call every 10 min
  assert.equal(h.m.stateOf('mutation-tester'), WORKING);
});

test('...but a background run gone silent is still reaped by the stall clock', () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  h.advance(31 * MIN);
  assert.equal(h.m.stateOf('mutation-tester'), SLEEPING);
});

test('the 45-minute cap still reaps a FOREGROUND run with a dropped SubagentStop', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'toolu_F',
    tool_input: { subagent_type: 'general-purpose' } } });
  for (let i = 0; i < 5; i++) { h.advance(10 * MIN); h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Bash', tool_input: { command: 'x' + i }, tool_response: { exit_code: 0 } } }); }
  assert.equal(h.m.stateOf('general-purpose'), SLEEPING);
});

test('property: a teammate that keeps emitting events is never shown asleep, whatever the main session does', () => {
  const op = fc.oneof(
    fc.record({ k: fc.constant('wait'), ms: fc.integer({ min: 1, max: 25 * MIN }) }),
    fc.record({ k: fc.constant('stop') }),
    fc.record({ k: fc.constant('own') }),
    fc.record({ k: fc.constant('listed') }),
  );
  fc.assert(fc.property(fc.array(op, { maxLength: 40 }), ops => {
    const h = harness();
    h.spawnTeammate();
    let quiet = 0;                                  // ms since the teammate last spoke
    for (const o of ops) {
      if (o.k === 'wait') {
        // The generator keeps every silence below the stall limit.
        const ms = Math.min(o.ms, 29 * MIN - quiet);
        if (ms > 0) { h.advance(ms); quiet += ms; }
      } else if (o.k === 'stop') h.mainStop();
      else if (o.k === 'listed') h.mainStop([{ id: TEAMMATE, agent_type: 'mutation-tester', status: 'running' }]);
      else { h.own(); quiet = 0; }
      if (h.m.stateOf('mutation-tester') !== WORKING) return false;
    }
    return true;
  }), { numRuns: 300 });
});
