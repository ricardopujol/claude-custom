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

test('sums the tokens of a single session', () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 20, 30, 40))] });
  const r = readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.input, 10);
  assert.strictEqual(r.session.output, 20);
  assert.strictEqual(r.session.cacheWrite, 30);
  assert.strictEqual(r.session.cacheRead, 40);
  assert.strictEqual(r.session.total, 100);
});

test('project total spans every session in the folder', () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, {
    s1: [msg(U(10, 20)), msg(U(1, 2))],
    s2: [msg(U(100, 200))],
  });
  const r = readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 33);
  assert.strictEqual(r.project.total, 333);
});

test('project total counts sessions the current one knows nothing about', () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { old: [msg(U(5, 5))], cur: [msg(U(1, 1))] });
  const r = readUsage({ cwd, sessionId: 'cur', projectsDir: root });
  assert.strictEqual(r.project.total, 12);
});

test('does NOT double count the per-iteration breakdown', () => {
  // usage.iterations repeats the top-level numbers; summing both inflates every
  // figure, and silently, because the shape still looks reasonable.
  const cwd = 'C:/w/proj';
  const usage = {
    ...U(10, 20, 30, 40),
    iterations: [{ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }],
  };
  const root = transcripts(cwd, { s1: [msg(usage)] });
  assert.strictEqual(readUsage({ cwd, sessionId: 's1', projectsDir: root }).session.total, 100);
});

test('counts subagent (sidechain) spend', () => {
  // Subagent tokens are real money and are exactly what the roster is showing.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, {
    s1: [msg(U(10, 10)), msg(U(5, 5), { isSidechain: true })],
  });
  assert.strictEqual(readUsage({ cwd, sessionId: 's1', projectsDir: root }).session.total, 30);
});

test('tolerates a truncated final line', () => {
  // The transcript is appended to live, so the last line is routinely a partial
  // write. Throwing here would take the token display down mid-session.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 20)), '{"message":{"usage":{"input_to'] });
  assert.strictEqual(readUsage({ cwd, sessionId: 's1', projectsDir: root }).session.total, 30);
});

test('ignores lines with no usage at all', () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, {
    s1: [{ type: 'user', message: { content: 'hi' } }, msg(U(7, 3))],
  });
  assert.strictEqual(readUsage({ cwd, sessionId: 's1', projectsDir: root }).session.total, 10);
});

test('an unknown project yields zeroes rather than throwing', () => {
  const r = readUsage({ cwd: 'C:/never/used', sessionId: 'x', projectsDir: os.tmpdir() });
  assert.deepStrictEqual(r.session, EMPTY);
  assert.deepStrictEqual(r.project, EMPTY);
});

test('an unknown session still reports the project total', () => {
  // The session id arrives from a SessionStart hook, which may not have fired
  // yet; the project figure must not wait on it.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg(U(10, 20))] });
  const r = readUsage({ cwd, sessionId: null, projectsDir: root });
  assert.strictEqual(r.session.total, 0);
  assert.strictEqual(r.project.total, 30);
});

test('reports how many sessions the project total covers', () => {
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { a: [msg(U(1, 1))], b: [msg(U(1, 1))], c: [msg(U(1, 1))] });
  assert.strictEqual(readUsage({ cwd, sessionId: 'a', projectsDir: root }).project.sessions, 3);
});

test('missing usage fields default to zero instead of NaN', () => {
  // One NaN poisons every downstream sum and renders as "NaN" in the UI.
  const cwd = 'C:/w/proj';
  const root = transcripts(cwd, { s1: [msg({ output_tokens: 5 })] });
  const r = readUsage({ cwd, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 5);
  assert.ok(Number.isFinite(r.session.input));
});
