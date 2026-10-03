'use strict';
/**
 * The reader's Diff source (#32): what Claude changed in one file. Claude's OWN Edit / Write calls first
 * (before -> now), `git diff HEAD -- <file>` when there are none, nothing when neither exists.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { nextId, withResults } = require('./transcript-fixtures');

const { claudeCallsFor, renderCalls, pickDiff, gitDiffHead, diffFor, MAX_CALLS, MAX_WRITE_LINES } = require('../host/repo-diff');

const ROOT = 'C:/Users/ricar/VibeCode/proj';
const T = Date.parse('2026-10-03T12:00:00Z');
const at = (n) => new Date(T + n * 1000).toISOString();

const use = (name, input, n) => ({
  type: 'assistant', timestamp: at(n),
  message: { content: [{ type: 'tool_use', id: nextId(), name, input }] },
});
const edit = (file, o, n, nw, k) => use('Edit', { file_path: file, old_string: o, new_string: nw }, k);
const write = (file, content, k) => use('Write', { file_path: file, content }, k);

function projects(sessions, { subagent } = {}) {
  const base = tmpDir('cc-diff-');
  const proj = path.join(base, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(proj, { recursive: true });
  sessions.forEach((entries, i) => fs.writeFileSync(path.join(proj, `s${i}.jsonl`), withResults(entries).map(e => JSON.stringify(e)).join('\n')));
  if (subagent) {
    const sub = path.join(proj, 's0', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), withResults(subagent).map(e => JSON.stringify(e)).join('\n'));
  }
  return base;
}

test('only calls on THIS file, in time order, whichever session they came from', async () => {
  const f = `${ROOT}/src/a.js`;
  const dir = projects([
    [edit(f, 'b', 0, 'B', 30), edit(`${ROOT}/src/other.js`, 'x', 0, 'y', 10)],
    [write(f, 'new', 5), use('Read', { file_path: f }, 7), use('Bash', { command: 'echo ' + f }, 9)],
  ]);
  const r = await claudeCallsFor({ root: ROOT, rel: 'src/a.js', projectsDir: dir });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.calls.map(c => c.tool), ['Write', 'Edit']);
  assert.deepStrictEqual(r.calls.map(c => c.at), [T + 5000, T + 30000]);
});

test('Windows backslashes and a different case in the transcript still name the file', async () => {
  const dir = projects([[edit('C:\\Users\\ricar\\VIBECODE\\proj\\src\\a.js', 'o', 0, 'n', 1)]]);
  const r = await claudeCallsFor({ root: ROOT, rel: 'src/a.js', projectsDir: dir });
  assert.strictEqual(r.calls.length, 1);
});

test('a subagent\'s edits count, a file outside the project does not', async () => {
  const dir = projects([[]], {
    subagent: [edit(`${ROOT}/a.js`, 'o', 0, 'n', 1), edit('C:/elsewhere/a.js', 'o', 0, 'n', 2)],
  });
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: dir });
  assert.strictEqual(r.calls.length, 1);
});

test('a half-written last line (the transcript is being appended) is skipped, not fatal', async () => {
  const dir = tmpDir('cc-diff-partial-');
  const proj = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), withResults([edit(`${ROOT}/a.js`, 'o', 0, 'n', 1)]).map(e => JSON.stringify(e)).join('\n') + '\n{"type":"assistant","message":{"con');
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: dir });
  assert.strictEqual(r.calls.length, 1);
});

test('no transcripts at all is ok with no calls, and says so (the git fallback decides what that means)', async () => {
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: tmpDir('cc-diff-none-') });
  assert.deepStrictEqual(r, { ok: true, calls: [], transcripts: false });
});

test('an Edit with a missing old_string or new_string is dropped, not drawn as undefined', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[use('Edit', { file_path: f, new_string: 'n' }, 1), use('Edit', { file_path: f, old_string: 'o', new_string: 'n' }, 2)]]);
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: dir });
  assert.strictEqual(r.calls.length, 1);
});

test('only the most recent MAX_CALLS calls are kept', async () => {
  const f = `${ROOT}/a.js`;
  const entries = [];
  for (let i = 0; i < MAX_CALLS + 5; i++) entries.push(edit(f, `o${i}`, 0, `n${i}`, i));
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: projects([entries]) });
  assert.strictEqual(r.calls.length, MAX_CALLS);
  assert.strictEqual(r.calls[r.calls.length - 1].oldString, `o${MAX_CALLS + 4}`);
  assert.strictEqual(r.truncated, true);
});

// ---- rendering ----

test('an Edit is its old lines as - and its new lines as +, under a header with the tool and the time', () => {
  const text = renderCalls([{ tool: 'Edit', at: T, oldString: 'a\nb', newString: 'c' }]);
  assert.deepStrictEqual(text.split('\n'), ['@@ Edit \u00b7 2026-10-03 12:00 UTC @@', '-a', '-b', '+c']);
});

test('an Edit that only adds or only removes has just the one side', () => {
  assert.deepStrictEqual(renderCalls([{ tool: 'Edit', at: T, oldString: '', newString: 'x' }]).split('\n').slice(1), ['+x']);
  assert.deepStrictEqual(renderCalls([{ tool: 'Edit', at: T, oldString: 'x', newString: '' }]).split('\n').slice(1), ['-x']);
});

test('a Write is its whole content as +, with the line count in the header', () => {
  const lines = renderCalls([{ tool: 'Write', at: T, content: 'one\ntwo\n' }]).split('\n');
  assert.strictEqual(lines[0], '@@ Write (2 lines) \u00b7 2026-10-03 12:00 UTC @@');
  assert.deepStrictEqual(lines.slice(1), ['+one', '+two']);
});

test('a very long Write is cut, and says how much was left out', () => {
  const content = Array.from({ length: MAX_WRITE_LINES + 7 }, (_, i) => `l${i}`).join('\n');
  const lines = renderCalls([{ tool: 'Write', at: T, content }]).split('\n');
  assert.strictEqual(lines.length, 1 + MAX_WRITE_LINES + 1);
  assert.match(lines[lines.length - 1], /7 more lines/);
});

test('CRLF content does not leave a stray CR on every drawn line', () => {
  const lines = renderCalls([{ tool: 'Edit', at: T, oldString: 'a\r\nb', newString: 'c\r\n' }]).split('\n');
  assert.ok(lines.every(l => !l.includes('\r')), JSON.stringify(lines));
});

test('several calls are separated by their headers, oldest first', () => {
  const text = renderCalls([{ tool: 'Edit', at: T, oldString: 'a', newString: 'b' }, { tool: 'Edit', at: T + 60000, oldString: 'b', newString: 'c' }]);
  assert.strictEqual(text.split('\n').filter(l => l.startsWith('@@')).length, 2);
});

test('an unusable timestamp has no time in the header rather than "Invalid Date"', () => {
  const text = renderCalls([{ tool: 'Edit', at: NaN, oldString: 'a', newString: 'b' }]);
  assert.ok(!/Invalid|NaN/.test(text));
  assert.strictEqual(text.split('\n')[0], '@@ Edit @@');
});

// ---- choosing the source ----

test('Claude\'s calls win over git', () => {
  const r = pickDiff({ calls: [{ tool: 'Edit', at: T, oldString: 'a', newString: 'b' }], gitText: 'diff --git ...' });
  assert.strictEqual(r.source, 'claude');
  assert.match(r.text, /^@@ Edit/);
});

test('with no calls, git\'s diff is used', () => {
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: 'diff --git a b\n+x' }), { source: 'git', text: 'diff --git a b\n+x' });
});

test('with neither, there is no diff: source null, empty text', () => {
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: '' }), { source: null, text: '' });
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: null }), { source: null, text: '' });
  assert.deepStrictEqual(pickDiff({}), { source: null, text: '' });
});

// ---- git ----

test('gitDiffHead asks for HEAD against exactly that file, with -- so a name can\'t be a flag', async () => {
  let seen;
  const r = await gitDiffHead('C:\\r', '-evil.js', { execFile: (f, a, o, cb) => { seen = a; cb(null, 'diff text', ''); } });
  assert.deepStrictEqual(r, { ok: true, text: 'diff text' });
  assert.deepStrictEqual(seen.slice(0, 2), ['-C', 'C:\\r']);
  assert.deepStrictEqual(seen.slice(-3), ['HEAD', '--', ':(literal)-evil.js']);
});

test('a git failure is {ok:false}, not an empty diff', async () => {
  const r = await gitDiffHead('C:\\r', 'a.js', { execFile: (f, a, o, cb) => cb(new Error('boom'), '', 'fatal: bad revision HEAD') });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bad revision/);
});

test('a huge git diff is cut at the cap and says so', async () => {
  const big = 'x'.repeat(600 * 1024);
  const r = await gitDiffHead('C:\\r', 'a.js', { execFile: (f, a, o, cb) => cb(null, big, '') });
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length < big.length);
  assert.match(r.text, /diff cut/);
});

// ---- the whole thing ----

test('diffFor: calls found and the file unchanged since -> Claude (git is asked, since the file may have moved on, but does not win)', async () => {
  let ran = 0;
  const dir = projects([[edit(`${ROOT}/a.js`, 'o', 0, 'n', 1)]]);
  const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: (f, a, o, cb) => { ran++; cb(null, 'diff --git', ''); } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'claude');
  assert.strictEqual(ran, 1);
});

test('diffFor: no calls -> git\'s diff; git says nothing -> source null', async () => {
  const dir = tmpDir('cc-diff-empty-');
  const withGit = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: (f, a, o, cb) => cb(null, '@@ -1 +1 @@\n-a\n+b', '') });
  assert.strictEqual(withGit.source, 'git');
  const none = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: (f, a, o, cb) => cb(null, '', '') });
  assert.deepStrictEqual({ ok: none.ok, source: none.source, text: none.text }, { ok: true, source: null, text: '' });
});

test('diffFor: no calls and git failing is an error the page can show, not "no changes"', async () => {
  const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: tmpDir('cc-diff-fail-'), execFile: (f, a, o, cb) => cb(new Error('x'), '', 'fatal: not a git repository') });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a git repository/);
});

// ---- PR #95 Dexter D8, Miguel M4 ----

test('M4: git is told not to run the repo\'s own diff drivers: no external diff, no textconv', async () => {
  let seen;
  await gitDiffHead('C:\\r', 'a.js', { execFile: (f, a, o, cb) => { seen = a; cb(null, '', ''); } });
  assert.ok(seen.includes('--no-ext-diff') && seen.includes('--no-textconv'), seen.join(' '));
  assert.ok(seen.indexOf('--no-ext-diff') < seen.indexOf('--'), 'options go before the pathspec separator');
});

test('D8: the path is a LITERAL pathspec: [id] is a folder name, not a glob', async () => {
  const { execFileSync } = require('child_process');
  const root = tmpDir('cc-diff-glob-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', ...a], { cwd: root, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'app', '[id]'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', 'i'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', '[id]', 'page.tsx'), 'one\n');
  fs.writeFileSync(path.join(root, 'app', 'i', 'page.tsx'), 'one\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'app', '[id]', 'page.tsx'), 'two\n');
  fs.writeFileSync(path.join(root, 'app', 'i', 'page.tsx'), 'two\n');
  const r = await gitDiffHead(root, 'app/[id]/page.tsx');
  assert.strictEqual(r.ok, true);
  assert.match(r.text, /app\/\[id\]\/page\.tsx/);
  assert.doesNotMatch(r.text, /app\/i\/page\.tsx/, 'the glob also matched the other folder');
});

// ---- PR #95 Dexter D9 ----

test('D9: a call with no usable timestamp keeps its place between its neighbours (it does not jump to 1970)', async () => {
  const f = `${ROOT}/a.js`;
  const noTime = (id, n) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: f, old_string: `o${n}`, new_string: `n${n}` } }] } });
  const dir = projects([[edit(f, 'o1', 0, 'n1', 1), noTime('toolu_nt1', 2), edit(f, 'o3', 0, 'n3', 3)]]);
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: dir });
  assert.deepStrictEqual(r.calls.map(c => c.oldString), ['o1', 'o2', 'o3']);
  assert.ok(Number.isNaN(r.calls[1].at), 'its own time stays unknown, not invented');
});

test('D9: across sessions, the untimed call follows the call before it in ITS file', async () => {
  const f = `${ROOT}/a.js`;
  const noTime = (id, n) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: f, old_string: `o${n}`, new_string: `n${n}` } }] } });
  const dir = projects([[edit(f, 'o1', 0, 'n1', 10), noTime('toolu_nt2', 2)], [edit(f, 'o5', 0, 'n5', 5)]]);
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: dir });
  assert.deepStrictEqual(r.calls.map(c => c.oldString), ['o5', 'o1', 'o2']);
});

// ---- PR #95 Dexter r2 notes: MultiEdit ----

test('MultiEdit: every one of its edits is a hunk, in order, under one header', async () => {
  const f = `${ROOT}/a.js`;
  const multi = use('MultiEdit', { file_path: f, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'e' }] }, 1);
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: projects([[multi]]) });
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].tool, 'MultiEdit');
  const lines = renderCalls(r.calls).split('\n');
  assert.match(lines[0], /^@@ MultiEdit \(2 edits\)/);
  assert.deepStrictEqual(lines.slice(1), ['-a', '+b', '-c', '-d', '+e']);
});

test('MultiEdit with a malformed edits list is no call (not "undefined" drawn)', async () => {
  const f = `${ROOT}/a.js`;
  const bad = use('MultiEdit', { file_path: f, edits: [{ old_string: 'a' }, 5, null] }, 1);
  const none = use('MultiEdit', { file_path: f }, 2);
  const r = await claudeCallsFor({ root: ROOT, rel: 'a.js', projectsDir: projects([[bad, none]]) });
  assert.deepStrictEqual(r.calls, []);
});
