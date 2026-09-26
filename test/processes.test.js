'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createProcessTracker } = require('../host/processes');

function harness() {
  let now = 1_000_000;
  const t = createProcessTracker({ now: () => now });
  return {
    t,
    advance(ms) { now += ms; },
    pre(tool, input, id) {
      t.handle({ event: 'PreToolUse', payload: { tool_name: tool, tool_input: input, tool_use_id: id } });
    },
    post(tool, input, id) {
      t.handle({ event: 'PostToolUse', payload: { tool_name: tool, tool_input: input, tool_use_id: id } });
    },
  };
}

test('nothing is running to begin with', () => {
  assert.deepStrictEqual(harness().t.list(), []);
});

test('a started tool call shows as running', () => {
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  const [p] = h.t.list();
  assert.strictEqual(p.tool, 'Bash');
  assert.strictEqual(p.label, 'npm test');
});

test('a finished tool call stops showing', () => {
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  h.post('Bash', { command: 'npm test' }, 'a1');
  assert.deepStrictEqual(h.t.list(), []);
});

test('reports how long each call has been running', () => {
  // The whole point: a GPU job that takes four minutes should visibly be
  // taking four minutes, not silently appear stuck.
  const h = harness();
  h.pre('Bash', { command: 'python generate.py' }, 'a1');
  h.advance(65_000);
  assert.strictEqual(h.t.list()[0].elapsedMs, 65_000);
});

test('tracks several concurrent calls', () => {
  const h = harness();
  h.pre('Bash', { command: 'one' }, 'a1');
  h.pre('Bash', { command: 'two' }, 'a2');
  h.pre('Task', { subagent_type: 'code-reviewer' }, 'a3');
  assert.strictEqual(h.t.list().length, 3);
  h.post('Bash', { command: 'one' }, 'a1');
  assert.deepStrictEqual(h.t.list().map(p => p.label).sort(), ['code-reviewer', 'two']);
});

test('identical concurrent commands are tracked separately', () => {
  // Two runs of the same command are two processes. Keying on the command text
  // would make the first PostToolUse clear both.
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  h.pre('Bash', { command: 'npm test' }, 'a2');
  assert.strictEqual(h.t.list().length, 2);
  h.post('Bash', { command: 'npm test' }, 'a1');
  assert.strictEqual(h.t.list().length, 1);
});

test('falls back to matching by command when no tool_use_id is present', () => {
  // The hook payload shape is not guaranteed to carry an id; losing tracking
  // entirely would be worse than the rare mismatch of same-command calls.
  const h = harness();
  h.pre('Bash', { command: 'npm test' });
  assert.strictEqual(h.t.list().length, 1);
  h.post('Bash', { command: 'npm test' });
  assert.deepStrictEqual(h.t.list(), []);
});

test('a Task is labelled by its agent', () => {
  const h = harness();
  h.pre('Task', { subagent_type: 'mutation-tester' }, 'a1');
  assert.strictEqual(h.t.list()[0].label, 'mutation-tester');
});

test('long commands are truncated for display', () => {
  const h = harness();
  h.pre('Bash', { command: 'x'.repeat(400) }, 'a1');
  assert.ok(h.t.list()[0].label.length <= 80);
});

test('an unmatched PostToolUse does not throw', () => {
  const h = harness();
  h.post('Bash', { command: 'never started' }, 'zz');
  assert.deepStrictEqual(h.t.list(), []);
});

test('longest-running first, so the slow thing is at the top', () => {
  const h = harness();
  h.pre('Bash', { command: 'old' }, 'a1');
  h.advance(30_000);
  h.pre('Bash', { command: 'new' }, 'a2');
  assert.deepStrictEqual(h.t.list().map(p => p.label), ['old', 'new']);
});

test('stale entries are swept so a missed PostToolUse cannot pin one forever', () => {
  // If a hook is dropped the entry would otherwise show as running for the rest
  // of the session, which is worse than showing nothing.
  const h = harness();
  h.pre('Bash', { command: 'lost' }, 'a1');
  h.advance(45 * 60_000);
  h.t.sweep();
  assert.deepStrictEqual(h.t.list(), []);
});

// --- closing a call that never reports its own success -----------------------
// Found 2026-09-25 in a real session: three Bash calls stayed "running" after
// they ended. All three had exited non-zero, and for a failed call Claude Code
// sends PostToolUseFailure -- never PostToolUse. Measured against the real CLI
// by verify/probe-failure-payloads.js, whose capture is the fixture below.

