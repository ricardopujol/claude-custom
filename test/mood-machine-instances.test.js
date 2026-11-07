'use strict';
/**
 * BACKLOG #142 b: two or more instances of one agent show as separate cards, not "×2" (Ricardo). The mood machine says what each
 * card is: instancesOf(agent) is one row per running instance (and per instance whose finish is still flashing) while there are
 * two or more, and null while there's one card. A row is keyed by the CLI's own id for that run: the spawn's tool_use_id (known
 * from its first event), or the agent_id of a run that came back without a spawn (a resume). Never an index.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createMoodMachine, FLASH_MS } = require('../host/mood-machine');

function rig() {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t });
  const cards = [];
  m.on('cards', (c) => cards.push(c));
  let n = 0;
  const send = (event, payload) => m.handle({ event, payload });
  // A run of `type`: spawned under `key`, then its first call binds its agent_id.
  const spawnRun = (type, key) => {
    const id = 'a' + type + '-' + String(++n).padStart(16, '0');
    send('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type } });
    send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/a' }, agent_id: id, agent_type: type });
    return { id, type, key, by: { agent_id: id, agent_type: type } };
  };
  const err = (run) => send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'x' }, tool_response: { exit_code: 1 }, ...run.by });
  const ok = (run) => send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'c' + n }, tool_response: { exit_code: 0 }, ...run.by });
  return { m, cards, send, spawnRun, err, ok, advance: (ms) => { t += ms; m.tick(); } };
}

const ids = (rows) => rows.map(r => r.id);

test('one running instance is one card: no instance rows', () => {
  const r = rig();
  r.spawnRun('code-reviewer', 'toolu_A');
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null);
  assert.strictEqual(r.m.instancesOf('never-seen'), null);
});

test('two instances of one agent: two rows, keyed by each spawn\'s own tool_use_id, in start order, each with its own state', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  const b = r.spawnRun('code-reviewer', 'toolu_B');
  let rows = r.m.instancesOf('code-reviewer');
  assert.deepStrictEqual(ids(rows), ['toolu_A', 'toolu_B']);
  assert.deepStrictEqual(rows.map(x => x.state), ['working', 'working']);
  r.err(b);
  rows = r.m.instancesOf('code-reviewer');
  assert.deepStrictEqual(rows.map(x => x.state), ['working', 'stressed'], 'only B failed');
  assert.strictEqual(rows[0].cause, undefined, 'a working card carries no cause');
  assert.strictEqual(rows[1].cause, 'A Bash call failed', 'and B says why (#162, per card)');
  r.ok(a);
  assert.strictEqual(r.m.instancesOf('code-reviewer')[1].state, 'stressed', 'A\'s good call is not B\'s');
});

test('a second instance starting is announced, though the name stays working', () => {
  const r = rig();
  r.spawnRun('code-reviewer', 'toolu_A');
  const before = r.cards.length;
  r.spawnRun('code-reviewer', 'toolu_B');
  assert.ok(r.cards.some((c, i) => i >= before && c.agent === 'code-reviewer'));
});

test('one instance finishing: its card flashes happy, then leaves; the other card goes on', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.send('SubagentStop', a.by);
  const rows = r.m.instancesOf('code-reviewer');
  assert.deepStrictEqual(rows.map(x => [x.id, x.state]), [['toolu_A', 'happy'], ['toolu_B', 'working']], 'start order: no card moves when another finishes');
  r.advance(FLASH_MS + 1);
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null, 'one card again once the flash is over');
  assert.strictEqual(r.m.stateOf('code-reviewer'), 'working');
});

test('an instance that finished with errors flashes stressed, with its cause', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.err(a);
  r.ok(a);
  r.send('SubagentStop', a.by);
  const done = r.m.instancesOf('code-reviewer').find(x => x.id === 'toolu_A');
  assert.strictEqual(done.state, 'stressed');
  assert.strictEqual(done.cause, 'A Bash call failed');
});

test('an instance cut off (Esc) leaves at once: nothing to celebrate', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tx', is_interrupt: true, ...a.by });
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null);
});

test('the same agent restarting is one card, its new run\'s, not the old one beside it', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.send('SubagentStop', a.by);
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null, 'one finished run is the name\'s own flash');
  r.spawnRun('code-reviewer', 'toolu_C');          // inside the flash: the new run ends it, as the name's flash does
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null);
  r.advance(FLASH_MS + 1);
  const b = r.spawnRun('code-reviewer', 'toolu_D');
  assert.deepStrictEqual(ids(r.m.instancesOf('code-reviewer')), ['toolu_C', 'toolu_D']);
  r.send('SubagentStop', b.by);
  r.advance(FLASH_MS + 1);
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null);
});

test('a run that came back with no spawn (a resume) is keyed by its own agent_id', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.send('SubagentStop', a.by);
  r.advance(FLASH_MS + 1);
  r.send('PostToolUse', { tool_name: 'SendMessage', tool_use_id: 'sm1', tool_input: { to: a.id, message: 'again' },
    tool_response: { success: true, resumedAgentId: a.id } });
  assert.deepStrictEqual(ids(r.m.instancesOf('code-reviewer')), ['toolu_B', a.id]);
});

test('every live instance appears exactly once, and ids never repeat', () => {
  const r = rig();
  for (const k of ['toolu_1', 'toolu_2', 'toolu_3']) r.spawnRun('qa-expert', k);
  const rows = r.m.instancesOf('qa-expert');
  assert.strictEqual(new Set(ids(rows)).size, 3);
  assert.deepStrictEqual(r.m.stack().filter(x => x === 'qa-expert').length, 3);
});

// ---- PR #239 Dexter 1 (High): when the view collapses to one card, that card is the remaining run's, never a departed run's --------

test('A1: a failed sibling cut off (Esc) leaves the remaining run\'s card as that run is: working, no cause', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.err(a);
  assert.deepStrictEqual(r.m.instancesOf('code-reviewer').map(x => x.state), ['stressed', 'working']);
  r.send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tx', is_interrupt: true, ...a.by });
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null, 'one card again');
  assert.strictEqual(r.m.stateOf('code-reviewer'), 'working', 'B never failed');
  assert.strictEqual(r.m.causeOf('code-reviewer'), null, 'and A\'s failure is not blamed on B');
});

test('A1: a failed sibling that finished, once its flash ends, leaves the remaining run\'s card as that run is', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.err(a);
  r.ok(a);
  r.send('SubagentStop', a.by);
  assert.deepStrictEqual(r.m.instancesOf('code-reviewer').map(x => [x.id, x.state]), [['toolu_A', 'stressed'], ['toolu_B', 'working']]);
  r.advance(FLASH_MS + 1);
  assert.strictEqual(r.m.instancesOf('code-reviewer'), null);
  assert.strictEqual(r.m.stateOf('code-reviewer'), 'working');
  assert.strictEqual(r.m.causeOf('code-reviewer'), null);
});

test('A1: the last run finishing clean flashes happy, though a sibling failed and left before it', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  const b = r.spawnRun('code-reviewer', 'toolu_B');
  r.err(a);
  r.send('SubagentStop', a.by);
  r.advance(FLASH_MS + 1);                       // A's flash is over: B is the one card
  r.send('SubagentStop', b.by);
  assert.strictEqual(r.m.stateOf('code-reviewer'), 'happy', 'B finished clean');
  assert.strictEqual(r.m.causeOf('code-reviewer'), null);
});

test('A1: the remaining run\'s OWN failure still shows on the one card', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  const b = r.spawnRun('code-reviewer', 'toolu_B');
  r.err(b);
  r.send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tx', is_interrupt: true, ...a.by });
  assert.strictEqual(r.m.stateOf('code-reviewer'), 'stressed');
  assert.strictEqual(r.m.causeOf('code-reviewer'), 'A Bash call failed');
});

// ---- PR #239 Dexter 2: adopt() corrects a crosswise binding, and the run's own record moves with its id ------------------------

test('A2: two runs bound crosswise, the completed result swaps them back WITH their own records', () => {
  const r = rig();
  const T = 'code-reviewer';
  const idA = 'acode-reviewer-00000000000000aa', idB = 'acode-reviewer-00000000000000bb';
  r.send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_input: { subagent_type: T } });
  r.send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_B', tool_input: { subagent_type: T } });
  // B speaks first, and fails: first-come binding puts bB on A's record.
  r.send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'x' }, tool_response: { exit_code: 1 }, agent_id: idB, agent_type: T });
  // A speaks, clean, and lands on B's record.
  r.send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a1', tool_input: { command: 'y' }, tool_response: { exit_code: 0 }, agent_id: idA, agent_type: T });
  // A's spawn completes, naming its id, before its SubagentStop.
  r.send('PostToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_input: { subagent_type: T }, tool_response: { status: 'completed', agentId: idA } });
  const rows = r.m.instancesOf(T);
  assert.deepStrictEqual(rows.map(x => [x.id, x.state]), [['toolu_A', 'happy'], ['toolu_B', 'stressed']], 'A finished clean; B is the one that failed');
  assert.strictEqual(rows[1].cause, 'A Bash call failed', 'and B keeps its own cause');
});

// ---- PR #239 Dexter 3 / Miguel Y2: a run resumed inside its own finish flash takes over its card ---------------------------------

const resume = (r, id, key) => r.send('PostToolUse', { tool_name: 'SendMessage', tool_use_id: key, tool_input: { to: id, message: 'again' },
  tool_response: { success: true, resumedAgentId: id } });

test('A3: a run resumed inside its own flash, while a sibling runs, is ONE card: its own, in its place', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.send('SubagentStop', a.by);
  r.advance(1_000);                                   // inside FLASH_MS
  resume(r, a.id, 'sm1');
  const rows = r.m.instancesOf('code-reviewer');
  assert.deepStrictEqual(rows.map(x => [x.id, x.state]), [['toolu_A', 'working'], ['toolu_B', 'working']], 'two runs, two cards; A where it was');
});

test('A3: the resumed run finishing again inside the old flash is still one card, never an id twice', () => {
  const r = rig();
  const a = r.spawnRun('code-reviewer', 'toolu_A');
  r.spawnRun('code-reviewer', 'toolu_B');
  r.send('SubagentStop', a.by);
  r.advance(1_000);
  resume(r, a.id, 'sm1');
  r.send('SubagentStop', a.by);
  const rows = r.m.instancesOf('code-reviewer');
  assert.deepStrictEqual(rows.map(x => [x.id, x.state]), [['toolu_A', 'happy'], ['toolu_B', 'working']]);
});
