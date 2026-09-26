'use strict';
/**
 * The model an agent ACTUALLY used, read from its own transcript.
 *
 * MEASURED (2026-09-22) on this project's real transcripts under
 * ~/.claude/projects/<encoded-cwd>/: every assistant line carries
 * `message.model`, one line in this project's history carries the sentinel
 * `<synthetic>` (not a model, must be filtered), and the parent session's own
 * `Agent` tool_input carries an undocumented `model` field that is the model
 * REQUESTED, never the one used -- so identity for "what actually ran" can
 * only come from the subagent's own transcript.
 *
 * Identity (name vs. true agent type) is NOT re-solved here: it is the exact
 * problem host/agent-stats.js already has a tested answer for, and a second
 * walker would be a second place for the "named spawn" defect to hide.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { latestModel, readSessionModel } = require('../host/session-model');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);
const CWD = 'C:/w/proj';
const SYNTHETIC = '<synthetic>';

function project() {
  const projectsDir = tmpDir('cc-session-model-');
  const projectDir = projectDirName(CWD);
  const dir = path.join(projectsDir, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return { projectsDir, projectDir, dir };
}

const assistant = (model, at) => ({
  type: 'assistant',
  timestamp: at,
  message: { model, id: 'msg_' + Math.random().toString(36).slice(2) },
});

function writeSession(dir, sessionId, lines) {
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'),
    lines.map(l => JSON.stringify(l)).join(NL) + NL);
}

function writeSubagent(dir, sessionId, file, meta, lines) {
  const sd = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'),
    lines.map(l => JSON.stringify(l)).join(NL) + NL);
}

// A parent-session Agent tool_use block, the identity source host/agent-stats.js
// already resolves. Mirrors test/agent-stats.test.js's `session()` helper.
function agentSpawn(id, type, name) {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      content: [{
        type: 'tool_use', id, name: 'Agent',
        input: { subagent_type: type, ...(name ? { name } : {}) },
      }],
    },
  };
}

// --- latestModel: pure ------------------------------------------------------

test('latestModel: null for an empty list', () => {
  assert.strictEqual(latestModel([]), null);
});

test('latestModel: skips <synthetic> -- it is not a model', () => {
  const r = latestModel([assistant(SYNTHETIC, '2026-01-01T00:00:00.000Z')]);
  assert.strictEqual(r, null);
});

test('latestModel: skips non-assistant lines', () => {
  const entries = [
    { type: 'cost-state', model: 'claude-opus-5' },
    { type: 'user', message: { model: 'claude-opus-5' } },
    assistant('claude-sonnet-5', '2026-01-01T00:00:01.000Z'),
  ];
  const r = latestModel(entries);
  assert.strictEqual(r.model, 'claude-sonnet-5');
});

test('latestModel: skips assistant lines with no message.model', () => {
  const entries = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'x' } },
    assistant('claude-opus-5', '2026-01-01T00:00:01.000Z'),
  ];
  assert.strictEqual(latestModel(entries).model, 'claude-opus-5');
});

test('latestModel: the LAST matching entry wins, by file order', () => {
  // Not by timestamp -- entries arrive in file order and that order IS the
  // truth, exactly like usage.js's own "one message, one line" reasoning.
  const entries = [
    assistant('claude-opus-5', '2026-01-01T00:00:05.000Z'),
    assistant('claude-sonnet-5', '2026-01-01T00:00:01.000Z'),   // earlier stamp, later in file
  ];
  assert.strictEqual(latestModel(entries).model, 'claude-sonnet-5');
});

test('latestModel: carries the timestamp of the winning entry', () => {
  const r = latestModel([assistant('claude-fable-5-1', '2026-02-02T02:02:02.000Z')]);
  assert.deepStrictEqual(r, { model: 'claude-fable-5-1', at: '2026-02-02T02:02:02.000Z' });
});

test('latestModel: a real model followed by a synthetic one still reports the real one', () => {
  // <synthetic> must never OVERWRITE a genuine answer -- it is not "unknown
  // wins", it is "not a model, skip it".
  const entries = [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    assistant(SYNTHETIC, '2026-01-01T00:00:01.000Z'),
  ];
  assert.strictEqual(latestModel(entries).model, 'claude-opus-5');
});

// property: latestModel never returns <synthetic>, for any mix of junk and
// synthetic-tagged assistant lines.
test('property: latestModel never returns <synthetic>, for any input shape', () => {
  const junk = [
    null, undefined, 42, 'a string', [], {},
    { type: 'assistant' },
    { type: 'assistant', message: null },
    { type: 'assistant', message: {} },
    { type: 'assistant', message: { model: 123 } },
    { type: 'user', message: { model: 'claude-opus-5' } },
  ];
  for (let trial = 0; trial < 200; trial++) {
    const len = 1 + Math.floor(Math.random() * 6);
    const entries = [];
    for (let i = 0; i < len; i++) {
      const pick = Math.random();
      if (pick < 0.4) entries.push(assistant(SYNTHETIC, new Date(i).toISOString()));
      else if (pick < 0.7) entries.push(junk[Math.floor(Math.random() * junk.length)]);
      else entries.push(assistant('claude-real-' + i, new Date(i).toISOString()));
    }
    const r = latestModel(entries);
    if (r) assert.notStrictEqual(r.model, SYNTHETIC, JSON.stringify(entries));
  }
});

// property: null iff no assistant line carries a real model.
test('property: result is null iff no entry is an assistant line with a real model', () => {
  const junk = [
    null, { type: 'cost-state' }, { type: 'assistant' },
    { type: 'assistant', message: { model: SYNTHETIC } },
    { type: 'user', message: { model: 'claude-opus-5' } },
  ];
  for (let trial = 0; trial < 200; trial++) {
    const hasReal = Math.random() < 0.5;
    const len = 1 + Math.floor(Math.random() * 5);
    const entries = [];
    for (let i = 0; i < len; i++) entries.push(junk[Math.floor(Math.random() * junk.length)]);
    if (hasReal) entries.splice(Math.floor(Math.random() * entries.length), 0,
      assistant('claude-real', new Date().toISOString()));
    const r = latestModel(entries);
    assert.strictEqual(r === null, !hasReal, JSON.stringify(entries));
  }
});

// --- readSessionModel: fs ----------------------------------------------------

test('readSessionModel: the main session model is the latest assistant line', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    assistant('claude-sonnet-5', '2026-01-01T00:01:00.000Z'),
  ]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.deepStrictEqual(r.session, { model: 'claude-sonnet-5', at: '2026-01-01T00:01:00.000Z' });
  assert.strictEqual(r.errors, 0);
});

test('readSessionModel: <synthetic> is filtered out of the session model too', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    assistant(SYNTHETIC, '2026-01-01T00:01:00.000Z'),
  ]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, 'claude-opus-5');
});

test('readSessionModel: an ordinary subagent is filed under its TYPE', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.deepStrictEqual(r.agents['code-reviewer'],
    { model: 'claude-opus-5', at: '2026-01-01T00:05:00.000Z' });
});

test('readSessionModel: a NAMED spawn resolves to its TYPE, not its name', async () => {
  // The exact defect host/agent-stats.js exists for -- reused here, not
  // re-derived, so this module cannot get it independently wrong.
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer', 'miguel-review')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'miguel-review', requestShape: 'background' },
    [assistant('claude-fable-5-1', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.ok(!r.agents['miguel-review'], 'must not be filed under the name');
  assert.deepStrictEqual(r.agents['code-reviewer'],
    { model: 'claude-fable-5-1', at: '2026-01-01T00:05:00.000Z' });
});

test('readSessionModel: a name that resolves nowhere is kept as a label, marked unresolved', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', []);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'some-ghost', requestShape: 'background' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.agents['some-ghost'].model, 'claude-opus-5');
  assert.strictEqual(r.agents['some-ghost'].unresolved, true);
});

test('readSessionModel: no assistant line yet is null, never a guessed string', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [{ type: 'user', message: { role: 'user', content: 'go' } }]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, null);
  assert.strictEqual(r.session.at, null);
  assert.ok(!('code-reviewer' in r.agents), 'nothing to report yet is absence, not a row');
});

test('readSessionModel: a session with no subagents is ordinary, not an error', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [assistant('claude-opus-5', '2026-01-01T00:00:00.000Z')]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.errors, 0);
  assert.deepStrictEqual(r.agents, {});
});

test('readSessionModel: a project folder that cannot be read is absence, counted as an error', async () => {
  const { projectsDir, projectDir } = project();
  fs.rmSync(path.join(projectsDir, projectDir), { recursive: true, force: true });
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.errors, 1);
  assert.deepStrictEqual(r.session, { model: null, at: null });
  assert.deepStrictEqual(r.agents, {});
});

test('readSessionModel: a subagent transcript that exists but cannot be OPENED is counted, not swallowed', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const err = new Error('locked');
  err.code = 'EBUSY';
  const openFile = async (file) => {
    if (file.endsWith('.jsonl') && file.includes('subagents')) throw err;
    return fs.promises.open(file, 'r');
  };

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1', openFile });
  assert.strictEqual(r.errors, 1);
  assert.ok(!('code-reviewer' in r.agents), 'a failure must not be reported as absence-of-runs either');
});

test('readSessionModel: a transcript deleted between the listing and the read contributes nothing, not an error', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);
  fs.unlinkSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'));

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.errors, 0);
  assert.ok(!('code-reviewer' in r.agents));
});

test('readSessionModel: no sessionId is absence, never a guess', async () => {
  const { projectsDir, projectDir } = project();
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: null });
  assert.deepStrictEqual(r, { session: { model: null, at: null }, agents: {}, errors: 0 });
});

test('readSessionModel: the model is found even far past a tail-read window', async () => {
  // The module reads only the TAIL of each file (these transcripts run tens of
  // MB). This proves the tail read still lands on a real answer once the file
  // is comfortably past any small internal chunk size, rather than silently
  // reporting null for "the read window missed it".
  const { projectsDir, projectDir, dir } = project();
  const filler = [];
  // A run of plain (non-model-bearing) lines, individually large, so the file
  // crosses any reasonable tail-window boundary well before the real answer.
  for (let i = 0; i < 400; i++) {
    filler.push({ type: 'cost-state', pad: 'x'.repeat(512), i });
  }
  filler.push(assistant('claude-sonnet-5', '2026-01-01T00:09:00.000Z'));
  writeSession(dir, 's1', filler);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, 'claude-sonnet-5');
});

test('readSessionModel: an agent spawned by an agent is still resolved (nested identity)', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'agent-organizer')]);
  writeSubagent(dir, 's1', 'outer', { agentType: 'agent-organizer', toolUseId: 'toolu_1' }, [
    assistant('claude-opus-5', '2026-01-01T00:01:00.000Z'),
    agentSpawn('toolu_9', 'ui-designer', 'ascii-judge'),
  ]);
  writeSubagent(dir, 's1', 'inner', { agentType: 'ascii-judge', requestShape: 'background' },
    [assistant('claude-fable-5-1', '2026-01-01T00:02:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.agents['agent-organizer'].model, 'claude-opus-5');
  assert.strictEqual(r.agents['ui-designer'].model, 'claude-fable-5-1');
  assert.ok(!r.agents['ascii-judge']);
});
