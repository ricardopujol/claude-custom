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
const { findTranscript, createLogSession, MAX_FRAMES_PER_POLL } = require('../host/agent-log-session');

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

function harness({ invocations = [], root, intervalMs = 750, read, find, now, openTail } = {}) {
  const frames = [];
  const timers = [];
  const state = { invocations };
  const session = createLogSession({
    cwd: CWD, projectsDir: root, read, find, now, openTail,
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

test('an agent found by name: one reset frame with its whole log, untracked and never claimed finished', async () => {
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
  assert.strictEqual(f.done, false);
  assert.strictEqual(f.tracked, false);
  assert.strictEqual(f.running, false);
  assert.deepStrictEqual(f.entries.map(e => e.summary), ['one', 'two']);
  await h.session.poll();
  assert.strictEqual(h.frames.length, 1, 'nothing new, nothing sent');
});

// ---- Dexter F4, PR #63: "finished" is only said about a run this host watched end ----

test('F4: a transcript picked by name that another host is still writing is never "finished"', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'r2', { agentType: 'rev' }, [textLine('one')]);
  const h = harness({ root });                    // this host has no invocation of rev
  await h.session.open('rev');
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(file, textLine('more' + i) + NL);
    await h.session.poll();
  }
  assert.strictEqual(h.frames.length, 4, 'every new line still streams');
  assert.ok(h.frames.every(f => f.done === false && f.tracked === false), JSON.stringify(h.frames.map(f => [f.done, f.tracked])));
});

test('F4: a run this host watched end is "finished" on the first poll that brings nothing new', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'live1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'live1' }] });
  await h.session.open('rev');
  assert.strictEqual(h.frames[0].tracked, true);
  h.state.invocations = [];
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.done, true);
  assert.strictEqual(last.tracked, true);
});

test('F4: a run the stall reaper ended that KEEPS WRITING goes back to not-finished with its next line', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'live1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: 'live1' }] });
  await h.session.open('rev');
  h.state.invocations = [];                       // reaped
  await h.session.poll();
  assert.strictEqual(h.frames[h.frames.length - 1].done, true);
  fs.appendFileSync(file, textLine('still going') + NL);
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.deepStrictEqual(last.entries.map(e => e.summary), ['still going']);
  assert.strictEqual(last.done, false, 'new entries arriving are not "finished"');
  await h.session.poll();
  assert.strictEqual(h.frames[h.frames.length - 1].done, true, 'and it settles once it goes quiet');
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

test('a running agent that has not yet said who it is gets "unidentified", NOT a previous run\'s log', async () => {
  const { root, dir } = project();
  parent(dir, 's1', [{ id: 't1', type: 'rev' }]);
  subagent(dir, 's1', 'oldrun', { agentType: 'rev', toolUseId: 't1' }, [textLine('from last week')]);
  const h = harness({ root, invocations: [{ name: 'rev', agentId: null }] });
  await h.session.open('rev');
  assert.deepStrictEqual(h.frames, [{ type: 'agent-log', agent: 'rev', source: null, reason: 'unidentified', running: true }]);

  // It makes its first call; the host learns the id; the log follows.
  const fresh = subagent(dir, 's1', 'newrun', { agentType: 'rev' }, [textLine('fresh')]);
  h.state.invocations = [{ name: 'rev', agentId: 'newrun' }];
  await h.session.poll();
  const f = h.frames[h.frames.length - 1];
  assert.strictEqual(f.source, fresh);
  assert.strictEqual(f.reset, true);
  assert.deepStrictEqual(f.entries.map(e => e.summary), ['fresh']);
});

test('F5: a live run whose file is not on disk yet is "pending" even if last week\'s run was found by name first', async () => {
  const { root, dir } = project();
  const old = subagent(dir, 's1', 'old', { agentType: 'rev' }, [textLine('last week')]);
  const find = async ({ agentId }) => (agentId ? { file: null, reason: 'no-transcript' } : { file: old });
  const h = harness({ root, find });
  await h.session.open('rev');                    // idle: found by name
  assert.strictEqual(h.frames[0].source, old);
  h.state.invocations = [{ name: 'rev', agentId: 'b' }];   // a new run binds an id before its file exists
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.source, null);
  assert.strictEqual(last.reason, 'pending', 'not "no-transcript" under a live card');
  assert.strictEqual(last.running, true);
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
  assert.ok(h.frames.every(f => f.done === false), 'found by name: never claimed finished');
});

