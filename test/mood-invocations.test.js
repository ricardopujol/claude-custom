'use strict';
/**
 * Backlog #7: a card is working while its DELEGATED work runs, and stops
 * working the moment that work is over -- including when it is over because
 * the user pressed Esc, the turn ended, or /clear killed it.
 *
 * The machine tracks INVOCATIONS, each with an identity and a parent link,
 * rather than a name-keyed stack whose nesting was implied by order.
 *
 * THE LINKAGE, measured rather than assumed (2026-09-27, from real sessions):
 *   - PreToolUse(Agent) carries the spawn's `tool_use_id`, and the SPAWNER's
 *     `agent_id` when a subagent is the one spawning (none from the main
 *     session).
 *   - Every call the subagent then makes carries ITS `agent_id` + `agent_type`,
 *     and nothing that names the spawn. So the first sighting of an unknown
 *     agent_id binds it to the oldest still-unbound invocation of that type.
 *   - PostToolUse(Agent) for that same tool_use_id carries the real link in
 *     `tool_response.agentId`: at once for a background spawn
 *     (`status: "async_launched"`, `isAsync: true`), at completion for a
 *     foreground one (`status: "completed"`). Claude Code also writes it to
 *     disk as subagents/agent-<agentId>.meta.json `{ toolUseId }`.
 *   - Stop lists still-running background agents in `background_tasks`
 *     `{ id: <agent_id>, agent_type, description, status }` -- and Stop DOES
 *     fire while one is still running (test/hooks-real-subagent-failure).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createMoodMachine } = require('../host/mood-machine');

function harness(opts = {}) {
  let now = 1_000_000;
  const m = createMoodMachine({ now: () => now, ...opts });
  const h = {
    m,
    advance(ms) { now += ms; m.tick(); },
    // A spawn. `by` is the spawner's agent_id; omitted means the main session.
    spawn(type, toolUseId, { by, byType, background, description } = {}) {
      m.handle({ event: 'PreToolUse', payload: {
        tool_name: 'Agent', tool_use_id: toolUseId,
        tool_input: { subagent_type: type, description, ...(background ? { run_in_background: true } : {}) },
        ...(by ? { agent_id: by, agent_type: byType } : {}),
      } });
    },
    // A Bash call made BY a subagent.
    call(agentId, agentType, response = { exit_code: 0 }, input = { command: 'c' + Math.random() }) {
      m.handle({ event: 'PostToolUse', payload: {
        tool_name: 'Bash', tool_input: input, tool_response: response, agent_id: agentId, agent_type: agentType,
      } });
    },
    fail(agentId, agentType, extra = {}) {
      m.handle({ event: 'PostToolUseFailure', payload: {
        tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1', is_interrupt: false,
        ...(agentId ? { agent_id: agentId, agent_type: agentType } : {}), ...extra,
      } });
    },
    subStop(agentId, agentType) {
      m.handle({ event: 'SubagentStop', payload: { agent_id: agentId, agent_type: agentType } });
    },
    busy(name) { return h.m.stack().includes(name); },
    // A MAIN-session call on the current CLI: no agent_id, no agent_type.
    main(response = { exit_code: 0 }, input = { command: 'm' + Math.random() }) {
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: input, tool_response: response } });
    },
    launchedAsync(key, agentId) {
      m.handle({ event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: key,
        tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId } } });
    },
    // The main session messaging an agent: how a finished agent is RESUMED.
    message(to, key = 'sm' + Math.random()) {
      m.handle({ event: 'PreToolUse', payload: { tool_name: 'SendMessage', tool_use_id: key,
        tool_input: { to, summary: 's', message: 'm' } } });
    },
  };
  return h;
}

// --- the parent link ---------------------------------------------------------

test('a subagent stopping ends its foreground children with it', () => {
  // A parent cannot finish while a foreground child it is waiting on still
  // runs, so a child still open when its parent stops had its own
  // SubagentStop dropped (host/usage.js: dropped 31 times in 35). Leaving it
  // open is the "working until the 30 minute stall" bug.
  const h = harness();
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.spawn('worker', 't2', { by: 'p1', byType: 'paris' });
  h.call('w1', 'worker');
  h.subStop('p1', 'paris');
  assert.strictEqual(h.m.stateOf('paris'), 'happy');
  assert.notStrictEqual(h.m.stateOf('worker'), 'working');
  assert.deepStrictEqual(h.m.stack(), []);
});

test('a child working keeps its SILENT parent alive, on the parent link rather than the whole stack', () => {
  const h = harness({ stallMs: 600_000, maxInvocationMs: 9_000_000 });
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.spawn('worker', 't2', { by: 'p1', byType: 'paris' });
  for (let i = 0; i < 10; i++) { h.advance(100_000); h.call('w1', 'worker'); }
  assert.strictEqual(h.m.stateOf('paris'), 'working', 'waiting on a child is not stalling');
  assert.strictEqual(h.m.stateOf('worker'), 'working');
});

test('a subagent\'s calls do NOT keep an unrelated sibling alive', () => {
  // Before, any call refreshed every invocation on the stack, so one busy
  // agent kept a dead sibling "working" until the absolute cap.
  const h = harness({ stallMs: 600_000, maxInvocationMs: 9_000_000 });
  h.spawn('ghost', 't1');
  h.call('g1', 'ghost');
  h.spawn('live', 't2');
  for (let i = 0; i < 10; i++) { h.advance(100_000); h.call('l1', 'live'); }
  assert.strictEqual(h.m.stateOf('ghost'), 'sleeping', 'a silent sibling stalls on its own clock');
  assert.strictEqual(h.m.stateOf('live'), 'working');
});

test('the absolute cap does not reap a parent while its foreground child is still running', () => {
  // A parent is never non-working while a live descendant runs. The child is
  // younger, so its own cap -- or its close -- comes first; the parent goes
  // after it, never before.
  const h = harness({ stallMs: 600_000, maxInvocationMs: 900_000 });
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.advance(500_000);
  h.spawn('worker', 't2', { by: 'p1', byType: 'paris' });
  for (let i = 0; i < 6; i++) { h.advance(100_000); h.call('w1', 'worker'); }   // paris is 1100s old
  assert.strictEqual(h.m.stateOf('paris'), 'working');
  assert.deepStrictEqual(h.m.stack(), ['paris', 'worker']);
  h.subStop('w1', 'worker');
  h.advance(1);
  assert.deepStrictEqual(h.m.stack(), [], 'once the child is gone the stranded parent is reaped');
});

test('a call from an agent that never started here blames nobody', () => {
  // It used to fall back to the top of the stack, stressing whoever was there.
  const h = harness();
  h.spawn('paris', 't1');
  h.call('z9', 'stranger', { exit_code: 1 });
  assert.strictEqual(h.m.stateOf('paris'), 'working');
  assert.deepStrictEqual(h.m.roster().map(r => r.agent), ['paris']);
});

test('parallel siblings of one type are separate invocations; the card works while any is live', () => {
  const h = harness();
  h.spawn('miguel', 't1');
  h.spawn('miguel', 't2');
  h.call('m1', 'miguel');
  h.call('m2', 'miguel');
  h.subStop('m1', 'miguel');
  assert.strictEqual(h.m.stateOf('miguel'), 'working');
  h.subStop('m2', 'miguel');
  assert.strictEqual(h.m.stateOf('miguel'), 'happy');
});

// --- the spawn's own result -------------------------------------------------

test('a foreground spawn\'s completed result closes it even when SubagentStop was dropped', () => {
  const h = harness();
  h.spawn('paris', 't1');
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'paris' },
    tool_response: { status: 'completed', agentId: 'p1', agentType: 'paris' },
  } });
  assert.strictEqual(h.m.stateOf('paris'), 'happy');
  assert.deepStrictEqual(h.m.stack(), []);
});

test('a spawn\'s result is never credited to the agent it spawned', () => {
  // The fixture's PostToolUse(Agent) for a BACKGROUND spawn arrives 6ms after
  // launch. It is the spawner's call, not the child's; attributing it to the
  // top of the stack fed the child's retry counter with its own launch.
  const h = harness();
  h.spawn('paris', 't1');
  for (let i = 0; i < 3; i++) {
    h.m.handle({ event: 'PostToolUse', payload: {
      tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'paris' }, tool_response: { truncated: true } } });
  }
  assert.strictEqual(h.m.stateOf('paris'), 'working');
});

test('a spawn that FAILED ends that invocation, stressed', () => {
  const h = harness();
  h.spawn('paris', 't1');
  h.m.handle({ event: 'PostToolUseFailure', payload: {
    tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'paris' }, error: 'boom', is_interrupt: false } });
  assert.strictEqual(h.m.stateOf('paris'), 'stressed');
  assert.deepStrictEqual(h.m.stack(), []);
});

// --- interrupts: the chain ends, and it is nobody's failure -----------------

test('Esc on a spawn ends that invocation and its descendants, and is not an error', () => {
  const h = harness();
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.spawn('worker', 't2', { by: 'p1', byType: 'paris' });
  h.m.handle({ event: 'PostToolUseFailure', payload: {
    tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'paris' }, error: 'interrupted', is_interrupt: true } });
  assert.strictEqual(h.m.stateOf('paris'), 'sleeping');
  assert.strictEqual(h.m.stateOf('worker'), 'sleeping');
  assert.deepStrictEqual(h.m.stack(), []);
});

test('an interrupted call inside a subagent ends THAT subagent, not its parent', () => {
  const h = harness();
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.spawn('worker', 't2', { by: 'p1', byType: 'paris' });
  h.call('w1', 'worker');
  h.fail('w1', 'worker', { is_interrupt: true });
  assert.strictEqual(h.m.stateOf('worker'), 'sleeping');
  assert.strictEqual(h.m.stateOf('paris'), 'working');
});

test('Dexter #2: PostToolUse interrupted:true ends that CALL, not the run, and is not an error', () => {
  // Dexter's counterexample: a subagent's Bash is killed (a timeout, say),
  // a PostToolUse ARRIVES -- so the agent's turn goes on -- and it carries on
  // working. Real cancellation comes through PostToolUseFailure is_interrupt,
  // Stop, SessionEnd or SubagentStop.
  //
  // Evidence, read-only, 2026-09-27: across every transcript under
  // ~/.claude/projects, 32,137 Bash results carry interrupted:false and NONE
  // carry true. A timed-out command came back as an error string ("Error:
  // Exit code 143 / Command timed out after 2m 0s", the failure path) and an
  // Esc as "[Request interrupted by user for tool use]". Nothing shows the
  // flag means the agent ended, so it doesn't end it.
  const h = harness();
  h.spawn('paris', 't1');
  h.call('p1', 'paris', { stdout: '', stderr: '', interrupted: true });
  assert.strictEqual(h.m.stateOf('paris'), 'working');
  assert.ok(h.busy('paris'), 'the run continues');
  h.call('p1', 'paris');
  h.subStop('p1', 'paris');
  assert.strictEqual(h.m.stateOf('paris'), 'happy', 'and finishes clean: an interrupt was never an error');
});

test('Esc on a MAIN-session call ends the main session\'s foreground chain', () => {
  // A failure with no agent_id is the main session's own call (measured).
  // Esc aborts the whole foreground turn, and Stop does not fire for it.
  const h = harness();
  h.spawn('paris', 't1');
  h.spawn('bg', 't2', { background: true });
  h.fail(null, null, { is_interrupt: true });
  assert.strictEqual(h.busy('paris'), false);
  assert.strictEqual(h.m.stateOf('paris'), 'sleeping');
  assert.strictEqual(h.m.stateOf('bg'), 'working', 'Esc does not kill background work');
});

// --- Stop and SessionEnd ----------------------------------------------------

test('Stop ends every foreground invocation under the main session', () => {
  // The turn is over, so its foreground work is over; one still open lost
  // its close. It finished, so it flashes rather than vanishing.
  const h = harness({ flashMs: 8_000 });
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.spawn('worker', 't2', { by: 'p1', byType: 'paris' });
  h.m.handle({ event: 'Stop', payload: { background_tasks: [] } });
  assert.deepStrictEqual(h.m.stack(), []);
  assert.strictEqual(h.m.stateOf('paris'), 'happy');
  h.advance(8_001);
  assert.strictEqual(h.m.stateOf('paris'), 'sleeping');
  assert.strictEqual(h.m.stateOf('worker'), 'sleeping');
});

test('Stop spares an agent launched with run_in_background, and its own children', () => {
  const h = harness();
  h.spawn('bg', 't1', { background: true });
  h.call('b1', 'bg');
  h.spawn('child', 't2', { by: 'b1', byType: 'bg' });
  h.m.handle({ event: 'Stop', payload: {} });
  assert.strictEqual(h.m.stateOf('bg'), 'working');
  assert.strictEqual(h.m.stateOf('child'), 'working');
});

test('Stop spares an agent its background_tasks list says is still running', () => {
  // Measured: an Agent call with no run_in_background can still be launched
  // async, and Stop then fires with it running. Stop's own list says so.
  const h = harness();
  h.spawn('general-purpose', 't1', { description: 'Run sub-probe commands' });
  h.m.handle({ event: 'Stop', payload: { background_tasks: [
    { id: 'ac76', type: 'subagent', status: 'running', description: 'Run sub-probe commands', agent_type: 'general-purpose' },
  ] } });
  assert.strictEqual(h.m.stateOf('general-purpose'), 'working');
  h.subStop('ac76', 'general-purpose');
  assert.strictEqual(h.m.stateOf('general-purpose'), 'happy', 'and the listed id is now its identity');
});

test('Stop spares a spawn whose own result said async_launched', () => {
  const h = harness();
  h.spawn('bg', 't1');
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'bg' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'b1' } } });
  h.m.handle({ event: 'Stop', payload: {} });
  assert.strictEqual(h.m.stateOf('bg'), 'working');
  h.call('b1', 'bg', { exit_code: 1 });
  assert.strictEqual(h.m.stateOf('bg'), 'stressed', 'its calls are credited to it by the id the result named');
});

test('background work does not keep its parent\'s card working', () => {
  const h = harness({ stallMs: 600_000, maxInvocationMs: 9_000_000 });
  h.spawn('paris', 't1');
  h.call('p1', 'paris');
  h.spawn('bgchild', 't2', { by: 'p1', byType: 'paris', background: true });
  h.subStop('p1', 'paris');
  assert.strictEqual(h.m.stateOf('paris'), 'happy', 'the parent finished; its background child is not its run');
  assert.strictEqual(h.m.stateOf('bgchild'), 'working', 'and the child carries on');
  for (let i = 0; i < 10; i++) { h.advance(100_000); h.call('c1', 'bgchild'); }
  assert.strictEqual(h.m.stateOf('paris'), 'sleeping');
});

test('SessionEnd ends everything, background included', () => {
  // Measured: /clear fires SessionEnd and kills background agents
  // (verify/probe-clear-background.js).
  const h = harness();
  h.spawn('fg', 't1');
  h.spawn('bg', 't2', { background: true });
  h.m.handle({ event: 'SessionEnd', payload: { reason: 'clear' } });
  assert.deepStrictEqual(h.m.stack(), []);
  assert.strictEqual(h.m.stateOf('fg'), 'sleeping');
  assert.strictEqual(h.m.stateOf('bg'), 'sleeping');
});

// --- the real capture, unfiltered ------------------------------------------

test('replay: the real background agent survives the first Stop and ends with its own failure showing', () => {
  const stream = fs.readFileSync(path.join(__dirname, 'hooks-real-subagent-failure.fixture.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const h = harness();
  const seen = [];
  h.m.on('change', c => seen.push(c.agent + ':' + c.state));
  let afterFirstStop = null;
  for (const e of stream) {
    h.m.handle(e);
    if (e.event === 'Stop' && afterFirstStop === null) afterFirstStop = h.m.stateOf('general-purpose');
  }
  assert.strictEqual(afterFirstStop, 'working', 'Stop fired while the background agent still ran');
  assert.deepStrictEqual(seen, ['general-purpose:working', 'general-purpose:stressed',
    'general-purpose:working', 'general-purpose:stressed']);
  assert.deepStrictEqual(h.m.stack(), []);
});

// --- PR #56 review fixes (Dexter) --------------------------------------------

test('Dexter #3: a main-session PostToolUse never touches a background agent', () => {
  // The current CLI sends NO agent_id on every main-session call, so the old
  // current() fallback pinned each one on the youngest open agent.
  for (const [what, send] of [
    ['interrupted', h => h.main({ interrupted: true })],
    ['three identical calls', h => { for (let i = 0; i < 3; i++) h.main({ exit_code: 0 }, { file_path: 'x' }); }],
    ['success:false', h => h.main({ success: false })],
  ]) {
    const h = harness();
    h.spawn('bg', 't1');
    h.launchedAsync('t1', 'b1');
    send(h);
    assert.strictEqual(h.m.stateOf('bg'), 'working', what);
    assert.ok(h.busy('bg'), what);
  }
});

test('Dexter #1: a late agentId "correction" never ends a run bound to a different LIVE agent', () => {
  // His steps 1-7, verbatim. B was spawned second but spoke first, so first-
  // come binding put B's id on A's record (k1). B's SubagentStop then closed
  // k1's record, and k2's completed result -- naming B -- used to re-key the
  // record that is really A's (bound to `a`, live) and finish it, cutting
  // off A's child U too. From then on A was asleep for the rest of its run.
  const h = harness();
  h.spawn('T', 'k1');                                   // run A
  h.spawn('T', 'k2');                                   // run B
  h.call('b', 'T');                                     // B speaks first: crosswise
  h.call('a', 'T');
  h.spawn('U', 'k3', { by: 'a', byType: 'T' });         // A's child
  h.subStop('b', 'T');                                  // B really ended
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 'k2', tool_input: { subagent_type: 'T' },
    tool_response: { status: 'completed', agentId: 'b' } } });
  assert.ok(h.busy('T'), 'A is still running');
  assert.ok(h.busy('U'), 'and so is its child');
  assert.strictEqual(h.m.stateOf('T'), 'working');
  assert.strictEqual(h.m.stateOf('U'), 'working');
  h.subStop('u', 'U');
  h.subStop('a', 'T');
  assert.strictEqual(h.m.stateOf('T'), 'happy', 'A ends on its own SubagentStop');
  assert.deepStrictEqual(h.m.stack(), []);
});

test('Dexter R1: correcting a crosswise pair moves the children with the run, so a live sibling\'s child is not cut off', () => {
  // #1's steps with B's SubagentStop DROPPED (31 times in 35, host/usage.js).
  // Both records are still open when k2's result names `b`, so the ids swap.
  // Children hang on the RUN (they attached through its agent_id), so they
  // must follow the id: finishing k2's record used to take A's child U with
  // it, and U showed asleep for the rest of its run.
  const h = harness();
  h.spawn('T', 'k1');                                   // run A
  h.spawn('T', 'k2');                                   // run B
  h.call('b', 'T');                                     // B speaks first: crosswise
  h.call('a', 'T');
  h.spawn('U', 'k3', { by: 'a', byType: 'T' });         // A's child
  h.spawn('V', 'k4', { by: 'b', byType: 'T' });         // B's child
  // B finishes; its SubagentStop is dropped. Its result names it.
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 'k2', tool_input: { subagent_type: 'T' },
    tool_response: { status: 'completed', agentId: 'b' } } });
  assert.ok(h.busy('T'), 'A is still running');
  assert.ok(h.busy('U'), 'and so is its child');
  assert.strictEqual(h.m.stateOf('U'), 'working');
  assert.ok(!h.busy('V'), "B's child ended with B");
  const invs = h.m.invocations();
  const a = invs.find(i => i.agentId === 'a');
  const u = invs.find(i => i.name === 'U');
  assert.strictEqual(u.parentId, a.id, "U hangs on the record now holding `a`");
  h.call('u', 'U');
  assert.strictEqual(h.m.stateOf('U'), 'working', "U's own calls still reach it");
  h.subStop('a', 'T');
  assert.deepStrictEqual(h.m.stack(), [], 'A ending takes its child with it');
});

test('a result naming a silent run moves the guessed id to the unbound sibling it belongs to', () => {
  // A never speaks; B speaks and first-come binding puts `b` on A's record.
  // A finishes and its SubagentStop is dropped, so k1's result naming `a`
  // is all there is. Nobody holds `a`, but `b` was a guess: it belongs to
  // the unbound sibling. Refusing the result left A working until the stall.
  const h = harness();
  h.spawn('T', 'k1');                                   // run A, silent
  h.spawn('T', 'k2');                                   // run B
  h.call('b', 'T');                                     // lands on k1's record
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 'k1', tool_input: { subagent_type: 'T' },
    tool_response: { status: 'completed', agentId: 'a' } } });
  const invs = h.m.invocations();
  assert.strictEqual(invs.length, 1, 'A is over');
  assert.strictEqual(invs[0].agentId, 'b', 'B keeps its id, on its own record');
  h.subStop('b', 'T');
  assert.deepStrictEqual(h.m.stack(), []);
});

test('a result for a record closed crosswise finishes the run it names, wherever that run now is', () => {
  // A speaks late. B's first call lands on A's record (k1), and B's
  // SubagentStop closes k1. A then speaks, and binds to k2's record. A
  // finishes with its SubagentStop dropped: k1's result names `a`. k1 is
  // tombstoned, but `a` is held by an open record, so that record finishes.
  const h = harness();
  h.spawn('T', 'k1');                                   // run A
  h.spawn('T', 'k2');                                   // run B
  h.call('b', 'T');                                     // crosswise: on k1
  h.subStop('b', 'T');                                  // closes k1
  h.call('a', 'T');                                     // binds k2
  assert.ok(h.busy('T'), 'A is running');
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 'k1', tool_input: { subagent_type: 'T' },
    tool_response: { status: 'completed', agentId: 'a' } } });
  assert.deepStrictEqual(h.m.stack(), [], 'A finished');
  assert.strictEqual(h.m.stateOf('T'), 'happy');
});

test('a late result naming a run that never spoke ends nothing', () => {
  // Nobody holds `a`, and the only open record of its type may be a
  // different live run: a guess here could end it. Left to the reapers.
  const h = harness();
  h.spawn('T', 'k1');
  h.m.handle({ event: 'Stop', payload: { background_tasks: [] } });   // k1 lost its close
  h.spawn('T', 'k2');                                   // a new, live, silent run
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 'k1', tool_input: { subagent_type: 'T' },
    tool_response: { status: 'completed', agentId: 'a' } } });
  assert.ok(h.busy('T'), 'the live run is untouched');
});

test('Dexter #1: a correction naming an id nobody holds does not re-key a run bound to a live id', () => {
  const h = harness();
  h.spawn('T', 'k1');
  h.call('a', 'T');
  h.m.handle({ event: 'PostToolUse', payload: {
    tool_name: 'Agent', tool_use_id: 'k1', tool_input: { subagent_type: 'T' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'zzz' } } });
  assert.strictEqual(h.m.invocations()[0].agentId, 'a', 'a live identity is not overwritten on a guess');
  h.call('a', 'T', { exit_code: 1 });
  assert.strictEqual(h.m.stateOf('T'), 'stressed', 'its calls still reach it');
});

test('Dexter #5: a spawn from an unknown agent is an orphan root, not main-session work', () => {
  // Its spawner is some agent we can't place (reaped, dropped, or the host
  // restarted mid-session) -- NOT the main session, so neither Stop nor a
  // main-session Esc may end it. SessionEnd and the reapers still do.
  const h = harness({ stallMs: 600_000, maxInvocationMs: 900_000 });
  h.spawn('miguel', 't1', { by: 'ghost', byType: 'paris' });
  h.m.handle({ event: 'Stop', payload: { background_tasks: [] } });
  assert.strictEqual(h.m.stateOf('miguel'), 'working', 'Stop spares it');
  h.fail(null, null, { is_interrupt: true });
  assert.ok(h.busy('miguel'), 'so does Esc on the main session');
  h.advance(600_001);
  assert.strictEqual(h.busy('miguel'), false, 'the stall reaper still takes it');
});

test('Dexter #5: a spawn from an ENDED agent is an orphan too, and SessionEnd ends it', () => {
  const h = harness();
  h.spawn('paris', 't1', { background: true });
  h.call('p', 'paris');
  h.subStop('p', 'paris');
  h.spawn('miguel', 't2', { by: 'p', byType: 'paris' });   // a late spawn from p
  h.m.handle({ event: 'Stop', payload: {} });
  assert.ok(h.busy('miguel'));
  h.m.handle({ event: 'SessionEnd', payload: {} });
  assert.deepStrictEqual(h.m.stack(), []);
});

test('Dexter #7: Stop\'s name-only background_tasks match only considers runs Stop would end', () => {
  // X is a silent foreground child of background P; Y is the main session's
  // own miguel, backgrounded with no async_launched result. The listed task
  // is Y's, and only Y is at risk from Stop. The name-only match used to pick
  // X (older), re-key it as `y`, and finish Y while it ran.
  const h = harness();
  h.spawn('paris', 't1', { background: true });
  h.call('p', 'paris');
  h.spawn('miguel', 'tX', { by: 'p', byType: 'paris' });    // X
  h.spawn('miguel', 'tY');                                  // Y
  h.m.handle({ event: 'Stop', payload: { background_tasks: [
    { id: 'y', type: 'subagent', status: 'running', agent_type: 'miguel' }] } });
  assert.deepStrictEqual(h.m.stack(), ['paris', 'miguel', 'miguel'], 'Y is spared, and so is X');
  const x = h.m.invocations().find(i => i.key === 'tX');
  assert.strictEqual(x.agentId, null, 'X keeps its own identity');
  assert.strictEqual(x.background, false);
});

test('Dexter #7: an ambiguous name-only match binds nobody', () => {
  const h = harness();
  h.spawn('miguel', 't1');
  h.spawn('miguel', 't2');
  h.m.handle({ event: 'Stop', payload: { background_tasks: [
    { id: 'y', type: 'subagent', status: 'running', agent_type: 'miguel' }] } });
  // Neither can be told apart, so neither is re-keyed as `y`; a later call
  // from `y` finds no run to take over.
  h.call('y', 'miguel', { exit_code: 1 });
  assert.notStrictEqual(h.m.stateOf('miguel'), 'stressed');
});

test('Dexter #8 / Miguel M1: bookkeeping stays bounded over a long-lived host', () => {
  const h = harness();
  for (let i = 0; i < 3000; i++) {
    h.spawn('miguel', 'k' + i);
    h.call('a' + i, 'miguel');
    h.subStop('a' + i, 'miguel');
  }
  h.spawn('paris', 'open1');
  const b = h.m.bookkeeping();
  assert.strictEqual(b.spawns, 1, 'only the open spawn is kept');
  assert.ok(b.endedKeys <= 1024, `endedKeys ${b.endedKeys}`);
  assert.ok(b.endedIds <= 1024, `endedIds ${b.endedIds}`);
  h.m.handle({ event: 'SessionEnd', payload: {} });
  assert.strictEqual(h.m.bookkeeping().spawns, 0, 'SessionEnd clears it');
});

test('Dexter #8: a repeated tool_use_id never opens a second run', () => {
  const h = harness();
  h.spawn('miguel', 'k1');
  h.spawn('miguel', 'k1');                                // duplicate delivery
  assert.deepStrictEqual(h.m.stack(), ['miguel']);
  h.call('a', 'miguel');
  h.subStop('a', 'miguel');
  h.spawn('miguel', 'k1');                                // echo after it ended
  assert.deepStrictEqual(h.m.stack(), [], 'the ended spawn is remembered, not reopened');
});

test('Dexter #4: a duplicate SubagentStop for an ended id does not end a silent sibling', () => {
  const h = harness();
  h.spawn('miguel', 't1');
  h.spawn('miguel', 't2');
  h.call('a', 'miguel');               // A speaks; B has not yet
  h.subStop('a', 'miguel');
  h.subStop('a', 'miguel');            // the duplicate
  assert.deepStrictEqual(h.m.stack(), ['miguel']);
  assert.strictEqual(h.m.stateOf('miguel'), 'working');
  h.call('b', 'miguel');
  h.subStop('b', 'miguel');
  assert.strictEqual(h.m.stateOf('miguel'), 'happy', 'B keeps its own identity to the end');
});

test('Dexter #4: a late call from an ended agent is ignored, not bound to a sibling', () => {
  const h = harness();
  h.spawn('miguel', 't1');
  h.spawn('miguel', 't2');
  h.call('a', 'miguel');
  h.subStop('a', 'miguel');
  h.call('a', 'miguel', { exit_code: 1 });   // late
  assert.strictEqual(h.m.stateOf('miguel'), 'working', 'nobody is blamed for a run that has ended');
  assert.strictEqual(h.m.invocations()[0].agentId, null, 'and the sibling is still unbound');
});

test('Dexter #3: a main-session failure does not stress a foreground subagent on the current CLI', () => {
  const h = harness();
  h.spawn('paris', 't1');
  h.call('p1', 'paris');               // this CLI says whose calls are whose
  h.main({ exit_code: 1 });
  assert.strictEqual(h.m.stateOf('paris'), 'working');
});

// Ricardo's hand check of PR #63, 2026-09-29, replayed: a background spawn that
// made no tool calls, its id arriving only with the async launch result, then
// SubagentStop. The agent log asks the machine whether it watched that run end.
test('watchedEnd: true only for a run this machine saw end, by its agent_id', () => {
  const h = harness();
  h.spawn('general-purpose', 'k1', { background: true });
  h.launchedAsync('k1', 'a5f');
  assert.strictEqual(h.m.watchedEnd('a5f'), false, 'still running: not ended');
  h.subStop('a5f', 'general-purpose');
  assert.strictEqual(h.m.watchedEnd('a5f'), true);
  assert.strictEqual(h.m.watchedEnd('someone-else'), false);
  assert.strictEqual(h.m.watchedEnd(undefined), false);
});

// --- a finished agent RESUMED with SendMessage ---------------------------------
// Ricardo's hand check of PR #66, 2026-09-29, replayed from the host log and the
// session transcript: one Agent spawn, then two SendMessage calls to the same
// agent_id. No Agent call marks the resumes; its calls and SubagentStop carry
// the old id, which used to be dropped as a late echo of the ended run.

function endedRun(h, type = 'general-purpose', id = 'a6c') {
  h.spawn(type, 'k1', { background: true });
  h.launchedAsync('k1', id);
  h.subStop(id, type);
  h.advance(10_000);                   // past the happy flash: asleep
  return id;
}

test('resume: a message to an ended agent_id is a new run of that agent, working until its SubagentStop', () => {
  const h = harness();
  const id = endedRun(h);
  assert.notStrictEqual(h.m.stateOf('general-purpose'), 'working');
  h.message(id);
  assert.strictEqual(h.m.stateOf('general-purpose'), 'working');
  assert.deepStrictEqual(h.m.stack(), ['general-purpose']);
  assert.strictEqual(h.m.invocations()[0].agentId, id, 'bound to the resumed id at once');
  assert.strictEqual(h.m.watchedEnd(id), false, 'running again, so not ended');
  h.subStop(id, 'general-purpose');
  assert.deepStrictEqual(h.m.stack(), []);
  assert.strictEqual(h.m.watchedEnd(id), true);
});

test('resume: the resumed run\'s calls are its own, not dropped as a late echo', () => {
  const h = harness();
  const id = endedRun(h);
  h.message(id);
  h.call(id, 'general-purpose', { exit_code: 1, stderr: 'boom' });
  assert.strictEqual(h.m.stateOf('general-purpose'), 'stressed', 'the failure lands on the resumed run');
});

test('resume: it is background work, so the main turn ending does not end it', () => {
  const h = harness();
  const id = endedRun(h);
  h.message(id);
  h.m.handle({ event: 'Stop', payload: {} });
  assert.deepStrictEqual(h.m.stack(), ['general-purpose']);
});

test('resume: a message to a run that is still going changes nothing', () => {
  const h = harness();
  h.spawn('general-purpose', 'k1', { background: true });
  h.launchedAsync('k1', 'live');
  h.message('live');
  assert.deepStrictEqual(h.m.stack(), ['general-purpose'], 'no second instance');
});

test('resume: a message to an id this host never saw end is not a run', () => {
  const h = harness();
  h.message('stranger');
  h.message('');
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'SendMessage', tool_use_id: 'x', tool_input: {} } });
  assert.deepStrictEqual(h.m.stack(), []);
});

test('resume: the same SendMessage delivered twice is one run', () => {
  const h = harness();
  const id = endedRun(h);
  h.message(id, 'same');
  h.message(id, 'same');
  assert.deepStrictEqual(h.m.stack(), ['general-purpose']);
});

test('resume: an agent spawned with a NAME is resumed by that name', () => {
  const h = harness();
  h.m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'k1',
    tool_input: { subagent_type: 'code-reviewer', name: 'miguel', run_in_background: true } } });
  h.launchedAsync('k1', 'm1');
  h.subStop('m1', 'code-reviewer');
  h.message('miguel');
  assert.deepStrictEqual(h.m.stack(), ['code-reviewer']);
  assert.strictEqual(h.m.invocations()[0].agentId, 'm1');
});
