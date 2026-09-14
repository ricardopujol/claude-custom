'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { projectDirName, readUsage, EMPTY } = require('../host/usage');

function transcripts(cwd, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-'));
  const dir = path.join(root, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name + '.jsonl'),
      lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  return root;
}

// Subagent transcripts, which is where Claude Code actually puts them:
// <projectsDir>/<encoded-cwd>/<session-uuid>/subagents/*.jsonl
function subagents(root, cwd, sessionId, files) {
  const dir = path.join(root, projectDirName(cwd), sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name + '.jsonl'),
      lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  return dir;
}

const msg = (usage, extra = {}) => ({ type: 'assistant', message: { usage }, ...extra });
const U = (input, output, cw = 0, cr = 0) => ({
  input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});

test('encodes a project path the way Claude Code stores it', () => {
  assert.strictEqual(
    projectDirName('C:\\Users\\ricar\\VibeCode\\claude-custom'),
    'C--Users-ricar-VibeCode-claude-custom'
  );
});

test('path encoding is slash-direction agnostic', () => {
  assert.strictEqual(
    projectDirName('C:/Users/ricar/VibeCode/claude-custom'),
    projectDirName('C:\\Users\\ricar\\VibeCode\\claude-custom')
  );
});

test('sums the tokens of a single session', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 20, 30, 40))] });
  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.input, 10);
  assert.strictEqual(r.session.output, 20);
  assert.strictEqual(r.session.cacheWrite, 30);
  assert.strictEqual(r.session.cacheRead, 40);
  assert.strictEqual(r.session.total, 100);
});

test('project total spans every session in the folder', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, {
    s1: [msg(U(10, 20)), msg(U(1, 2))],
    s2: [msg(U(100, 200))],
  });
  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 33);
  assert.strictEqual(r.project.total, 333);
});

test('project total counts sessions the current one knows nothing about', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { old: [msg(U(5, 5))], cur: [msg(U(1, 1))] });
  const r = await readUsage({ cwd, sessionId: 'cur', projectsDir: root });
  assert.strictEqual(r.project.total, 12);
});

test('does NOT double count the per-iteration breakdown', async () => {
  // usage.iterations repeats the top-level numbers; summing both inflates every
  // figure, and silently, because the shape still looks reasonable.
  const cwd = 'C:/w/proj';
  const usage = {
    ...U(10, 20, 30, 40),
    iterations: [{ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }],
  };
  const root = transcripts(cwd, { s1: [msg(usage)] });
  assert.strictEqual((await readUsage({ cwd, sessionId: 's1', projectsDir: root })).session.total, 100);
});

test('usage is counted regardless of the isSidechain flag', async () => {
  // RENAMED from 'counts subagent (sidechain) spend', which is not what it
  // pinned. It writes the sidechain message into the TOP-LEVEL transcript, and
  // Claude Code does not produce that shape -- subagents get their own file
  // under <session>/subagents/. So the test asserting subagent spend was
  // counted was the only thing standing between this module and omitting ALL of
  // it, and it passed by describing a layout that does not exist.
  // What it DOES pin, and is worth keeping: nothing filters on isSidechain.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, {
    s1: [msg(U(10, 10)), msg(U(5, 5), { isSidechain: true })],
  });
  assert.strictEqual((await readUsage({ cwd, sessionId: 's1', projectsDir: root })).session.total, 30);
});

test('counts subagent spend, which lives in <session>/subagents/*.jsonl', async () => {
  // MEASURED on this project when the omission was found: 23 top-level files
  // held 1,308,926,474 tokens and 30 subagent transcripts held another
  // 104,427,203 -- the project total understated by 7.4%, and that share grows
  // with how agent-driven the work is. This repo mandates a multi-agent review
  // gate on every merge, so it is the agent-driven case by construction.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 0))] });
  subagents(root, cwd, 's1', { 'agent-x': [msg(U(1000, 0))] });

  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.project.total, 1010);
});

test("a subagent's spend belongs to the session that spawned it", async () => {
  // It was spent on that session's behalf, so the session figure has to include
  // it or the two numbers disagree about the same work.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 0))], s2: [msg(U(7, 0))] });
  subagents(root, cwd, 's1', { 'agent-x': [msg(U(1000, 0))] });
  subagents(root, cwd, 's2', { 'agent-y': [msg(U(500, 0))] });

  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 1010, "s1's own agent counts toward s1");
  assert.strictEqual(r.project.total, 1517, 'and every session still sums');
});