test('M1: opening a LARGE finished transcript reads its end: bounded frames, the skipped part said, newest line delivered', async () => {
  const { root, dir } = project();
  const N = 75000;                                 // ~8 MB, an order of magnitude past the tail window
  const chunk = [];
  for (let i = 0; i < N; i++) chunk.push(textLine('row ' + i));
  const file = subagent(dir, 's1', 'huge', { agentType: 'rev' }, chunk);
  const size = fs.statSync(file).size;
  assert.ok(size > 8 * agentLog.TAIL_BYTES, `fixture is ${size} bytes`);

  const h = harness({ root });
  await h.session.open('rev');
  assert.ok(h.frames.length <= MAX_FRAMES_PER_POLL, `first tick sent ${h.frames.length} frames`);
  assert.strictEqual(h.frames[0].reset, true);
  assert.ok(h.frames[0].skippedBytes > 0 && h.frames[0].skippedBytes < size);
  assert.strictEqual(h.frames.filter(f => f.done).length, 0, 'not finished while more remains');

  for (let i = 0; i < 20; i++) await h.session.poll();      // let the rest of the TAIL drain
  const entries = h.frames.flatMap(f => f.entries);
  assert.strictEqual(entries[entries.length - 1].summary, 'row ' + (N - 1), 'the newest line is delivered');
  const budget = Math.ceil(agentLog.TAIL_BYTES / (size / N) / 500) + 2;
  assert.ok(h.frames.length <= budget, `${h.frames.length} frames for a ${agentLog.TAIL_BYTES}-byte tail (budget ${budget})`);
  assert.ok(entries.length < N / 8, 'nowhere near the whole history');
  const first = Number(entries[0].summary.slice(4));
  assert.strictEqual(entries.length, N - first, 'a contiguous run up to the end');
  // The reducer says what was skipped.
  const m = reduce('rev', h.frames);
  assert.ok(m.skippedBytes > 0);
});

test('S2: an idle log is looked at every 3 s, a running one every tick', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('x')]);
  let reads = 0;
  const read = (s, o) => { reads++; return agentLog.readMore(s, o); };
  let t = 1_000_000;

  // Not running: idle once caught up.
  const idle = harness({ root, read, now: () => t });
  await idle.session.open('rev');
  assert.strictEqual(reads, 1);
  t += 750;
  await idle.timers[0].fn();                     // the open read brought entries: not idle yet, so this reads
  assert.strictEqual(reads, 2);
  for (let i = 0; i < 3; i++) { t += 750; await idle.timers[0].fn(); }
  assert.strictEqual(reads, 2, 'now idle: ticks inside the 3 s interval do not read');
  t += 750;                                      // 3 s since the last read
  await idle.timers[0].fn();
  assert.strictEqual(reads, 3, 'after 3 s it looks once');
  idle.session.close();

  // Running: every tick reads.
  reads = 0;
  const live = harness({ root, read, now: () => t, invocations: [{ name: 'rev', agentId: 'a1' }] });
  await live.session.open('rev');
  const r0 = reads;
  for (let i = 0; i < 3; i++) { t += 750; await live.timers[0].fn(); }
  assert.strictEqual(reads, r0 + 3);
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

// ---- Dexter F3, PR #63: a search that could not look is never "nothing on disk" ----

test('F3: an unlistable subagents folder is unreadable, in name mode and in id mode', async () => {
  const { root } = project();
  const listFiles = async () => ({ files: [], errors: 1 });
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', listFiles }),
    { file: null, reason: 'unreadable' });
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', agentId: 'zz', listFiles }),
    { file: null, reason: 'unreadable' });
});

test('F3: a project folder that exists but cannot be listed is unreadable; one that is not there is not', async () => {
  const { root } = project();                     // the project folder exists
  const listFiles = async () => ({ files: null, errors: 0 });
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', listFiles }),
    { file: null, reason: 'unreadable' });
  const empty = tmpDir('cc-agent-log-');          // no project folder at all
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: empty, agent: 'x', listFiles }),
    { file: null, reason: 'no-transcript' });
});

