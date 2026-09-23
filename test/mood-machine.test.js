'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createMoodMachine } = require('../host/mood-machine');

// Time is injected. The machine schedules nothing itself: the host drives
// `tick()`. Tests that depend on wall-clock timers are slow and flaky, and the
// design calls for a mood engine that is explainable when a face is wrong.
function harness(opts = {}) {
  let now = 1_000_000;
  const m = createMoodMachine({ now: () => now, ...opts });
  return {
    m,
    advance(ms) { now += ms; m.tick(); },
    pre(tool, input) { m.handle({ event: 'PreToolUse', payload: { tool_name: tool, tool_input: input } }); },
    post(tool, input, response) {
      m.handle({ event: 'PostToolUse', payload: { tool_name: tool, tool_input: input, tool_response: response } });
    },
    stop() { m.handle({ event: 'SubagentStop', payload: {} }); },
  };
}

const AGENT = { subagent_type: 'code-reviewer' };

test('an unknown agent is sleeping', () => {
  const { m } = harness();
  assert.strictEqual(m.stateOf('nobody'), 'sleeping');
});

test('PreToolUse on Task wakes that agent into working', () => {
  const h = harness();
  h.pre('Task', AGENT);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
});

test('a successful PostToolUse keeps the agent working', () => {
  const h = harness();
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'ls' }, { exit_code: 0 });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
});

test('a non-zero Bash exit makes the agent stressed', () => {
  const h = harness();
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'false' }, { exit_code: 1 });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
});

test('the same tool three times running makes the agent stressed', () => {
  // Retry loops read as distress even when nothing reports an error.
  const h = harness();
  h.pre('Task', AGENT);
  for (let i = 0; i < 3; i++) h.post('Bash', { command: 'npm test' }, { exit_code: 0 });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
});

test('differing tool inputs are not a retry loop', () => {
  const h = harness();
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'a' }, { exit_code: 0 });
  h.post('Bash', { command: 'b' }, { exit_code: 0 });
  h.post('Bash', { command: 'c' }, { exit_code: 0 });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
});

test('SubagentStop with no errors flashes happy, then sleeps', () => {
  const h = harness({ flashMs: 8000 });
  h.pre('Task', AGENT);
  h.stop();
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'happy');
  h.advance(7999);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'happy');
  h.advance(2);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'sleeping');
});

test('SubagentStop after an error flashes stressed, then sleeps', () => {
  const h = harness({ flashMs: 8000 });
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'false' }, { exit_code: 1 });
  h.stop();
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
  h.advance(8001);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'sleeping');
});

test('a RUNNING agent is judged on the stall clock, not the idle clock', () => {
  // FF2 changed this test's premise, deliberately. It used to assert that a
  // working agent sleeps after idleMs -- which is exactly the behaviour
  // Ricardo reported as wrong, having watched Paris go to sleep while it was
  // plainly running. An agent that has started and not stopped is running, and
  // ninety seconds of silence is an ordinary amount of thinking.
  //
  // What survives is the reaping, on the longer clock: a SubagentStop that
  // never arrives must not leave an agent "working" for the rest of the
  // session. Both boundaries are asserted here because STALL_MS is a
  // module-scope constant, and StrykerJS generates no mutants for numeric
  // literals -- the score cannot see this threshold at all.
  const h = harness({ idleMs: 90000, stallMs: 600000 });
  h.pre('Task', AGENT);
  h.advance(300000);              // five minutes of silence, still running
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working',
    'thinking for minutes is normal and must not read as asleep');
  h.advance(299999);              // one millisecond short of the stall limit
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
  h.advance(2);                   // past it: SubagentStop can only be lost
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'sleeping',
    'a stalled agent must still be reaped, or a crash reads as work forever');
});

test('activity resets the idle countdown', () => {
  const h = harness({ idleMs: 90000 });
  h.pre('Task', AGENT);
  h.advance(80000);
  h.post('Bash', { command: 'ls' }, { exit_code: 0 });
  h.advance(80000);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
});

test('error count resets between runs of the same agent', () => {
  // Otherwise one bad run marks an agent stressed forever.
  const h = harness({ flashMs: 8000 });
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'false' }, { exit_code: 1 });
  h.stop();
  h.advance(8001);
  h.pre('Task', AGENT);
  h.stop();
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'happy');
});

test('nested agents are tracked independently, innermost first', () => {
  const h = harness({ flashMs: 8000 });
  h.pre('Task', { subagent_type: 'agent-organizer' });
  h.pre('Task', { subagent_type: 'code-reviewer' });
  assert.strictEqual(h.m.stateOf('agent-organizer'), 'working');
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');

  // A Bash failure belongs to the innermost running agent.
  h.post('Bash', { command: 'false' }, { exit_code: 1 });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
  assert.strictEqual(h.m.stateOf('agent-organizer'), 'working');

  h.stop();
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
  assert.strictEqual(h.m.stateOf('agent-organizer'), 'working');
});

test('emits a change event only when the state actually changes', () => {
  // The GUI redraws portraits on these; repeating them would churn the sidebar.
  const h = harness();
  const seen = [];
  h.m.on('change', e => seen.push(`${e.agent}:${e.state}`));
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'a' }, { exit_code: 0 });
  h.post('Bash', { command: 'b' }, { exit_code: 0 });
  assert.deepStrictEqual(seen, ['code-reviewer:working']);
});