const fs = require('fs');
const path = require('path');
const { STALE_SHOW_MS } = require('../host/processes');

const FIXTURE = path.join(__dirname, 'hooks-real-subagent-failure.fixture.jsonl');
const realStream = () => fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const runningOnly = t => t.list().filter(p => {
  assert.ok(p.state === 'running' || p.state === 'stale', `every entry has a state, got ${p.state}`);
  return p.state === 'running';
});

function ev(event, payload) { return { event, payload }; }

test('a FAILED call is closed by PostToolUseFailure', () => {
  const h = harness();
  h.pre('Bash', { command: 'ls /nope' }, 'f1');
  h.t.handle(ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'ls /nope' }, tool_use_id: 'f1' }));
  assert.deepStrictEqual(h.t.list(), []);
});

test('a running call reports its state as running', () => {
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  assert.strictEqual(h.t.list()[0].state, 'running');
});

test('a subagent stopping closes every call it still has open', () => {
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls x' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls y' }, tool_use_id: 's2', agent_id: 'A' }));
  h.t.handle(ev('SubagentStop', { agent_id: 'A', agent_type: 'code-reviewer' }));
  assert.deepStrictEqual(runningOnly(h.t), []);
});

test('a subagent stopping leaves other agents\' calls and the main session alone', () => {
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'mine' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'theirs' }, tool_use_id: 's2', agent_id: 'B' }));
  h.pre('Bash', { command: 'main' }, 'm1');
  h.t.handle(ev('SubagentStop', { agent_id: 'A' }));
  assert.deepStrictEqual(runningOnly(h.t).map(p => p.label).sort(), ['main', 'theirs']);
});

test('a SubagentStop with no agent_id closes nothing', () => {
  // Without an owner there is no way to know which calls were its; guessing
  // would close a background agent's live command.
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('SubagentStop', {}));
  assert.strictEqual(runningOnly(h.t).length, 1);
});

test('Stop closes the main session\'s open calls', () => {
  const h = harness();
  h.pre('Bash', { command: 'main' }, 'm1');
  h.t.handle(ev('Stop', {}));
  assert.deepStrictEqual(runningOnly(h.t), []);
});

test('Stop does NOT close a background subagent\'s calls', () => {
  // Measured: with a background agent, Stop fires when the PARENT's turn ends,
  // before the agent's own SubagentStop. Its commands are still really running.
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'bg work' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('Stop', {}));
  assert.deepStrictEqual(runningOnly(h.t).map(p => p.label), ['bg work']);
});

test('SessionEnd ends everything, and shows what it ended as stale', () => {
  // Measured (verify/probe-clear-background.js): /clear fires SessionEnd with
  // reason "clear" and KILLS background agents, whose open calls then never
  // close. So every call ends -- visibly, like any other backstop, rather than
  // being wiped (Dexter F3: a wiped call "disappears without ever being stale").
  const h = harness();
  h.pre('Bash', { command: 'main' }, 'm1');
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'bg' }, tool_use_id: 's1', agent_id: 'A' }));
  assert.strictEqual(h.t.handle(ev('SessionEnd', { reason: 'clear' })), 2);
  assert.deepStrictEqual(runningOnly(h.t), []);
  assert.deepStrictEqual(h.t.list().map(p => p.state), ['stale', 'stale']);
});

test('a killed agent\'s SubagentStop after /clear does not revive or double-count its calls', () => {
  // Measured order after /clear: SessionEnd -> SessionStart -> SubagentStop.
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'bg' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('SessionEnd', { reason: 'clear' }));
  assert.strictEqual(h.t.handle(ev('SubagentStop', { agent_id: 'A' })), 0);
  assert.deepStrictEqual(h.t.list().map(p => p.state), ['stale']);
});

test('a call closed by its owner stopping is shown as stale, not silently dropped', () => {
  // Its own close never arrived, which is itself worth seeing: a missed event
  // should be visible, or the next one goes unnoticed like this one did.
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls x' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('SubagentStop', { agent_id: 'A' }));
  const [p] = h.t.list();
  assert.strictEqual(p.state, 'stale');
  assert.strictEqual(p.label, 'ls x');
});