test('F3: a corrupt meta beside the only candidate is unreadable, not "no transcript"', async () => {
  const { root, dir } = project();
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-only.jsonl'), textLine('x') + NL);
  fs.writeFileSync(path.join(sd, 'agent-only.meta.json'), '{not json');
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x' }),
    { file: null, reason: 'unreadable' });
  // Valid JSON that is not an object carries no identity either.
  fs.writeFileSync(path.join(sd, 'agent-only.meta.json'), 'null');
  assert.strictEqual((await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x' })).reason, 'unreadable');
});

test('F3: identity tables that could not read a parent session make the miss unreadable', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'other' }, [textLine('x')]);
  const tablesFor = async () => ({ byToolUse: new Map(), byName: new Map(), errors: 1 });
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', tablesFor }),
    { file: null, reason: 'unreadable' });
});

test('R2-3: a pick made while part of the search was blind carries `blind`; a clean pick does not', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'x' }, [textLine('x')]);
  const blindList = async (d) => { const r = await require('../host/transcripts').transcriptFiles(d); return { ...r, errors: 1 }; };
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', listFiles: blindList }),
    { file, blind: true });
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x' }), { file });
  // An exact id is exact: blindness elsewhere does not make it a guess.
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x', agentId: 'a1', listFiles: blindList }), { file });
});

test('R2-3: the session passes `blind` to the window, which qualifies "latest run"', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('x')]);
  const h = harness({ root, find: async () => ({ file, blind: true }) });
  await h.session.open('rev');
  assert.strictEqual(h.frames[0].blind, true);
  assert.match(display.renderAgentLog(reduce('rev', h.frames)), /latest run found \(search incomplete\)/);
  const clean = harness({ root, find: async () => ({ file }) });
  await clean.session.open('rev');
  assert.strictEqual(clean.frames[0].blind, false);
});

test('F3: a transcript with no meta at all is ordinary -- it does not make an honest miss "unreadable"', async () => {
  const { root, dir } = project();
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-nometa.jsonl'), textLine('x') + NL);
  assert.deepStrictEqual(await findTranscript({ cwd: CWD, projectsDir: root, agent: 'x' }),
    { file: null, reason: 'no-transcript' });
});

test('F3: the session says "unreadable" for such a search, and looks again on the next tick', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('here')]);
  let calls = 0;
  const find = async () => (++calls === 1 ? { file: null, reason: 'unreadable' } : { file });
  const h = harness({ root, find });
  await h.session.open('rev');
  assert.strictEqual(h.frames[0].reason, 'unreadable');
  await h.session.poll();
  assert.strictEqual(h.frames[h.frames.length - 1].source, file, 'a blind search is retried, not remembered as a miss');
});

// ---- Dexter F1, PR #63: a transient read error must not lose or hide the log ----

const agentLog = require('../host/agent-log');
const display = require('../app/agent-log-display');

// A `read` that behaves like the real one except that call number `failOn`
// (1-based) rejects with the given errno -- what an AV scanner or an indexer
// holding the file produces on Windows.
function flaky(failOn, code = 'EBUSY') {
  let n = 0;
  return (state, opts) => (++n === failOn
    ? Promise.reject(Object.assign(new Error('busy'), { code }))
    : agentLog.readMore(state, opts));
}

// An `openTail` that rejects on the given 1-based calls and otherwise opens for real.
function flakyOpen(failOn, code = 'EBUSY') {
  const bad = new Set([].concat(failOn));
  let n = 0;
  return (file, opts) => (bad.has(++n)
    ? Promise.reject(Object.assign(new Error('busy'), { code }))
    : agentLog.openTail(file, opts));
}

function reduce(agent, frames) {
  return frames.reduce((m, f) => display.applyFrame(m, f), display.openLog(agent));
}

test('F1: after a transient EBUSY a FINISHED agent\'s log comes back, it does not sit on "couldn\'t read"', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one'), textLine('two'), textLine('three')]);
  const h = harness({ root, read: flaky(2) });
  await h.session.open('rev');
  await h.session.poll();                         // EBUSY
  assert.strictEqual(h.frames[h.frames.length - 1].reason, 'unreadable');
  await h.session.poll();                         // the file reads fine again
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.reset, true, 'recovery re-sends from the top');
  assert.deepStrictEqual(last.entries.map(e => e.summary), ['one', 'two', 'three']);
  const m = reduce('rev', h.frames);
  assert.strictEqual(m.source, last.source);
  assert.strictEqual(m.entries.length, 3);
});