test('roster lists every agent seen with its current state', () => {
  const h = harness();
  h.pre('Task', { subagent_type: 'miguel' });
  h.pre('Task', { subagent_type: 'dexter' });
  const roster = h.m.roster();
  assert.deepStrictEqual(
    roster.map(r => r.agent).sort(),
    ['dexter', 'miguel']
  );
  assert.ok(roster.every(r => r.state === 'working'));
});

test('a Task with no subagent_type is ignored rather than crashing', () => {
  const h = harness();
  h.pre('Task', {});
  h.post('Bash', { command: 'x' }, { exit_code: 1 });
  assert.deepStrictEqual(h.m.roster(), []);
});

test('an error reported as a string exit status still registers', () => {
  // Hook payload shapes vary; treating a stringy "1" as success would make the
  // mood engine quietly wrong rather than loudly broken.
  const h = harness();
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'false' }, { exit_code: '1' });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
});

test('an interrupted tool counts as an error', () => {
  const h = harness();
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'sleep 999' }, { interrupted: true });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'stressed');
});

test('events for an agent that never started do not create ghosts', () => {
  const h = harness();
  h.post('Bash', { command: 'ls' }, { exit_code: 1 });
  h.stop();
  assert.deepStrictEqual(h.m.roster(), []);
});

test('a string zero exit status is success, not failure', () => {
  // Found by mutation: `Number(code) !== 0` -> `code !== 0` survived the whole
  // suite, because the existing string case ('1') agrees under both. Only a
  // stringy ZERO separates them -- and under the mutant every successful Bash
  // call reporting "0" would have marked the agent stressed.
  const h = harness();
  h.pre('Task', AGENT);
  h.post('Bash', { command: 'true' }, { exit_code: '0' });
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
});

test('exposes the live delegation stack, innermost last', () => {
  // Party view: the machine already keeps this to attribute a Bash failure to
  // the innermost agent. Surfacing it costs nothing and makes a subagent that
  // quietly spawned six more visible.
  const h = harness();
  h.pre('Task', { subagent_type: 'agent-organizer' });
  h.pre('Task', { subagent_type: 'code-reviewer' });
  h.pre('Task', { subagent_type: 'logic-reviewer' });
  assert.deepStrictEqual(h.m.stack(), ['agent-organizer', 'code-reviewer', 'logic-reviewer']);
  h.stop();
  assert.deepStrictEqual(h.m.stack(), ['agent-organizer', 'code-reviewer']);
});

test('the stack is empty when nothing is delegating', () => {
  assert.deepStrictEqual(harness().m.stack(), []);
});

// --- a running agent is not asleep -------------------------------------------
//
// FF2, from the first real use of the harness on another project. Ricardo, on
// Paris: "it appears as working most of the time it's running, it also appears
// as sleeping sometimes even though its running."
//
// `tick()` sent any agent quiet for longer than idleMs (90s) to SLEEPING, and
// `lastActivity` only advances on hook events. An agent thinking for more than
// ninety seconds, or inside one long tool call, emits nothing at all -- so the
// machine declared a working agent asleep on the strength of SILENCE.
//
// That is this project's absence-is-not-zero rule wearing a different hat:
// "no recent event" is not "not running", and the machine already knows the
// difference. `stack` holds every agent that has started and not yet emitted
// SubagentStop -- which is the definition of running.
//
// The timeout still exists and still matters: it is what reaps an agent whose
// SubagentStop never arrived, so a crashed subagent does not stay "working"
// forever. It just no longer outranks direct evidence of life.

test('an agent that is still running does not fall asleep while it thinks', () => {
  const h = harness({ idleMs: 90_000, stallMs: 30 * 60_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'paris' } } });
  assert.strictEqual(h.m.stateOf('paris'), 'working');

  h.advance(10 * 60_000);          // ten minutes of thinking: no hooks at all
  assert.strictEqual(h.m.stateOf('paris'), 'working',
    'a started agent with no SubagentStop is running, whatever the hooks say');
});

test('an agent that has finished still sleeps', () => {
  // The behaviour that must survive: SubagentStop takes it off the stack, the
  // happy flash plays, and then it sleeps.
  const h = harness({ idleMs: 90_000, flashMs: 8_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'paris' } } });
  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'paris' } });
  assert.strictEqual(h.m.stateOf('paris'), 'happy');
  h.advance(20_000);
  assert.strictEqual(h.m.stateOf('paris'), 'sleeping');
});

test('a plain agent with no running invocation still sleeps on silence', () => {
  // The reaper still reaps. Only a STARTED agent is protected, so an agent
  // that was merely mentioned does not stay awake forever.
  const h = harness({ idleMs: 90_000 });
  h.post('Bash', { command: 'ls' }, { exit_code: 0 });
  h.advance(200_000);
  const anyAwake = h.m.roster().some(r => r.state !== 'sleeping');
  assert.strictEqual(anyAwake, false, 'nothing that is not running may stay awake');
});