test('a stale entry stops ageing and is swept once shown for its grace period', () => {
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls x' }, tool_use_id: 's1', agent_id: 'A' }));
  h.advance(5_000);
  h.t.handle(ev('SubagentStop', { agent_id: 'A' }));
  h.advance(STALE_SHOW_MS - 1);
  h.t.sweep();
  assert.strictEqual(h.t.list()[0].elapsedMs, 5_000, 'elapsed freezes at the moment it was closed');
  h.advance(2);
  h.t.sweep();
  assert.deepStrictEqual(h.t.list(), []);
});

test('a late real close for a stale entry removes it', () => {
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls x' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('SubagentStop', { agent_id: 'A' }));
  h.t.handle(ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'ls x' }, tool_use_id: 's1', agent_id: 'A' }));
  assert.deepStrictEqual(h.t.list(), []);
});

test('replay: the real hook stream of a failing main + subagent call ends with nothing running', () => {
  const h = harness();
  for (const e of realStream()) {
    if (e.event === 'SessionEnd') break;   // judge the state BEFORE the backstop
    h.t.handle(e);
  }
  assert.deepStrictEqual(h.t.list(), []);
});

test('replay REGRESSION: a subagent Bash call with no end event is not running once the subagent completes', () => {
  // The reported bug's shape, on real payloads: drop the subagent's
  // PostToolUseFailure so its call gets no explicit end event at all.
  const stream = realStream();
  const lost = stream.find(e => e.event === 'PostToolUseFailure' && e.payload.agent_id);
  assert.ok(lost, 'fixture must contain a subagent PostToolUseFailure to drop');
  const h = harness();
  for (const e of stream) {
    if (e === lost) continue;
    if (e.event === 'SubagentStop') {
      assert.strictEqual(runningOnly(h.t).length, 1, 'still running until its agent completes');
    }
    if (e.event === 'SessionEnd') break;
    h.t.handle(e);
  }
  assert.deepStrictEqual(runningOnly(h.t), []);
  assert.deepStrictEqual(h.t.list().map(p => p.state), ['stale']);
});

test('sweep reports how many entries it removed, so the host can announce the falling edge', () => {
  // The host only re-broadcast a NON-empty list, so the sweep that removed the
  // last entry was never announced and its row stayed on screen.
  const h = harness();
  assert.strictEqual(h.t.sweep(), 0);
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('SubagentStop', { agent_id: 'A' }));
  h.advance(STALE_SHOW_MS);
  assert.strictEqual(h.t.sweep(), 1);
});

test('handle reports how many calls a backstop had to end', () => {
  // Each one is a close event that never arrived -- worth a log line.
  const h = harness();
  h.pre('Bash', { command: 'main' }, 'm1');
  assert.strictEqual(h.t.handle(ev('Stop', {})), 1);
  assert.strictEqual(h.t.handle(ev('Stop', {})), 0, 'an already-stale entry is not ended twice');
});

// --- the close-by-label fallback (Dexter F2, Miguel 1) -----------------------

test('a close that carries a tool_use_id never falls back to matching by label', () => {
  // Dexter F2: A is swept at 30 min while still running; A's late close then
  // missed its key, matched by label, and deleted its still-running twin B.
  const h = harness();
  h.pre('Agent', { subagent_type: 'mutation-tester' }, 'A');
  h.advance(5 * 60_000);
  h.pre('Agent', { subagent_type: 'mutation-tester' }, 'B');
  h.advance(25 * 60_000 + 1_000);
  h.t.sweep();                                  // A swept, B still young
  h.advance(60_000);
  h.post('Agent', { subagent_type: 'mutation-tester' }, 'A');
  assert.deepStrictEqual(runningOnly(h.t).map(p => p.label), ['mutation-tester'], 'B is still running');
});

test('the no-id fallback closes a RUNNING entry, not a stale one with the same label', () => {
  // Miguel 1: it deleted the stale entry and left the live one running forever.
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  h.t.handle(ev('Stop', {}));                   // first one -> stale
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'n2' }));
  h.t.handle(ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.deepStrictEqual(runningOnly(h.t), []);
  assert.deepStrictEqual(h.t.list().map(p => p.state), ['stale']);
});

test('the no-id fallback only closes a call of the same owner', () => {
  const h = harness();
  h.t.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 's1', agent_id: 'A' }));
  h.t.handle(ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));   // main session
  assert.strictEqual(runningOnly(h.t).length, 1, 'the main session cannot close agent A\'s call');
});