test('F1: after a transient EBUSY a RUNNING agent keeps its history: 3 + 1 new is 4, not 1', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one'), textLine('two'), textLine('three')]);
  const h = harness({ root, read: flaky(2), invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  fs.appendFileSync(file, textLine('four') + NL);
  await h.session.poll();                         // EBUSY
  await h.session.poll();                         // recovered
  const m = reduce('rev', h.frames);
  assert.deepStrictEqual(m.entries.map(e => e.summary), ['one', 'two', 'three', 'four']);
  assert.strictEqual(m.dropped, 0);
});

// ---- Dexter R2-1, PR #63: a failed OPEN must not pin the panel on "couldn't read" ----

test('R2-1: one EBUSY when a name-mode log is OPENED is retried on the next tick', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one'), textLine('two')]);
  const h = harness({ root, openTail: flakyOpen(1) });
  await h.session.open('rev');
  assert.strictEqual(h.frames[h.frames.length - 1].reason, 'unreadable');
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.source, file, 'the log came back');
  assert.strictEqual(last.reset, true);
  assert.deepStrictEqual(last.entries.map(e => e.summary), ['one', 'two']);
});

test('R2-1: a second EBUSY on the RECOVERY reopen still recovers, two polls later', async () => {
  const { root, dir } = project();
  const file = subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one'), textLine('two'), textLine('three')]);
  const h = harness({ root, read: flaky(2), openTail: flakyOpen(2) });
  await h.session.open('rev');                     // openTail #1, read #1
  await h.session.poll();                          // read #2: EBUSY
  await h.session.poll();                          // recovery reopen (openTail #2): EBUSY again
  assert.strictEqual(h.frames[h.frames.length - 1].reason, 'unreadable');
  await h.session.poll();                          // reopen succeeds
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.source, file);
  assert.strictEqual(last.reset, true);
  assert.deepStrictEqual(reduce('rev', h.frames).entries.map(e => e.summary), ['one', 'two', 'three']);
});

test('R2-1: ENOENT on the recovery reopen is "no-transcript", not "unreadable"', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one')]);
  const h = harness({ root, read: flaky(2), openTail: flakyOpen(2, 'ENOENT') });
  await h.session.open('rev');
  await h.session.poll();                          // EBUSY
  await h.session.poll();                          // reopen: the file is gone
  assert.strictEqual(h.frames[h.frames.length - 1].reason, 'no-transcript');
});

test('R2-2: a tracked run that ENDS while its tail is in recovery stays that run, and finishes', async () => {
  const { root, dir } = project();
  parent(dir, 's1', [{ id: 't1', type: 'rev' }]);
  const a1 = subagent(dir, 's1', 'a1', { agentType: 'rev', toolUseId: 't1' }, [textLine('mine')], new Date('2026-01-01'));
  // Another host's NEWER run of the same agent: what a by-name pick would choose.
  subagent(dir, 's1', 'r2', { agentType: 'rev' }, [textLine('theirs')], new Date('2026-06-01'));
  const h = harness({ root, read: flaky(2), invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  await h.session.poll();                          // EBUSY: the tail goes into recovery
  h.state.invocations = [];                        // the run ends before the next tick
  await h.session.poll();
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.strictEqual(last.source, a1, 'not re-picked by name');
  assert.strictEqual(last.tracked, true);
  assert.strictEqual(last.done, true);
  assert.deepStrictEqual(reduce('rev', h.frames).entries.map(e => e.summary), ['mine']);
});

test('R2-1: a failed open does not leave the name search latched', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, [textLine('one')]);
  let finds = 0;
  const find = async (a) => { finds++; return require('../host/agent-log-session').findTranscript(a); };
  const h = harness({ root, find, openTail: flakyOpen(1, 'ENOENT') });
  await h.session.open('rev');                     // find #1 ok, open ENOENT
  await h.session.poll();                          // must search again, not sit at the latch
  assert.ok(finds >= 2, `searched ${finds} time(s)`);
  assert.notStrictEqual(h.frames[h.frames.length - 1].source, null);
});

test('F1: an absence frame forgets the status dedupe, so a status the window lost is sent again', async () => {
  const { root, dir } = project();
  subagent(dir, 's1', 'a1', { agentType: 'rev' }, []);   // an empty transcript: nothing but status to send
  const h = harness({ root, read: flaky(2), invocations: [{ name: 'rev', agentId: 'a1' }] });
  await h.session.open('rev');
  await h.session.poll();                         // EBUSY
  await h.session.poll();
  const last = h.frames[h.frames.length - 1];
  assert.notStrictEqual(last.source, null, 'the recovery is announced even though nothing new was read');
  assert.strictEqual(last.running, true);
});