test('.meta.json siblings are not transcripts', async () => {
  // They sit right beside the .jsonl files and are not JSONL at all. Counting
  // them would not throw -- it would silently add nothing and inflate the
  // session count.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 0))] });
  const dir = path.join(root, projectDirName(cwd), 's1', 'subagents');
  subagents(root, cwd, 's1', { 'agent-x': [msg(U(1000, 0))] });
  fs.writeFileSync(path.join(dir, 'agent-x.meta.json'),
    JSON.stringify({ agentType: 'code-reviewer' }));

  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.project.total, 1010);
});

test('a session with no subagents is the ordinary case, not an error', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 0))] });
  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.project.total, 10);
});

test('tolerates a truncated final line', async () => {
  // The transcript is appended to live, so the last line is routinely a partial
  // write. Throwing here would take the token display down mid-session.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 20)), '{"message":{"usage":{"input_to'] });
  assert.strictEqual((await readUsage({ cwd, sessionId: 's1', projectsDir: root })).session.total, 30);
});

test('ignores lines with no usage at all', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, {
    s1: [{ type: 'user', message: { content: 'hi' } }, msg(U(7, 3))],
  });
  assert.strictEqual((await readUsage({ cwd, sessionId: 's1', projectsDir: root })).session.total, 10);
});

test('an unknown project yields zeroes rather than throwing', async () => {
  const r = await readUsage({ cwd: 'C:/never/used', sessionId: 'x', projectsDir: os.tmpdir() });
  assert.deepStrictEqual(r.session, EMPTY);
  assert.deepStrictEqual(r.project, EMPTY);
});

test('an unknown session still reports the project total', async () => {
  // The session id arrives from a SessionStart hook, which may not have fired
  // yet; the project figure must not wait on it.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 20))] });
  const r = await readUsage({ cwd, sessionId: null, projectsDir: root });
  assert.strictEqual(r.session.total, 0);
  assert.strictEqual(r.project.total, 30);
});

test('reports how many sessions the project total covers', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { a: [msg(U(1, 1))], b: [msg(U(1, 1))], c: [msg(U(1, 1))] });
  assert.strictEqual((await readUsage({ cwd, sessionId: 'a', projectsDir: root })).project.sessions, 3);
});

test('missing usage fields default to zero instead of NaN', async () => {
  // One NaN poisons every downstream sum and renders as "NaN" in the UI.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg({ output_tokens: 5 })] });
  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 5);
  assert.ok(Number.isFinite(r.session.input));
});

// --- the enumeration's own absence path --------------------------------------
// Dexter, combination hazard. The subagent walk swallowed a failed readdir with
// a comment saying "a session with no subagents is the normal case" -- which
// conflates HAD NONE with COULD NOT LOOK. An EBUSY on that directory hid all
// 104,427,203 recovered tokens behind `ok: true`: a 7.4% undercount reported as
// complete and trustworthy. Same shape as the reference implementation that
// agreed with the bug because it shared the omission.

test('a subagents directory that cannot be READ is absence, not emptiness', async () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 0))] });
  // A FILE where the subagents directory should be: readdir fails with ENOTDIR,
  // which is "could not look", not "nothing there".
  const sdir = path.join(root, projectDirName(cwd), 's1');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'subagents'), 'not a directory');

  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.ok, false, 'an unreadable subagents dir must poison ok');
  assert.strictEqual(r.project.total, 10, 'what WAS readable is still reported');
});

test('a session DIRECTORY with no subagents/ inside is ordinary, and stays ok', async () => {
  // The sibling case, and it must not share a code path with the one above --
  // if it did, every ordinary session would report absence forever.
  //
  // The session directory has to EXIST for this to pin anything: the walk only
  // descends into directories, so a fixture with just `s1.jsonl` never reaches
  // the ENOENT branch at all. Found by mutation -- `errors++` unconditionally
  // (ENOENT treated as a failure) survived the version of this test that
  // omitted the directory.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 0))] });
  fs.mkdirSync(path.join(root, projectDirName(cwd), 's1'), { recursive: true });

  const r = await readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.ok, true, 'a session that spawned no agents is not a failure');
  assert.strictEqual(r.project.total, 10);
});
