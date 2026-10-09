'use strict';
/**
 * Kill tests for Mortimer's release-gate survivor S23 (2026-10-09): host/agent-stats.js.
 * The per-subagent token sums (`row.input += read.input` -> `-=`, and the same for output, cacheWrite, cacheRead)
 * and the Agent-block prefilter / block-shape checks of scanSpawns, which no test asserted.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readAgentStats, identityTables } = require('../host/agent-stats');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);
const CWD = 'C:/w/proj';

function project() {
  const root = tmpDir('cc-agents-kills-');
  const dir = path.join(root, projectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const U = (input, output, cw, cr) => ({
  input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});

function subagent(dir, sessionName, file, meta, entries) {
  const sd = path.join(dir, sessionName, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'), entries.map(e => JSON.stringify(e)).join(NL) + NL);
}

const turn = (minute, usage) => ({
  type: 'assistant',
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(),
  message: { usage },
});

test('S23: two runs of one subagent type SUM input, output, cacheWrite and cacheRead (each field added, never subtracted)', async () => {
  const { root, dir } = project();
  // Every field differs between the two runs and between fields, so a `-=` on any one of them moves its own figure.
  subagent(dir, 's1', 'a1', { agentType: 'code-reviewer' }, [turn(0, U(10, 1, 100, 1000))]);
  subagent(dir, 's2', 'a2', { agentType: 'code-reviewer' }, [turn(0, U(20, 2, 200, 2000))]);

  const r = await readAgentStats({ cwd: CWD, projectsDir: root });
  assert.strictEqual(r.agents.length, 1);
  const row = r.agents[0];
  assert.strictEqual(row.runs, 2);
  assert.strictEqual(row.input, 30);
  assert.strictEqual(row.output, 3);
  assert.strictEqual(row.cacheWrite, 300);
  assert.strictEqual(row.cacheRead, 3000);
  assert.strictEqual(row.tokens, 3333);
});

// --- scanSpawns: only a real Agent tool_use block with a subagent_type is an identity -------------------------------

async function tablesFor(lines) {
  const { dir } = project();
  const file = path.join(dir, 's1.jsonl');
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join(NL) + NL);
  return identityTables([{ file, session: 's1', subagent: false }]);
}

const withBlocks = (...content) => ({ type: 'assistant', message: { content } });
const agentBlock = (id, type, name) => ({
  type: 'tool_use', id, name: 'Agent', input: { subagent_type: type, ...(name ? { name } : {}) },
});

test('S23: a tool_use of another tool is not an identity, even when it carries a subagent_type', async () => {
  const t = await tablesFor([withBlocks(
    { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { subagent_type: 'X', name: 'bashy' } })]);
  assert.strictEqual(t.byToolUse.has('toolu_bash'), false);
  assert.strictEqual(t.byName.has('bashy'), false);
});

test('S23: a block that is not a tool_use is not an identity, even when it is named Agent', async () => {
  const t = await tablesFor([withBlocks(
    { type: 'text', id: 'toolu_text', name: 'Agent', input: { subagent_type: 'X', name: 'texty' } })]);
  assert.strictEqual(t.byToolUse.has('toolu_text'), false);
  assert.strictEqual(t.byName.has('texty'), false);
});

test('S23: an Agent call with no subagent_type is skipped; one with no input does not lose its neighbours', async () => {
  const t = await tablesFor([withBlocks(
    { type: 'tool_use', id: 'toolu_none', name: 'Agent', input: { name: 'nameless' } },
    { type: 'tool_use', id: 'toolu_noinput', name: 'Agent' },
    agentBlock('toolu_ok', 'code-reviewer'))]);
  assert.strictEqual(t.byToolUse.has('toolu_none'), false);
  assert.strictEqual(t.byToolUse.has('toolu_noinput'), false);
  assert.strictEqual(t.byName.has('nameless'), false);
  assert.strictEqual(t.byToolUse.get('toolu_ok'), 'code-reviewer', 'a block after the bad ones must still be read');
});

test('S23: a null block in the content does not lose the Agent block after it', async () => {
  const t = await tablesFor([withBlocks(null, agentBlock('toolu_after_null', 'ui-designer'))]);
  assert.strictEqual(t.byToolUse.get('toolu_after_null'), 'ui-designer');
});

test('S23: content that is not an array contributes nothing and does not throw', async () => {
  const t = await tablesFor([
    { type: 'assistant', message: { content: { type: 'tool_use', id: 'toolu_obj', name: 'Agent', input: { subagent_type: 'X' } } } },
    { type: 'assistant' },
    agentBlock('toolu_top', 'Y'),   // not under message at all
  ]);
  assert.strictEqual(t.byToolUse.size, 0);
  assert.strictEqual(t.errors, 0);
});

test('S23: several Agent blocks in one line are all recorded; an id-less one is still found by name', async () => {
  const t = await tablesFor([withBlocks(
    agentBlock('toolu_1', 'code-reviewer'),
    { type: 'tool_use', name: 'Agent', input: { subagent_type: 'logic-reviewer', name: 'dexter' } })]);
  assert.strictEqual(t.byToolUse.get('toolu_1'), 'code-reviewer');
  assert.strictEqual(t.byToolUse.size, 1, 'an id-less block adds no tool-use entry');
  assert.strictEqual(t.byName.get('dexter').get('s1'), 'logic-reviewer');
});

test('S23: a line that merely mentions "Agent" or "tool_use" in prose is not parsed into an identity', async () => {
  const t = await tablesFor([
    JSON.stringify({ type: 'user', message: { content: 'the "Agent" ran a "tool_use" yesterday' } }),
    '{"tool_use": "Agent", partial',
  ]);
  assert.strictEqual(t.byToolUse.size, 0);
  assert.strictEqual(t.byName.size, 0);
  assert.strictEqual(t.errors, 0);
});
