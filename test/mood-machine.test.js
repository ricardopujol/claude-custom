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

test('a STALL-REAPED agent stays reaped when an unrelated tool call arrives', () => {
  // Miguel, PR #33 review, R1. Severity: blocker, and a REGRESSION my own FF2
  // fix introduced -- it made the failure permanent rather than temporary.
  //
  // tick() set the state to SLEEPING and left the agent on `stack`. It was
  // therefore still `current()`, so the very next PostToolUse from anywhere
  // attributed to it and revived it to WORKING -- and, being still on the
  // stack, onto the THIRTY MINUTE clock, with every tool call resetting
  // lastActivity. In an active session a crashed subagent would never sleep
  // again. Before FF2 it woke too, but fell asleep ninety seconds later.
  //
  // Measured before the fix:
  //   after stall reap     -> sleeping | stack: ["ghost"]
  //   after any tool call  -> working  | stack: ["ghost"]
  //   200s later           -> working
  const h = harness({ idleMs: 90_000, stallMs: 600_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'ghost' } } });
  h.advance(700_000);
  assert.strictEqual(h.m.stateOf('ghost'), 'sleeping', 'precondition: the stall reap fired');
  assert.deepStrictEqual(h.m.stack(), [],
    'a reaped agent must leave the stack, or it is still `current()`');

  h.post('Bash', { command: 'ls' }, { exit_code: 0 });
  assert.strictEqual(h.m.stateOf('ghost'), 'sleeping',
    'an unrelated tool call must not resurrect an agent presumed dead');
});

test('every instance of a reaped agent leaves the stack, not just the last', () => {
  // The mood record is keyed by agent NAME, so declaring that name stalled
  // declares all of its live invocations stalled. Splicing one occurrence
  // would leave the record sleeping while the name is still `current()` --
  // the same revival R1 describes, one instance further along.
  const h = harness({ idleMs: 90_000, stallMs: 600_000 });
  for (let i = 0; i < 3; i++) {
    h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'ghost' } } });
  }
  assert.strictEqual(h.m.stack().filter(a => a === 'ghost').length, 3);
  h.advance(700_000);
  assert.deepStrictEqual(h.m.stack(), []);
  h.post('Bash', { command: 'ls' }, { exit_code: 0 });
  assert.strictEqual(h.m.stateOf('ghost'), 'sleeping');
});

test('the SHIPPED stall timeout is pinned, not just the injected one', () => {
  // Miguel, R3. Every other FF2 test injects `stallMs`, and host.js:325 calls
  // createMoodMachine() with no options at all -- so `STALL_MS` could be
  // changed from 30 minutes to 30 SECONDS and all 847 tests still passed,
  // shipping FF2's original bug back under a different number.
  //
  // My own test comment named this trap ("StrykerJS generates no mutants for
  // numeric literals") and then did not close it. Naming a blind spot is not
  // covering it.
  let now = 1_000_000;
  const m = createMoodMachine({ now: () => now });          // defaults only
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'paris' } } });

  now += 10 * 60_000;  m.tick();
  assert.strictEqual(m.stateOf('paris'), 'working',
    'ten minutes of thinking must not read as asleep on the shipped default');

  now += 25 * 60_000;  m.tick();
  assert.strictEqual(m.stateOf('paris'), 'sleeping',
    'but the shipped default must still reap a stalled agent');
});

test('the idle clock applies only to an agent that is awake and NOT running', () => {
  // Measured while fixing R1, and worth stating because it is not obvious:
  // no path currently produces that combination. PreToolUse pushes onto the
  // stack; PostToolUse attributes to `current()`, which reads from the stack;
  // SubagentStop pops and hands over to the flash, which sleeps on its own
  // timer. So every awake, non-flashing agent is ON the stack, and the idle
  // branch is unreachable today.
  //
  // It is kept rather than deleted because it is the correct rule for an
  // agent in that state, and removing it would silently make the next path
  // that creates one immortal. This test says plainly which of the two clocks
  // is live, so nobody reads the pair as a working split.
  const h = harness({ idleMs: 90_000, stallMs: 600_000, flashMs: 8_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'a' } } });
  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'a' } });
  assert.deepStrictEqual(h.m.stack(), [], 'a finished agent is off the stack');
  assert.strictEqual(h.m.stateOf('a'), 'happy');

  h.advance(20_000);   // less than idleMs and far less than stallMs
  assert.strictEqual(h.m.stateOf('a'), 'sleeping',
    'it sleeps on the FLASH timer, not on either silence clock');
});

