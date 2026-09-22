// @ts-nocheck
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

test('a working agent falls asleep after the idle timeout', () => {
  const h = harness({ idleMs: 90000 });
  h.pre('Task', AGENT);
  h.advance(89999);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working');
  h.advance(2);
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'sleeping');
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
