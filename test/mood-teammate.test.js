'use strict';
/**
 * Bug (2026-10-03, suno-pipeline window): a named agent the CLI listed as
 * running for 21 minutes showed "Sleeping" on its roster card.
 *
 * MEASURED, from the session's own transcript (test/teammate-real-ids.fixture.json
 * holds the real values):
 *   - The spawn was Agent { subagent_type: "mutation-tester", name:
 *     "mortimer-release" } -- a NAMED TEAMMATE, no run_in_background.
 *   - Its result was { status: "teammate_spawned", agent_id:
 *     "mortimer-release@session-2e134ac8", ... }: an ADDRESS (name@team).
 *   - The teammate's OWN identity is "amortimer-release-5a5bc27d7582b9b2" (its
 *     transcript file and every line's agentId), a different string.
 * So the run is background, found by either identity, and bound to the id its
 * events carry. WHAT IS NOT MEASURED: the hook agent_type on a teammate's own
 * calls (`claude -p` never produces a teammate), so both candidates are used.
 *
 * The named-but-plain case IS captured for real: test/hooks-real-named-agent
 * .fixture.jsonl (a named Agent call under `claude -p` comes back async_launched).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { createMoodMachine, WORKING, SLEEPING } = require('../host/mood-machine');
const { findTranscript } = require('../host/agent-log-session');
const { tmpDir } = require('./tmp-dir');

const MIN = 60_000;
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'teammate-real-ids.fixture.json'), 'utf8'));
const ADDRESS = REAL.spawnResult.agent_id;
const RUNTIME = REAL.runtimeId;
const CARD = REAL.spawnInput.subagent_type;

function harness() {
  let now = 1_000_000;
  const m = createMoodMachine({ now: () => now });
  let serial = 0;
  const h = {
    m,
    advance(ms) { now += ms; m.tick(); },
    spawnTeammate(input = REAL.spawnInput, result = REAL.spawnResult) {
      const id = 'toolu_T' + (++serial);
      m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: id, tool_input: input } });
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: id, tool_input: input, tool_response: result } });
    },
    mainStop(tasks = []) { m.handle({ event: 'Stop', payload: { background_tasks: tasks } }); },
    own(agentId = RUNTIME, type = REAL.runtimeTypes[0]) {
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'c' + Math.random() },
        tool_response: { exit_code: 0 }, agent_id: agentId, agent_type: type } });
    },
    stop(agentId = RUNTIME, type = REAL.runtimeTypes[0]) {
      m.handle({ event: 'SubagentStop', payload: { agent_id: agentId, agent_type: type } });
    },
    send(to, response = { success: true }) {
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'SendMessage', tool_input: { to, message: 'again' },
        tool_response: response } });
    },
  };
  return h;
}

// ---- the incident -----------------------------------------------------------

test('a named teammate survives the main session\'s Stop: it is background work', () => {
  const h = harness();
  h.spawnTeammate();
  h.mainStop();
  assert.equal(h.m.stateOf(CARD), WORKING);
  assert.deepEqual(h.m.stack(), [CARD]);
  assert.equal(h.m.invocations()[0].background, true);
});

// ---- Dexter F1: the id its events really carry --------------------------------

for (const type of REAL.runtimeTypes) {
  test(`F1: a teammate's own calls (runtime id, agent_type "${type}") keep it working for an hour`, () => {
    const h = harness();
    h.spawnTeammate();
    h.mainStop();
    for (let i = 0; i < 6; i++) { h.advance(10 * MIN); h.own(RUNTIME, type); }
    h.advance(29 * MIN);
    assert.equal(h.m.stateOf(CARD), WORKING, 'its activity reached its record');
    assert.equal(h.m.invocations().length, 1, 'one run, not a second one');
    assert.equal(h.m.invocations()[0].agentId, RUNTIME, 'bound to the id its events carry');
  });
}

test('F1: the address works too (alias, not either/or)', () => {
  const h = harness();
  h.spawnTeammate();
  for (let i = 0; i < 6; i++) { h.advance(10 * MIN); h.own(ADDRESS, 'mortimer-release'); }
  h.advance(29 * MIN);
  assert.equal(h.m.stateOf(CARD), WORKING);
});

test('F1: a teammate not yet seen is found by its agent_type NAME alone, whatever id it carries', () => {
  const h = harness();
  h.spawnTeammate();
  h.own('someting-we-never-predicted', 'mortimer-release');
  assert.equal(h.m.invocations()[0].agentId, 'someting-we-never-predicted');
});

test('F1: a runtime id binds only the teammate whose NAME it embeds, not a name that is a prefix of it', () => {
  const h = harness();
  const mate = (name, team) => ({ ...REAL.spawnResult, name, agent_id: `${name}@${team}`, teammate_id: `${name}@${team}` });
  h.spawnTeammate({ subagent_type: 'code-reviewer', name: 'mortimer' }, mate('mortimer', 't'));
  h.spawnTeammate(REAL.spawnInput, REAL.spawnResult);
  h.own(RUNTIME, 'unrelated-type');
  const [a, b] = h.m.invocations();
  assert.equal(a.agentId, null, 'the short name did not take mortimer-release\'s id');
  assert.equal(b.agentId, RUNTIME);
});

test('F1: the teammate\'s end, by its runtime id, ends its run and leaves the card', () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  h.stop();
  assert.equal(h.m.invocations().length, 0);
  h.advance(9_000);
  assert.equal(h.m.stateOf(CARD), SLEEPING);
});

// ---- Dexter F4: the agent log ------------------------------------------------

test('F4: the log finds the teammate\'s real transcript while it runs, and says finished when it ends', async () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  const root = tmpDir('cc-mate-log-');
  const dir = path.join(root, 'C--w-proj', 'sess', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${RUNTIME}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  fs.writeFileSync(path.join(dir, `agent-${RUNTIME}.meta.json`), JSON.stringify({ agentType: 'mortimer-release' }));
  const bound = h.m.invocations()[0];
  const r = await findTranscript({ cwd: 'C:/w/proj', projectsDir: root, agent: CARD, agentId: bound.agentId });
  assert.equal(r.file, file);
  assert.equal(h.m.watchedEnd(RUNTIME), false);
  h.stop();
  assert.equal(h.m.watchedEnd(RUNTIME), true, 'its file reads as finished, not "latest run"');
});

// ---- Dexter F2: woken again --------------------------------------------------

for (const how of ['name', 'address']) {
  test(`F2: a teammate that ended and is woken by SendMessage (to its ${how}, no resumedAgentId) lights its card again`, () => {
    const h = harness();
    h.spawnTeammate();
    h.own();
    h.stop();
    h.advance(9_000);
    assert.equal(h.m.stateOf(CARD), SLEEPING);
    h.send(how === 'name' ? 'mortimer-release' : ADDRESS);
    h.own();
    assert.equal(h.m.stateOf(CARD), WORKING);
    h.mainStop();
    assert.equal(h.m.stateOf(CARD), WORKING, 'the woken run is background too');
    assert.equal(h.m.invocations()[0].agentId, RUNTIME);
  });
}

test('F2: without a wake, a late call from an ended teammate is still an echo and is dropped', () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  h.stop();
  h.own();
  assert.equal(h.m.invocations().length, 0);
});

test('F2: a failed SendMessage does not wake it', () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  h.stop();
  h.send('mortimer-release', { success: false });
  h.own();
  assert.equal(h.m.invocations().length, 0);
});

// ---- Dexter F3: a reused name ------------------------------------------------

test('F3: spawning a teammate again under a name that already ended is background work', () => {
  const h = harness();
  h.spawnTeammate();
  h.own(ADDRESS, 'mortimer-release');
  h.stop(ADDRESS, 'mortimer-release');  // ended under the address: the old code remembered THAT as an ended run id
  h.spawnTeammate();                    // same name, same address, new tool_use_id
  h.mainStop();
  assert.equal(h.m.stateOf(CARD), WORKING);
  assert.equal(h.m.invocations()[0].background, true);
});

// ---- Dexter F5: a stall reap is not permanent ----------------------------------

test('F5: a reaped teammate that speaks again is working again', () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  h.advance(31 * MIN);
  assert.equal(h.m.stateOf(CARD), SLEEPING);
  h.own();
  assert.equal(h.m.stateOf(CARD), WORKING);
});

test('F5: so is a reaped async background run', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tb', tool_input: { subagent_type: 'general-purpose', run_in_background: true } } });
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tb',
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'b1' } } });
  h.advance(31 * MIN);
  assert.equal(h.m.stateOf('general-purpose'), SLEEPING);
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { exit_code: 0 },
    agent_id: 'b1', agent_type: 'general-purpose' } });
  assert.equal(h.m.stateOf('general-purpose'), WORKING);
});

test('F5: a run that FINISHED does not come back from a late call (only a reap does)', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tb', tool_input: { subagent_type: 'general-purpose', run_in_background: true } } });
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tb',
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'b1' } } });
  h.m.handle({ event: 'SubagentStop', payload: { agent_id: 'b1', agent_type: 'general-purpose' } });
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { exit_code: 0 },
    agent_id: 'b1', agent_type: 'general-purpose' } });
  assert.equal(h.m.invocations().length, 0);
});

// ---- Miguel 1: an unknown status naming a run ------------------------------------

test('M1: a spawn status we do not know, naming a run, is treated as RUNNING and logged', () => {
  const h = harness();
  const logged = [];
  const log = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu', tool_input: { subagent_type: 'general-purpose' } } });
    h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu',
      tool_response: { status: 'launched_somehow', agentId: 'u1' } } });
  } finally { console.log = log; }
  h.mainStop();
  assert.equal(h.m.stateOf('general-purpose'), WORKING);
  assert.ok(logged.some(l => l.includes('launched_somehow')), 'the unknown status is visible');
});

test('M1: `completed` still finishes the run, and a result naming nobody changes nothing', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu', tool_input: { subagent_type: 'general-purpose' } } });
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu', tool_response: { truncated: true } } });
  assert.equal(h.m.invocations().length, 1, 'no id, no verdict');
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu',
    tool_response: { status: 'completed', agentId: 'u1' } } });
  assert.equal(h.m.invocations().length, 0);
});

// ---- Miguel 2: the real captured payloads --------------------------------------------

test('M2: replay of REAL hook payloads: a named Agent call comes back async_launched and stays working through Stop', () => {
  const events = fs.readFileSync(path.join(__dirname, 'hooks-real-named-agent.fixture.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const m = createMoodMachine({ now: () => 1 });
  const seen = [];
  for (const p of events) {
    m.handle({ event: p.hook_event_name, payload: p });
    seen.push(m.stateOf('general-purpose'));
    if (p.hook_event_name === 'Stop' && !p.agent_id && m.invocations().length) {
      assert.equal(m.stateOf('general-purpose'), WORKING, 'the first Stop leaves the named background run working');
    }
  }
  assert.equal(m.invocations().length, 0, 'its own SubagentStop ended it');
});

// ---- Miguel 3: older CLIs keep the age cap -------------------------------------------

test('M3: without a labelling CLI, a background run still has the 45-minute cap', () => {
  const h = harness();
  const spawn = (id, type, bg) => {
    h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: id,
      tool_input: { subagent_type: type, ...(bg ? { run_in_background: true } : {}) } } });
    if (bg) h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: id,
      tool_response: { status: 'async_launched' } } });          // names no id: this CLI says nobody's
  };
  spawn('b', 'general-purpose', true);
  spawn('f', 'other', false);
  for (let i = 0; i < 5; i++) {                                    // main-session calls keep everything refreshed
    h.advance(10 * MIN);
    h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'x' + i }, tool_response: { exit_code: 0 } } });
  }
  assert.equal(h.m.stateOf('general-purpose'), SLEEPING, 'age cap reaped it though it was "refreshed"');
});

// ---- Miguel 4: a single silent call longer than the stall clock -----------------------------

test('M4: PINNED current behaviour: the CLI gives no signal during one tool call, so 31 silent minutes read as asleep until its next event', () => {
  const h = harness();
  h.spawnTeammate();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'docker exec mut' },
    agent_id: RUNTIME, agent_type: 'mortimer-release' } });
  h.advance(31 * MIN);
  assert.equal(h.m.stateOf(CARD), SLEEPING);
  h.own();                                                       // ...and the call returns
  assert.equal(h.m.stateOf(CARD), WORKING, 'F5 brings it back');
});

// ---- Miguel 6/7 and the old tests, kept -------------------------------------------------------

test('M6: both id spellings are read, `agentId` first', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu', tool_input: { subagent_type: 'general-purpose' } } });
  h.m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu',
    tool_response: { status: 'async_launched', agentId: 'A', agent_id: 'B' } } });
  assert.equal(h.m.invocations()[0].agentId, 'A');
});

test('hypothesis 2 ruled out: one 7-minute silent tool call does not sleep a running agent', () => {
  const h = harness();
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
  for (let i = 0; i < 18; i++) { h.advance(10 * MIN); h.own(); }
  assert.equal(h.m.stateOf(CARD), WORKING);
});

test('...but a background run gone silent is still reaped by the stall clock', () => {
  const h = harness();
  h.spawnTeammate();
  h.own();
  h.advance(31 * MIN);
  assert.equal(h.m.stateOf(CARD), SLEEPING);
});

test('the 45-minute cap still reaps a FOREGROUND run with a dropped SubagentStop', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'toolu_F',
    tool_input: { subagent_type: 'general-purpose' } } });
  for (let i = 0; i < 5; i++) { h.advance(10 * MIN); h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Bash', tool_input: { command: 'x' + i }, tool_response: { exit_code: 0 } } }); }
  assert.equal(h.m.stateOf('general-purpose'), SLEEPING);
});

test('property: a teammate that keeps emitting events (real runtime id) is never shown asleep, whatever the main session does', () => {
  const op = fc.oneof(
    fc.record({ k: fc.constant('wait'), ms: fc.integer({ min: 1, max: 25 * MIN }) }),
    fc.record({ k: fc.constant('stop') }),
    fc.record({ k: fc.constant('own'), type: fc.constantFrom(...REAL.runtimeTypes) }),
    fc.record({ k: fc.constant('listed') }),
  );
  fc.assert(fc.property(fc.array(op, { maxLength: 40 }), ops => {
    const h = harness();
    h.spawnTeammate();
    let quiet = 0;
    for (const o of ops) {
      if (o.k === 'wait') {
        const ms = Math.min(o.ms, 29 * MIN - quiet);
        if (ms > 0) { h.advance(ms); quiet += ms; }
      } else if (o.k === 'stop') h.mainStop();
      else if (o.k === 'listed') h.mainStop([{ id: RUNTIME, agent_type: 'mortimer-release', status: 'running' }]);
      else { h.own(RUNTIME, o.type); quiet = 0; }
      if (h.m.stateOf(CARD) !== WORKING) return false;
    }
    return true;
  }), { numRuns: 300 });
});

test('property: a teammate that is silent, or reaped, and then speaks is working again', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 300 }), gapMin => {
    const h = harness();
    h.spawnTeammate();
    h.own();
    h.advance(gapMin * MIN);
    h.own();
    return h.m.stateOf(CARD) === WORKING;
  }), { numRuns: 100 });
});
