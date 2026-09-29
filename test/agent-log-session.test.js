'use strict';
/**
 * BACKLOG #10, the host half: which transcript belongs to the agent that was
 * clicked, and the frames streamed for it.
 *
 * Real files under a temp projects dir, laid out as Claude Code lays them out
 * (`<projects>/<encoded-cwd>/<session>/subagents/agent-<id>.jsonl` + `.meta.json`).
 * Timers are injected: the tests call `poll()` themselves.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { projectDirName } = require('../host/project-dir');
const { findTranscript, createLogSession } = require('../host/agent-log-session');

const CWD = 'C:/w/proj';
const T = '2026-09-29T12:00:00.000Z';
const NL = '\n';

function project() {
  const root = tmpDir('cc-agent-log-');
  const dir = path.join(root, projectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const textLine = (text, ts = T) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });

// A parent session whose Agent tool_use blocks are the identity source.
function parent(dir, session, spawns) {
  fs.writeFileSync(path.join(dir, session + '.jsonl'), spawns.map(s => JSON.stringify({
    type: 'assistant', timestamp: T,
    message: { content: [{ type: 'tool_use', id: s.id, name: 'Agent', input: { subagent_type: s.type, ...(s.name ? { name: s.name } : {}) } }] },
  })).join(NL) + NL);
}

function subagent(dir, session, id, meta, lines, mtime) {
  const sd = path.join(dir, session, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  const file = path.join(sd, `agent-${id}.jsonl`);
  fs.writeFileSync(path.join(sd, `agent-${id}.meta.json`), JSON.stringify(meta));
  fs.writeFileSync(file, lines.map(l => l + NL).join(''));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

// ---- findTranscript ---------------------------------------------------------

test('a known agent_id resolves to exactly its own file, whatever its type', async () => {
  const { root, dir } = project();
  const want = subagent(dir, 's1', 'abc123', { agentType: 'code-reviewer', toolUseId: 't1' }, [textLine('a')]);
  subagent(dir, 's1', 'zzz999', { agentType: 'code-reviewer', toolUseId: 't2' }, [textLine('b')]);
  const r = await findTranscript({ cwd: CWD, projectsDir: root, agent: 'code-reviewer', agentId: 'abc123' });
  assert.strictEqual(r.file, want);
});

test('an agent_id is matched against real file names, never joined into a path', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'abc', { agentType: 'x' }, [textLine('a')]);
  for (const evil of ['../../etc/passwd', '..\\..\\x', 'abc/../abc', 'ab', 'abc.jsonl']) {
    const r = await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', agentId: evil });
    assert.strictEqual(r.file, null, evil);
  }
});

test('without an id, the MOST RECENT transcript of that agent wins', async () => {
  const { root, dir } = project();
  parent(dir, 's1', [{ id: 't1', type: 'code-reviewer' }, { id: 't2', type: 'code-reviewer' }, { id: 't3', type: 'other' }]);
  subagent(dir, 's1', 'old', { agentType: 'code-reviewer', toolUseId: 't1' }, [textLine('old')], new Date('2026-01-01'));
  const newest = subagent(dir, 's1', 'new', { agentType: 'code-reviewer', toolUseId: 't2' }, [textLine('new')], new Date('2026-06-01'));
  subagent(dir, 's1', 'later', { agentType: 'other', toolUseId: 't3' }, [textLine('x')], new Date('2026-09-01'));
  const r = await findTranscript({ cwd: CWD, projectsDir: root, agent: 'code-reviewer' });
  assert.strictEqual(r.file, newest);
});

test('a NAMED spawn is found under its true type via the existing identity tables', async () => {
  const { root, dir } = project();
  parent(dir, 's1', [{ id: 't1', type: 'code-reviewer', name: 'miguel-usage' }]);
  // Named spawn: no toolUseId, the NAME sits in agentType.
  const file = subagent(dir, 's1', 'named', { agentType: 'miguel-usage', requestShape: 'background' }, [textLine('x')]);
  const r = await findTranscript({ cwd: CWD, projectsDir: root, agent: 'code-reviewer' });
  assert.strictEqual(r.file, file);
});

test('no transcript for that agent is an explicit "no-transcript", never an empty pick', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a', { agentType: 'other' }, [textLine('x')]);
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'nobody' }),
    { file: null, reason: 'no-transcript' });
});

test('a project folder that does not exist is "no-transcript" too', async () => {
  const root = tmpDir('cc-agent-log-');
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x' }),
    { file: null, reason: 'no-transcript' });
});

test('with no projectsDir given it falls back to the same default agent-stats uses, and does not throw', async () => {
  const os = require('os');
  const { defaultProjectsDir } = require('../host/agent-stats');
  assert.strictEqual(defaultProjectsDir(), path.join(os.homedir(), '.claude', 'projects'));
  const r = await findTranscript({ cwd: 'Z:/definitely/not/a/project-' + process.pid, agent: 'nobody' });
  assert.deepStrictEqual(r, { file: null, reason: 'no-transcript' });
});

test('an unreadable meta does not hide the other agents\' transcripts', async () => {
  const { root, dir } = project();
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-bad.jsonl'), textLine('x') + NL);
  fs.writeFileSync(path.join(sd, 'agent-bad.meta.json'), '{not json');
  const good = subagent(dir, 's1', 'good', { agentType: 'x' }, [textLine('y')]);
  assert.strictEqual((await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x' })).file, good);
});

// ---- the session ------------------------------------------------------------

function harness({ invocations = [], root, intervalMs = 750 } = {}) {
  const frames = [];
  const timers = [];
  const state = { invocations };
  const session = createLogSession({
    cwd: CWD, projectsDir: root,
    invocations: () => state.invocations,
    send: f => frames.push(f),
    intervalMs,
    setIntervalFn: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearIntervalFn: t => { t.cleared = true; },
  });
  return { session, frames, timers, state };
}

test('opening an agent with no transcript says so, once, explicitly', async () => {
  const { root } = project();
  const h = harness({ root });
  await h.session.open('ghost');
  assert.deepStrictEqual(h.frames, [{ type: 'agent-log', agent: 'ghost', source: null, reason: 'no-transcript', running: false }]);
  await h.session.poll();
  await h.session.poll();
  assert.strictEqual(h.frames.length, 1, 'the same absence is not re-announced every poll');
});

test('a finished agent: one reset frame with its whole log, done = true', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one'), textLine('two')]);
  const h = harness({ root });
  await h.session.open('rev');
  assert.strictEqual(h.frames.length, 1);
  const f = h.frames[0];
  assert.strictEqual(f.type, 'agent-log');
  assert.strictEqual(f.agent, 'rev');
  assert.strictEqual(f.source, file);
  assert.strictEqual(f.reset, true);
  assert.strictEqual(f.done, true);
  assert.strictEqual(f.running, false);
  assert.deepStrictEqual(f.entries.map(e => e.summary), ['one', 'two']);
  await h.session.poll();
  assert.strictEqual(h.frames.length, 1, 'nothing new, nothing sent');
});

test('a running agent streams what is appended, and a partial line waits for its newline', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'live1', { agentType: 'rev' }, [textLine('first')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'live1' }] });
  await h.session.open('rev');
  assert.strictEqual(h.frames[0].running, true);
  assert.strictEqual(h.frames[0].done, false);

  const second = textLine('second');
  fs.appendFileSync(file, second.slice(0, 15));
  await h.session.poll();
  assert.strictEqual(h.frames.length, 1, 'partial line: no frame');

  fs.appendFileSync(file, second.slice(15) + NL);
  await h.session.poll();
  assert.strictEqual(h.frames.length, 2);
  assert.deepStrictEqual(h.frames[1].entries.map(e => e.summary), ['second']);
  assert.ok(!h.frames[1].reset);
});

test('when the run ends, a final frame says done and the log stays readable', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'live1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'live1' }] });
  await h.session.open('rev');
  h.state.invocations = [];
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.done, true);
  assert.strictEqual(last.running, false);
  assert.deepStrictEqual(last.entries, []);
  assert.ok(!last.reset, 'the same file is not re-fetched and re-sent when its run ends');
});

test('a running agent that has not yet said who it is gets "pending", NOT a previous run\'s log', async () => {
  const { root, dir } = project();
  parent(dir, 's1', [{ id: 't1', type: 'rev' }]);
  subagent(dir, 's1', 'oldrun', { agentType: 'rev', toolUseId: 't1' }, [textLine('from last week')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: null }] });
  await h.session.open('rev');
  assert.deepStrictEqual(h.frames, [{ type: 'agent-log', agent: 'rev', source: null, reason: 'pending', running: true }]);

  // It makes its first call; the host learns the id; the log follows.
  const fresh = subagent(dir, 's1', 'newrun', { agentType: 'rev' }, [textLine('fresh')]);
  h.state.invocations = [{ name: 'rev', agentId: 'newrun' }];
  await h.session.poll();
  const f = h.frames[h.frames.length - 1];
  assert.strictEqual(f.source, fresh);
  assert.strictEqual(f.reset, true);
  assert.deepStrictEqual(f.entries.map(e => e.summary), ['fresh']);
});

test('a bound id whose file is not written yet is pending, and is retried every poll', async () => {
  const { root, dir } = project();
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'late' }] });
  await h.session.open('rev');
  assert.strictEqual(h.frames[0].reason, 'pending');
  const file = subagent(dir, 's1', 'late', { agentType: 'rev' }, [textLine('arrived')]);
  await h.session.poll();
  assert.strictEqual(h.frames[h.frames.length - 1].source, file);
});

test('a file that vanishes mid-stream is reported, not silently frozen', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  fs.unlinkSync(file);
  await h.session.poll();
  const f = h.frames[h.frames.length - 1];
  assert.strictEqual(f.source, null);
  assert.strictEqual(f.reason, 'no-transcript');
});

test('a truncated-and-rewritten file resets the client\'s view', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('a fairly long first line here')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  fs.writeFileSync(file, textLine('z') + NL);
  await h.session.poll();
  const f = h.frames[h.frames.length - 1];
  assert.strictEqual(f.reset, true);
  assert.deepStrictEqual(f.entries.map(e => e.summary), ['z']);
});

test('a big backlog goes out in several frames, the first one a reset, none of them lost', async () => {
  const { root, dir } = project();
  const lines = Array.from({ length: 1200 }, (_, i) => textLine('n' + i));
  subagent(dir, 's1', 'big', { agentType: 'rev' }, lines);
  const h = harness({ root });
  await h.session.open('rev');
  assert.ok(h.frames.length >= 3, `frames: ${h.frames.length}`);
  assert.strictEqual(h.frames[0].reset, true);
  assert.ok(h.frames.slice(1).every(f => !f.reset));
  assert.deepStrictEqual(h.frames.flatMap(f => f.entries).map(e => e.summary), lines.map((_, i) => 'n' + i));
  assert.deepStrictEqual(h.frames.map(f => f.done), h.frames.map((_, i) => i === h.frames.length - 1));
});

test('unknown-line count travels with the frames', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, [JSON.stringify({ type: 'attachment', attachment: { type: 'e' } }), 'garbage', textLine('x')]);
  const h = harness({ root });
  await h.session.open('rev');
  assert.strictEqual(h.frames[0].unknown, 2);
});

test('open starts a poll timer at the given interval; close stops it and further polls send nothing', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, intervalMs: 800, invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  assert.strictEqual(h.timers.length, 1);
  assert.strictEqual(h.timers[0].ms, 800);
  h.session.close();
  assert.strictEqual(h.timers[0].cleared, true);
  fs.appendFileSync(file, textLine('later') + NL);
  const n = h.frames.length;
  await h.session.poll();
  assert.strictEqual(h.frames.length, n);
});

test('opening a second agent replaces the first: one timer live, old frames stop', async () => {
  const { root, dir } = project();
  const a = subagent(dir, 's1', 'a1', { agentType: 'aaa' }, [textLine('x')]);
  subagent(dir, 's1', 'b1', { agentType: 'bbb' }, [textLine('y')]);
  const h = harness({ root, invocations: [{ name: 'aaa', agentId: 'a1' }] });
  await h.session.open('aaa');
  await h.session.open('bbb');
  assert.strictEqual(h.timers.filter(t => !t.cleared).length, 1);
  fs.appendFileSync(a, textLine('more a') + NL);
  await h.session.poll();
  assert.ok(h.frames.every(f => f.agent === 'aaa' ? true : f.agent === 'bbb'));
  assert.strictEqual(h.frames[h.frames.length - 1].agent, 'bbb');
  assert.ok(!h.frames.slice(2).some(f => f.agent === 'aaa'), 'nothing more for the closed agent');
});

test('a poll that is still running is not started again on top of itself', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  await Promise.all([h.session.poll(), h.session.poll(), h.session.poll()]);
  assert.strictEqual(h.frames.length, 1);
});