// --- `agents` is keyed by NAME, `stack` by INVOCATION ------------------------
//
// Dexter, PR #33 review, Findings 3-5. His framing, which is the useful part:
// these are not three bugs, they are three symptoms of ONE disagreement. The
// mood record is per agent NAME; the running stack is per INVOCATION; and the
// two diverge the moment the same name is launched twice in parallel, which is
// routine. Fixing any one of them alone leaves the others live and looking
// unrelated.

test('F3: a second instance still running is NOT slept when the first one finishes', () => {
  // THE WORST FINDING OF THE REVIEW: Ricardo's original symptom -- "it appears
  // as sleeping sometimes even though its running" -- survived the fix written
  // for it. The flash branch in tick() `continue`s BEFORE the stack check is
  // reached, so `stack.includes(agent)` never got a vote on any entry carrying
  // a flashUntil. I added the guard at one site and never asked which paths
  // reach it.
  //
  // Measured on the broken code:
  //   two instances  -> stack: ["code-reviewer","code-reviewer"]
  //   one stops      -> happy | stack: ["code-reviewer"]
  //   after flash    -> sleeping   <- instance 2 is demonstrably running
  const h = harness({ flashMs: 8_000, stallMs: 1_800_000, idleMs: 90_000 });
  const start = () => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer' } } });

  start();
  h.advance(1_000); start();
  assert.deepStrictEqual(h.m.stack(), ['code-reviewer', 'code-reviewer']);

  h.advance(4_000);
  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'code-reviewer' } });
  // It does NOT flash: the card belongs to the NAME, and the name has not
  // finished. Flashing here would celebrate a completion that has not happened
  // and then hand over to the sleep path, which is the exact route this bug
  // took. The original version of this test asserted 'happy' here, written
  // before the completion rule existed; deriving the card from remaining
  // invocations makes the stronger statement.
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working',
    'a sibling finishing must not flash-and-sleep a name that is still running');
  assert.deepStrictEqual(h.m.stack(), ['code-reviewer'], 'one instance is still running');

  h.advance(9_000);   // past flashMs
  assert.strictEqual(h.m.stateOf('code-reviewer'), 'working',
    'a name still on the stack is still running and must not be slept by a sibling finishing');
});

test('F3 inverse: the LAST instance finishing does still sleep after its flash', () => {
  // Dexter supplied this one, and it is the half I would have skipped. Without
  // it the fix above can be over-applied into "a flashing agent never sleeps",
  // which breaks the ordinary single-instance case that worked all along.
  const h = harness({ flashMs: 8_000, stallMs: 1_800_000, idleMs: 90_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'solo' } } });
  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'solo' } });
  assert.deepStrictEqual(h.m.stack(), []);
  h.advance(9_000);
  assert.strictEqual(h.m.stateOf('solo'), 'sleeping');
});

test('F4: a second instance does not wipe the first instance\u2019s error count', () => {
  // `PreToolUse` reset `errors = 0` for "a fresh run starts clean" -- but
  // `ensure()` returns the record for the NAME, so launching a parallel
  // instance cleared the failure the first one had already recorded, and its
  // SubagentStop then reported a happy face for a run that failed.
  const h = harness({ flashMs: 8_000 });
  const start = () => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'miguel' } } });

  start();
  h.advance(1_000);
  h.post('Bash', { command: 'x' }, { exit_code: 1 });
  assert.strictEqual(h.m.stateOf('miguel'), 'stressed', 'precondition: the failure registered');

  h.advance(1_000); start();            // a parallel second instance
  h.advance(1_000);
  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'miguel' } });
  assert.strictEqual(h.m.stateOf('miguel'), 'stressed',
    'a run that failed must not report a happy face because a sibling started');
});

test('F5: a parent agent is not reaped while its child is doing the work', () => {
  // Only `current()` -- the innermost agent -- had its clock advanced, so a
  // delegating parent sat silent while its child worked and was reaped as
  // stalled. A live tool call anywhere means the whole delegation chain is
  // alive, so activity advances every agent on the stack.
  const h = harness({ stallMs: 600_000, idleMs: 90_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'paris' } } });
  h.advance(1_000);
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'worker' } } });
  assert.deepStrictEqual(h.m.stack(), ['paris', 'worker']);

  // The child works steadily for well past the parent's stall window.
  for (let i = 0; i < 10; i++) {
    h.advance(100_000);
    h.post('Bash', { command: 'step' + i }, { exit_code: 0 });
  }
  assert.strictEqual(h.m.stateOf('worker'), 'working');
  assert.strictEqual(h.m.stateOf('paris'), 'working',
    'the parent delegated; it is not stalled, it is waiting on its child');
});

