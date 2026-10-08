'use strict';
/**
 * BACKLOG #74 D: the host re-read EVERY transcript of the project on every SubagentStop.
 *
 * Measured on this project (664 MB of transcripts, files up to 60 MB): one readAgentStats pass cost
 * ~5 CPU-seconds and ~600 MB of RSS, and a busy session fires it for every agent that finishes. That is the
 * 743 -> 317 MB swing and the ~23 % of a core the hub measured on the main tab's host.
 *
 * The fix is a per-file memo keyed by (mtime, size). It must change COST and nothing else: the same stats, the
 * same ok/unreadable counts, and a file that changed is re-read.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readAgentStats, createStatsMemo } = require('../host/agent-stats');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);
const CWD = 'C:/w/memo';

function project() {
  const root = tmpDir('cc-agents-memo-');
  const dir = path.join(root, projectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const U = (input, output) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const spawnLine = (i, id, type, name) => JSON.stringify({
  type: 'assistant', timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  message: { usage: U(1, 1), content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: type, ...(name ? { name } : {}) } }] },
});
const turn = (minute, usage, id) => JSON.stringify({
  type: 'assistant', timestamp: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(), message: { id, usage },
});
function writeSession(dir, name, lines) { fs.writeFileSync(path.join(dir, name + '.jsonl'), lines.join(NL) + NL); }
function writeSub(dir, session, file, meta, lines) {
  const sd = path.join(dir, session, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'), lines.join(NL) + NL);
}
// A file's mtime to a value strictly later than any earlier write (filesystems tick coarsely).
function touchLater(file, plusMs = 5000) {
  const t = new Date(Date.now() + plusMs);
  fs.utimesSync(file, t, t);
}

function fixture() {
  const p = project();
  writeSession(p.dir, 's1', [spawnLine(0, 'toolu_1', 'code-reviewer', 'miguel'), spawnLine(1, 'toolu_2', 'logic-reviewer')]);
  writeSub(p.dir, 's1', 'agent-a', { agentType: 'miguel' }, [turn(0, U(10, 5), 'm1'), turn(2, U(20, 5), 'm2')]);
  writeSub(p.dir, 's1', 'agent-b', { toolUseId: 'toolu_2', agentType: 'logic-reviewer' }, [turn(0, U(7, 3), 'm3')]);
  return p;
}

test('a memoised pass returns exactly what an unmemoised pass returns', async () => {
  const p = fixture();
  const plain = await readAgentStats({ cwd: CWD, projectsDir: p.root });
  const memo = createStatsMemo();
  const first = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const second = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.deepStrictEqual(first, plain);
  assert.deepStrictEqual(second, plain);
  assert.strictEqual(plain.agents.length, 2);          // the fixture is not vacuous
});

test('a second pass over unchanged files reads none of them', async () => {
  const p = fixture();
  const memo = createStatsMemo();
  await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const after1 = { ...memo.reads };
  assert.ok(after1.identity >= 1 && after1.transcript >= 1, JSON.stringify(after1));
  await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.deepStrictEqual(memo.reads, after1);
});

test('with no memo, nothing is remembered between passes (the default is unchanged)', async () => {
  const p = fixture();
  const a = await readAgentStats({ cwd: CWD, projectsDir: p.root });
  fs.appendFileSync(path.join(p.dir, 's1', 'subagents', 'agent-a.jsonl'), turn(5, U(100, 100), 'm9') + NL);
  const b = await readAgentStats({ cwd: CWD, projectsDir: p.root });
  assert.ok(b.agents.find(r => r.agent === 'code-reviewer').tokens > a.agents.find(r => r.agent === 'code-reviewer').tokens);
});

test('a subagent transcript that GREW is re-read, and only that one', async () => {
  const p = fixture();
  const memo = createStatsMemo();
  const a = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const before = { ...memo.reads };
  fs.appendFileSync(path.join(p.dir, 's1', 'subagents', 'agent-a.jsonl'), turn(5, U(100, 100), 'm9') + NL);
  const b = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const row = (r) => r.agents.find(x => x.agent === 'code-reviewer');
  assert.strictEqual(row(b).tokens, row(a).tokens + 200);
  assert.strictEqual(memo.reads.transcript, before.transcript + 1);
  assert.strictEqual(memo.reads.identity, before.identity + 1);   // the identity scan reads transcripts too: one file, not all
});

test('an identity that appears in a session that grew is picked up', async () => {
  const p = project();
  writeSession(p.dir, 's1', [spawnLine(0, 'toolu_1', 'code-reviewer')]);
  writeSub(p.dir, 's1', 'agent-n', { agentType: 'miguel' }, [turn(0, U(10, 5), 'm1')]);
  const memo = createStatsMemo();
  const a = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.strictEqual(a.unresolved, 1);                              // "miguel" is only a label so far
  fs.appendFileSync(path.join(p.dir, 's1.jsonl'), spawnLine(1, 'toolu_9', 'code-reviewer', 'miguel') + NL);
  const b = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.strictEqual(b.unresolved, 0);
  assert.deepStrictEqual(b.agents.map(r => r.agent), ['code-reviewer']);
});

test('a same-size rewrite with a newer mtime is a change', async () => {
  const p = fixture();
  const memo = createStatsMemo();
  await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const f = path.join(p.dir, 's1', 'subagents', 'agent-b.jsonl');
  fs.writeFileSync(f, [turn(0, U(9, 3), 'm3')].join(NL) + NL);       // 7 -> 9 input tokens, same byte length
  touchLater(f);
  const b = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.strictEqual(b.agents.find(r => r.agent === 'logic-reviewer').tokens, 12);
});

test('a deleted file is forgotten, so the memo cannot grow past the project', async () => {
  const p = fixture();
  const memo = createStatsMemo();
  await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const sizeBefore = memo.size();
  fs.rmSync(path.join(p.dir, 's1', 'subagents', 'agent-b.jsonl'));
  fs.rmSync(path.join(p.dir, 's1', 'subagents', 'agent-b.meta.json'));
  const b = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.ok(memo.size() < sizeBefore, `${memo.size()} < ${sizeBefore}`);
  assert.strictEqual(b.agents.find(r => r.agent === 'logic-reviewer'), undefined);
});

test('a NAME reused for two types in one session still resolves to neither, memoised or not', async () => {
  const p = project();
  writeSession(p.dir, 's1', [spawnLine(0, 'toolu_1', 'A', 'nm'), spawnLine(1, 'toolu_2', 'B', 'nm'), spawnLine(2, 'toolu_3', 'A', 'nm')]);
  writeSub(p.dir, 's1', 'agent-x', { agentType: 'nm' }, [turn(0, U(1, 1), 'm1')]);
  const memo = createStatsMemo();
  const plain = await readAgentStats({ cwd: CWD, projectsDir: p.root });
  const m1 = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const m2 = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.strictEqual(plain.unresolved, 1);
  assert.deepStrictEqual(m1, plain);
  assert.deepStrictEqual(m2, plain);
});

test('an unreadable transcript is counted on EVERY pass and never remembered as fine', async () => {
  const p = fixture();
  const dirAsFile = path.join(p.dir, 's1', 'subagents', 'agent-dir.jsonl');
  fs.mkdirSync(dirAsFile);                                           // EISDIR on read
  fs.writeFileSync(path.join(p.dir, 's1', 'subagents', 'agent-dir.meta.json'), JSON.stringify({ agentType: 'logic-reviewer' }));
  const memo = createStatsMemo();
  const a = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  const b = await readAgentStats({ cwd: CWD, projectsDir: p.root, memo });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(b.ok, false);
  assert.deepStrictEqual(b, a);
});

test('readTranscript with a memo still treats a VANISHED file as nothing, and an unreadable one as a failure', async () => {
  const { readTranscript } = require('../host/agent-stats');
  const p = project();
  const memo = createStatsMemo();
  assert.strictEqual(await readTranscript(path.join(p.dir, 'gone.jsonl'), memo), null);
  const dirAsFile = path.join(p.dir, 'isdir.jsonl');
  fs.mkdirSync(dirAsFile);
  await assert.rejects(() => readTranscript(dirAsFile, memo), (e) => e && e.code === 'EISDIR');
  assert.strictEqual(memo.size(), 0);
});
