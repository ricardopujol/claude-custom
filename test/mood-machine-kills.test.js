'use strict';
/**
 * KILLS FOR THE PR #33 MUTATION GATE.
 *
 * Mortimer, 1453 mutants, 84.2% adjusted. Every test in this file was written
 * and verified BY HIM -- green against the original, red against the specific
 * mutant it names -- and is taken verbatim rather than retyped, because the
 * verification is the valuable part and transcription would only risk it.
 *
 * Two of these are Criticals on live production paths, and one is the fifth
 * reaper path I suspected was in tick() and could not find. He found both of
 * those with a DIFFERENTIAL FUZZER -- original versus mutant over 3000 random
 * event streams, diffing stack() and roster() after every step -- not by
 * reading, which is why targeted reasoning had missed them four times.
 *
 * What the gate could NOT see, and why these are hand-written:
 *   - no numeric-literal mutator, so every tuned constant here is outside the
 *     score by construction;
 *   - no method-name mutator, which is why lastIndexOf -> indexOf does not
 *     appear in the report at all and he found it by hand.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createMoodMachine } = require('../host/mood-machine');
const start = (m, n) => m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: n } } });

test('KILL C1: a stall reap removes only THAT agent from the stack, not the whole chain', () => {
  // tick() splices "every occurrence, not the last one" for the stalled NAME.
  // Nothing asserts it stops there. If the name test were dropped, one stalled
  // agent would wipe the ENTIRE delegation chain -- every other running agent
  // silently off the roster, which is worse than the bug that loop fixes.
  //
  // Only PostToolUse refreshes the chain, so a later PreToolUse gives the new
  // agent a fresh clock while the old one keeps ageing: that is what lets one
  // name stall while another is demonstrably alive.
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, idleMs: 90_000, stallMs: 600_000, maxInvocationMs: 9_000_000 });
  start(m, 'ghost');                       // its SubagentStop will never arrive
  t += 700_000;                            // past ghost's stall window
  start(m, 'live'); start(m, 'live');      // two live invocations, fresh clock
  assert.deepStrictEqual(m.stack(), ['ghost', 'live', 'live']);

  m.tick();

  assert.strictEqual(m.stateOf('ghost'), 'sleeping', 'the stalled agent is reaped');
  assert.deepStrictEqual(m.stack(), ['live', 'live'],
    'and it must take ONLY its own invocations -- the rest of the chain is still running');
  assert.strictEqual(m.stateOf('live'), 'working');
});

test('KILL C2: a PostToolUse for the Agent tool is processed, not swallowed as a launch', () => {
  // The hook matcher registers Agent for PostToolUse as well as PreToolUse
  // (test/agent-tool-name.test.js pins that), so these events really arrive.
  // The `event === 'PreToolUse'` half of the launch guard is what stops one
  // being mistaken for a launch -- and if it is, the event is dropped entirely
  // and the agent never recovers from a failure.
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, idleMs: 90_000, stallMs: 600_000 });
  start(m, 'paris');

  m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { c: 'boom' }, tool_response: { exit_code: 1 } } });
  assert.strictEqual(m.stateOf('paris'), 'stressed', 'precondition: the failure registered');

  // A successful PostToolUse for the Agent tool must clear it.
  m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_input: { description: 'sub' }, tool_response: {} } });
  assert.strictEqual(m.stateOf('paris'), 'working',
    'a PostToolUse naming the Agent tool must be handled as a result, not swallowed as a launch');
  assert.deepStrictEqual(m.stack(), ['paris'], 'and it must not push a phantom invocation');
});

// isFailure() is the whole of the mood engine's failure detection and its four
// clauses are almost entirely unasserted. Drive it through the public surface.
function moodAfter(response, tool = 'Read') {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t });
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'p' } } });
  m.handle({ event: 'PostToolUse', payload: { tool_name: tool, tool_input: { k: Math.random() }, tool_response: response } });
  return m.stateOf('p');
}

test('KILL D1: a response with NO exit status is success', () => {
  // Read/Grep/Edit/Write responses carry no exit_code at all -- only Bash does.
  for (const ok of [{}, { filePath: 'a.js' }, { stdout: 'hi' }]) {
    assert.strictEqual(moodAfter(ok), 'working', JSON.stringify(ok));
  }
});

test('KILL D2: success:false is a failure even with no exit status', () => {
  assert.strictEqual(moodAfter({ success: false }), 'stressed');
  assert.strictEqual(moodAfter({ success: true }), 'working');
});

test('KILL D3: a non-object response is not a failure', () => {
  for (const v of [null, undefined, 'ok', 0, false]) {
    assert.strictEqual(moodAfter(v), 'working', JSON.stringify(v) ?? 'undefined');
  }
});

test('KILL: a stranded invocation sleeps in the SAME tick, not whenever the idle clock catches up', () => {
  // tick()'s stranded reaper says "Slept immediately". Every existing test
  // reaches the tick with lastActivity already older than idleMs, so the IDLE
  // clock does the sleeping and the stranded reaper's own setState is never
  // the thing under test. Here lastActivity is FRESH at the reaping tick, so
  // only the stranded reaper can produce the sleep.
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, idleMs: 90_000, stallMs: 600_000, maxInvocationMs: 900_000 });
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'a' } } });

  // Work steadily, never silent for longer than idleMs, until past the cap.
  for (let i = 0; i < 16; i++) {
    t += 60_000;
    m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { step: i }, tool_response: { exit_code: 0 } } });
    m.tick();
  }

  assert.ok(t - 1_000_000 > 900_000, 'precondition: the invocation is past its cap');
  assert.deepStrictEqual(m.stack(), [], 'the stranded invocation must leave the stack');
  assert.strictEqual(m.stateOf('a'), 'sleeping',
    'and its card must sleep in that same tick -- the idle clock must not be what does it');
});

test('KILL: SubagentStop ends the YOUNGEST invocation, so the survivor keeps ageing on its own clock', () => {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, idleMs: 90_000, stallMs: 600_000, maxInvocationMs: 900_000 });
  const start = () => m.handle({ event: 'PreToolUse',
    payload: { tool_name: 'Agent', tool_input: { subagent_type: 'dup' } } });
  const post  = () => m.handle({ event: 'PostToolUse',
    payload: { tool_name: 'Bash', tool_input: { x: t }, tool_response: { exit_code: 0 } } });

  start();                 // invocation #1 born at t0
  t += 800_000;            // ... and is now 800s old
  post();
  start();                 // invocation #2 born 800s later
  assert.strictEqual(m.stack().filter(n => n === 'dup').length, 2);

  m.handle({ event: 'SubagentStop', payload: { agent_type: 'dup' } });
  assert.strictEqual(m.stack().filter(n => n === 'dup').length, 1);

  // Which one is left? Advance just past the OLD invocation's 900s cap.
  t += 150_000;            // #1 is now 950s old; #2 only 150s old
  post();                  // keeps lastActivity fresh, so only the CAP can reap
  m.tick();

  assert.deepStrictEqual(m.stack(), [],
    'the survivor must be the OLDER invocation, which has now crossed its cap');
  assert.strictEqual(m.stateOf('dup'), 'sleeping');
});

test('KILL B1: the flash is still held at EXACTLY flashMs, and gone one ms later', () => {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, flashMs: 8_000, idleMs: 90_000 });
  start(m, 'p');
  m.handle({ event: 'SubagentStop', payload: { agent_type: 'p' } });
  assert.strictEqual(m.stateOf('p'), 'happy');
  t += 8_000; m.tick();
  assert.strictEqual(m.stateOf('p'), 'happy', 'at exactly flashMs the flash must still be showing');
  t += 1; m.tick();
  assert.strictEqual(m.stateOf('p'), 'sleeping', 'one ms later it must be gone');
});

test('KILL B2: an agent is still awake at EXACTLY the silence limit, asleep one ms later', () => {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, idleMs: 90_000, stallMs: 600_000, maxInvocationMs: 900_000 });
  start(m, 'p');                      // running -> judged on stallMs
  t += 600_000; m.tick();
  assert.strictEqual(m.stateOf('p'), 'working', 'at exactly stallMs it is not yet stalled');
  t += 1; m.tick();
  assert.strictEqual(m.stateOf('p'), 'sleeping', 'one ms past stallMs it is presumed dead');
});

test('KILL B3: an invocation survives at EXACTLY the cap, and is reaped one ms later', () => {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, idleMs: 90_000, stallMs: 600_000, maxInvocationMs: 900_000 });
  start(m, 'p');
  // Keep it fresh so ONLY the cap can reap it.
  for (let i = 0; i < 15; i++) {
    t += 60_000;
    m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { i }, tool_response: { exit_code: 0 } } });
  }
  t = 1_000_000 + 900_000;            // exactly the cap
  m.tick();
  assert.deepStrictEqual(m.stack(), ['p'], 'at exactly maxInvocationMs the invocation still stands');
  t += 1; m.tick();
  assert.deepStrictEqual(m.stack(), [], 'one ms later it is stranded and reaped');
});
