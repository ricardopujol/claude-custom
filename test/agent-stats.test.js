'use strict';
/**
 * Per-agent career stats — tokens spent and time worked, per PROJECT.
 *
 * The identity rule is the whole risk here, and it is measured rather than
 * assumed: this project's 14 `code-reviewer` runs were ALSO filed under
 * `miguel-usage`, `miguel-review`, `miguel-merged-settings` and others, because
 * a named spawn puts the NAME in `agentType`. An aggregate that split one
 * agent's career across four strangers would have looked perfectly reasonable.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readAgentStats, resolveAgent } = require('../host/agent-stats');
const { projectDirName } = require('../host/project-dir');

const NL = String.fromCharCode(10);
const CWD = 'C:/w/proj';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agents-'));
  const dir = path.join(root, projectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const U = (input, output, cw = 0, cr = 0) => ({
  input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});

// A parent session whose Agent tool_use blocks are the identity source.
function session(dir, name, spawns) {
  const lines = spawns.map((s, i) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    message: {
      usage: U(1, 1),
      content: [{
        type: 'tool_use', id: s.id, name: 'Agent',
        input: { subagent_type: s.type, ...(s.name ? { name: s.name } : {}) },
      }],
    },
  }));
  fs.writeFileSync(path.join(dir, name + '.jsonl'), lines.join(NL) + NL);
}

// One subagent transcript plus its meta sibling.
function subagent(dir, sessionName, file, meta, entries) {
  const sd = path.join(dir, sessionName, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join(NL) + NL);
}

const turn = (minute, usage) => ({
  type: 'assistant',
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(),
  message: { usage },
});

// --- identity, which is the part that would be silently wrong -----------------

test('an ordinary spawn is filed under its agent type', async () => {
  const { root, dir } = project();
  session(dir, 's1', [{ id: 'toolu_1', type: 'code-reviewer' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [turn(0, U(100, 0)), turn(5, U(50, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents.length, 1);
  assert.strictEqual(r.agents[0].agent, 'code-reviewer');
  assert.strictEqual(r.agents[0].tokens, 150);
});

test('a NAMED spawn is filed under its TYPE, not its name', async () => {
  // THE defect this module exists to avoid. Measured: a named spawn runs as
  // requestShape "background", carries NO toolUseId at all, and puts the name
  // in agentType. Filing by agentType verbatim splits one agent's career.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 'toolu_1', type: 'code-reviewer', name: 'miguel-usage' }]);
  subagent(dir, 's1', 'agent-a',
    { agentType: 'miguel-usage', requestShape: 'background' },   // no toolUseId
    [turn(0, U(100, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents.length, 1);
  assert.strictEqual(r.agents[0].agent, 'code-reviewer', 'the name must not become an agent');
});

test('named and unnamed runs of the same agent are ONE career', async () => {
  // The reason it matters, stated as the aggregate the user actually sees.
  const { root, dir } = project();
  session(dir, 's1', [
    { id: 'toolu_1', type: 'code-reviewer' },
    { id: 'toolu_2', type: 'code-reviewer', name: 'miguel-review' },
    { id: 'toolu_3', type: 'code-reviewer', name: 'miguel-usage' },
  ]);
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);
  subagent(dir, 's1', 'a2', { agentType: 'miguel-review', requestShape: 'background' }, [turn(0, U(20, 0))]);
  subagent(dir, 's1', 'a3', { agentType: 'miguel-usage', requestShape: 'background' }, [turn(0, U(30, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents.length, 1, `split into ${r.agents.map(a => a.agent).join(', ')}`);
  assert.strictEqual(r.agents[0].runs, 3);
  assert.strictEqual(r.agents[0].tokens, 60);
});

test('an agent spawned BY an agent is still resolved', async () => {
  // The inner Agent block lives in the outer agent's transcript, not the
  // session's -- so an identity table built only from session files misses it.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 'toolu_1', type: 'agent-organizer' }]);
  subagent(dir, 's1', 'outer', { agentType: 'agent-organizer', toolUseId: 'toolu_1' }, [
    turn(0, U(10, 0)),
    { type: 'assistant', timestamp: new Date(Date.UTC(2026, 0, 1, 12, 1)).toISOString(),
      message: { usage: U(0, 0), content: [{ type: 'tool_use', id: 'toolu_9', name: 'Agent',
        input: { subagent_type: 'ui-designer', name: 'ascii-judge' } }] } },
  ]);
  subagent(dir, 's1', 'inner', { agentType: 'ascii-judge', requestShape: 'background' }, [turn(0, U(500, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  const names = r.agents.map(a => a.agent).sort();
  assert.deepStrictEqual(names, ['agent-organizer', 'ui-designer']);
});

test('a name that resolves nowhere is kept as a LABEL and reported as such', async () => {
  // Honest degradation: the run happened and its tokens are real, so dropping
  // it would understate the project. But it is a label, not a type, and a
  // caller that cannot tell will draw it beside real agents as a peer.
  const { root, dir } = project();
  session(dir, 's1', []);
  subagent(dir, 's1', 'a1', { agentType: 'some-ghost', requestShape: 'background' }, [turn(0, U(42, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents[0].agent, 'some-ghost');
  assert.strictEqual(r.agents[0].resolved, false);
  assert.strictEqual(r.unresolved, 1);
});

test('resolveAgent prefers the tool-use id over the name', () => {
  // They can disagree if a name is reused across types, and the id is the
  // stronger key -- it identifies THIS spawn rather than a label.
  const tables = {
    byToolUse: new Map([['toolu_1', 'logic-reviewer']]),
    byName: new Map([['dexter', 'code-reviewer']]),
  };
  const r = resolveAgent({ agentType: 'dexter', toolUseId: 'toolu_1' }, tables);
  assert.strictEqual(r.agent, 'logic-reviewer');
  assert.strictEqual(r.source, 'tool-use');
});

// --- the numbers --------------------------------------------------------------

test('tokens are the full breakdown, not just input and output', async () => {
  // Cache reads dominate real transcripts. A "tokens spent" figure that omitted
  // them would understate by orders of magnitude.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer', toolUseId: 't1' },
    [turn(0, U(1, 2, 4, 8))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents[0].tokens, 15);
  assert.strictEqual(r.agents[0].cacheRead, 8);
});

test('time worked sums the gaps between turns, across runs', async () => {
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }, { id: 't2', type: 'code-reviewer' }]);
  // Turns one minute apart, so every gap is well under the idle cap.
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer', toolUseId: 't1' },
    [turn(0, U(1, 0)), turn(1, U(1, 0)), turn(2, U(1, 0))]);
  subagent(dir, 's1', 'a2', { agentType: 'code-reviewer', toolUseId: 't2' },
    [turn(0, U(1, 0)), turn(1, U(1, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents[0].ms, 3 * 60 * 1000, '2 gaps + 1 gap, one minute each');
});

test('an OVERNIGHT idle gap does not become ten hours of work', async () => {
  // The defect real data exposed, pinned. Measured shape: 189 entries, a 641
  // minute span, one 637 minute gap, every other gap under half a minute.
  const { IDLE_GAP_MS } = require('../host/agent-stats');
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'ui-ux-tester' }]);
  subagent(dir, 's1', 'a1', { agentType: 'ui-ux-tester', toolUseId: 't1' },
    [turn(0, U(1, 0)), turn(1, U(1, 0)), turn(641, U(1, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  const ms = r.agents[0].ms;
  assert.ok(ms < 641 * 60 * 1000 / 10, `${ms / 60000} minutes reported for ~1 of work`);
  assert.strictEqual(ms, 60 * 1000 + IDLE_GAP_MS, 'one real minute plus one capped gap');
});

test('a single long gap cannot exceed the cap, however long it is', async () => {
  const { IDLE_GAP_MS } = require('../host/agent-stats');
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer', toolUseId: 't1' },
    [turn(0, U(1, 0)), turn(60 * 24 * 7, U(1, 0))]);        // a week apart

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents[0].ms, IDLE_GAP_MS);
});

test('time never runs backwards, whatever the timestamps say', async () => {
  // Transcripts carry clock skew and entries are not guaranteed ordered. An
  // unsorted scan produces negative gaps that SUBTRACT from the career.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer', toolUseId: 't1' },
    [turn(3, U(1, 0)), turn(0, U(1, 0)), turn(1, U(1, 0))]);   // out of order

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.ok(r.agents[0].ms >= 0, String(r.agents[0].ms));
  assert.strictEqual(r.agents[0].ms, 3 * 60 * 1000, 'sorted: 0->1->3 is 1 + 2 minutes');
});

test('agents are ranked by spend', async () => {
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'small' }, { id: 't2', type: 'big' }]);
  subagent(dir, 's1', 'a1', { agentType: 'small', toolUseId: 't1' }, [turn(0, U(1, 0))]);
  subagent(dir, 's1', 'a2', { agentType: 'big', toolUseId: 't2' }, [turn(0, U(999, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.deepStrictEqual(r.agents.map(a => a.agent), ['big', 'small']);
});

// --- scope and failure --------------------------------------------------------

test('the scope is the PROJECT, spanning every session in the folder', async () => {
  // The whole point of the feature: a career, not a session gauge.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  session(dir, 's2', [{ id: 't2', type: 'code-reviewer' }]);
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer', toolUseId: 't1' }, [turn(0, U(10, 0))]);
  subagent(dir, 's2', 'a2', { agentType: 'code-reviewer', toolUseId: 't2' }, [turn(0, U(20, 0))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents.length, 1);
  assert.strictEqual(r.agents[0].runs, 2);
  assert.strictEqual(r.agents[0].tokens, 30);
});

test('the top-level session itself is not an agent', async () => {
  // Only subagent transcripts are careers. Counting the session would invent an
  // agent that never ran.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.deepStrictEqual(r.agents, []);
});

test('a project that has never run an agent is empty, not an error', async () => {
  const { root, dir } = project();
  session(dir, 's1', []);
  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.agents, []);
});

test('an unknown project is ABSENCE, not an empty roster', async () => {
  const r = await readAgentStats({ cwd: 'C:/never/used', projectsDir: os.tmpdir() });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.agents, []);
});

test('a transcript with no meta still has its tokens counted somewhere or not at all', async () => {
  // Honest limit, asserted so nobody assumes otherwise: with no meta there is
  // no identity, so the run cannot be attributed. It is dropped rather than
  // invented, and that is a deliberate choice.
  const { root, dir } = project();
  session(dir, 's1', []);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'orphan.jsonl'), JSON.stringify(turn(0, U(77, 0))) + NL);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.deepStrictEqual(r.agents, []);
});

test('a career does not double-count a multi-block message', async () => {
  // The same defect as host/usage.js: one message is one API call with one
  // usage figure, but Claude Code writes each content block on its own line and
  // repeats the usage on every one. Measured project-wide at a 44.3% overcount,
  // and an agent's career is read the same way, so it had the same inflation.
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'a1.meta.json'),
    JSON.stringify({ agentType: 'code-reviewer', toolUseId: 't1' }));
  const usage = U(2, 99, 49066, 51634);
  const at = new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString();
  fs.writeFileSync(path.join(sd, 'a1.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'msg_a', usage, content: [{ type: 'thinking' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'msg_a', usage, content: [{ type: 'tool_use' }] } }),
  ].join(NL) + NL);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents[0].tokens, 2 + 99 + 49066 + 51634);
});

test('two distinct messages in one career are both counted', async () => {
  const { root, dir } = project();
  session(dir, 's1', [{ id: 't1', type: 'code-reviewer' }]);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'a1.meta.json'),
    JSON.stringify({ agentType: 'code-reviewer', toolUseId: 't1' }));
  const at = m => new Date(Date.UTC(2026, 0, 1, 12, m)).toISOString();
  fs.writeFileSync(path.join(sd, 'a1.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: at(0), message: { id: 'msg_a', usage: U(10, 0), content: [{ type: 'thinking' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(0), message: { id: 'msg_a', usage: U(10, 0), content: [{ type: 'tool_use' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(1), message: { id: 'msg_b', usage: U(5, 0), content: [{ type: 'text' }] } }),
  ].join(NL) + NL);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents[0].tokens, 15);
});