// --- an invocation has a lifetime, and nothing refreshes it ------------------
//
// Dexter, PR #33 review, Finding 7 and his warning about my own Finding 5 fix.
// He was right and the fix I had already landed was unsafe:
//
//   "once every stack member's clock is refreshed by any session activity,
//    `t - lastActivity > stallMs` can only fire when the ENTIRE session has
//    been silent for 30 minutes... fix #3 makes never-firing the normal case."
//
// Measured on the shipped code before this commit: agent `a` spawns `b`, `a`'s
// SubagentStop is lost, `b` works for 2,000,000ms. `a` stayed `working` the
// whole time and never left the stack. The stall reap Miguel had just made
// EFFECTIVE was now never FIRED. Two correct-looking fixes, composing into no
// reaper at all -- which is the shape this project's own history keeps
// producing and which neither fix's tests could see alone.
//
// `host/usage.js:14-21` records SubagentStop being dropped 31 times in 35
// events, so a stranded entry is the normal case, not an exotic one.
//
// THE FIX IS DEXTER'S: one refreshable clock cannot answer two questions.
// `lastActivity` answers "is it thinking" and must be refreshable for the
// whole chain. `startedAt` answers "how long has this invocation existed" and
// nothing may refresh it. An invocation gets an absolute cap.

test('a stranded parent is reaped even while its child keeps working', () => {
  // `a` works, its SubagentStop is LOST, then `b` starts and keeps the session
  // busy. Before this fix `a` stayed `working` indefinitely, because the
  // chain-wide lastActivity refresh meant its silence clock could never fire.
  //
  // The two must be separated in TIME for this to isolate anything: agents
  // started a second apart both cross the cap at the same moment, so the first
  // version of this test proved nothing about which clock reaped which.
  const h = harness({ stallMs: 600_000, maxInvocationMs: 900_000 });
  const start = n => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: n } } });

  start('a');
  for (let i = 0; i < 8; i++) {          // a works normally for 800s
    h.advance(100_000);
    h.post('Bash', { i }, { exit_code: 0 });
  }
  start('b');                            // a's stop is lost; b takes over

  for (let i = 0; i < 2; i++) {          // b works; a crosses its cap meanwhile
    h.advance(100_000);
    h.post('Bash', { i }, { exit_code: 0 });
  }

  assert.strictEqual(h.m.stateOf('b'), 'working', 'the live agent must keep working');
  assert.strictEqual(h.m.stateOf('a'), 'sleeping',
    'a stranded invocation is reaped on its own lifetime, whatever else is busy');
  assert.deepStrictEqual(h.m.stack(), ['b'], 'and must leave the stack');
});

test('a LIVE parent is not reaped by the cap while the chain is short-lived', () => {
  // The inverse, so the cap cannot be over-applied into "every orchestration
  // dies at 15 minutes". F5's case must still hold: a parent whose child is
  // working is waiting, not stalled.
  const h = harness({ stallMs: 600_000, maxInvocationMs: 900_000 });
  const start = n => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: n } } });

  start('paris');
  h.advance(60_000);
  start('worker');
  for (let i = 0; i < 5; i++) {          // 500s total, well inside the cap
    h.advance(100_000);
    h.post('Bash', { i }, { exit_code: 0 });
  }
  assert.strictEqual(h.m.stateOf('paris'), 'working',
    'a parent delegating inside the cap is waiting, not stalled');
});

test('startedAt is never refreshed by activity', () => {
  // The property the whole fix rests on. If anything refreshes it, the cap
  // becomes another silence clock and the reaper stops firing again.
  const h = harness({ stallMs: 600_000, maxInvocationMs: 900_000 });
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'solo' } } });
  for (let i = 0; i < 12; i++) {         // continuous work past the cap
    h.advance(100_000);
    h.post('Bash', { i }, { exit_code: 0 });
  }
  assert.strictEqual(h.m.stateOf('solo'), 'sleeping',
    'an invocation older than the cap is reaped even while it is emitting');
  assert.deepStrictEqual(h.m.stack(), []);
});

test('the SHIPPED invocation cap is pinned, not just the injected one', () => {
  // R3's lesson, applied to the new constant in the same commit rather than
  // after the next review. host.js constructs the machine with no options.
  let now = 1_000_000;
  const m = createMoodMachine({ now: () => now });
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'x' } } });
  now += 60 * 60_000;                    // an hour
  m.tick();
  assert.strictEqual(m.stateOf('x'), 'sleeping',
    'the shipped cap must reap an invocation that has run for an hour');
});

// --- per-invocation state: closing the class, not patching it ---------------
//
// Ricardo's call, 2026-09-23, on whether to keep patching symptoms or fix the
// structure: "your call, do what you think is best."
//
// Fixing the structure. One review produced FOUR bugs from this single split --
// a sibling finishing put a running instance to sleep (F3), a second instance
// wiped the first's error count (F4), a parent was reaped while its child
// worked (F5), and the chain-refresh fix for F5 disabled the reaper entirely
// (F7). Vera independently found a fifth on PR #34: the ×N badge asserting
// "running now" from the same stack. Each patch is a guard someone can forget;
// the structure is what stops a sixth.
//
// The rule: RUN-SCOPED facts live on the invocation (when it started, what it
// has broken, what it keeps retrying). NAME-SCOPED facts stay on the card
// (which face is showing). A card's state is DERIVED from its invocations
// rather than trampled by whichever one spoke last.

test('a failure is not cleared by a sibling finishing cleanly', () => {
  // I first wrote this asserting `working`, on the theory that per-INVOCATION
  // error counts were the right structure. They are not, and the failing test
  // is what showed it: errors are name-scoped on purpose, because SubagentStop
  // does not say WHICH instance stopped -- `lastIndexOf` is a guess, as Dexter
  // noted. Attributing a failure to a specific run we cannot identify would
  // let a real failure vanish whenever the guess went the other way.
  //
  // So the conservative rule holds: a name that has recorded a failure keeps
  // showing it until every instance of it has finished. Never hide a failure
  // to make the state tidier.
  const h = harness({ flashMs: 8_000 });
  const start = () => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'miguel' } } });

  start();
  h.advance(1_000);
  h.post('Bash', { x: 1 }, { exit_code: 1 });     // one run fails
  h.advance(1_000);
  start();                                         // a second instance starts
  h.advance(1_000);
  h.post('Bash', { x: 2 }, { exit_code: 0 });      // and succeeds

  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'miguel' } });
  assert.strictEqual(h.m.stateOf('miguel'), 'stressed',
    'the recorded failure survives a sibling finishing cleanly');
  assert.deepStrictEqual(h.m.stack(), ['miguel'], 'and one instance is still running');

  // It must not flash-and-sleep either: the agent has not finished.
  h.advance(20_000);
  assert.notStrictEqual(h.m.stateOf('miguel'), 'sleeping',
    'a still-running agent must not sleep because a sibling finished');
});

test('each instance carries its own lifetime', () => {
  // The property `startedAt` needs in order to mean anything: two runs of one
  // name started an hour apart are two ages, not one.
  const h = harness({ maxInvocationMs: 900_000, stallMs: 600_000 });
  const start = () => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'dup' } } });

  start();
  for (let i = 0; i < 8; i++) { h.advance(100_000); h.post('Bash', { i }, { exit_code: 0 }); }
  start();                                         // a fresh second instance
  h.advance(200_000);                              // instance 1 crosses its cap
  h.m.tick();

  assert.deepStrictEqual(h.m.stack(), ['dup'], 'the old instance is reaped, the young one is not');
  assert.strictEqual(h.m.stateOf('dup'), 'working',
    'and the card stays working, because an instance is still running');
});

test('the card is derived from its invocations, not from whoever spoke last', () => {
  // The general statement. With three running and one finishing, the card must
  // reflect the two that remain.
  const h = harness({ flashMs: 8_000 });
  const start = () => h.m.handle({
    event: 'PreToolUse', payload: { tool_name: 'Agent', tool_input: { subagent_type: 'many' } } });
  start(); h.advance(100); start(); h.advance(100); start();
  assert.strictEqual(h.m.stack().filter(n => n === 'many').length, 3);

  h.m.handle({ event: 'SubagentStop', payload: { agent_type: 'many' } });
  h.advance(20_000);                               // past the flash
  assert.strictEqual(h.m.stateOf('many'), 'working');
  assert.strictEqual(h.m.stack().filter(n => n === 'many').length, 2);
});
