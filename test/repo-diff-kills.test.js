'use strict';
/**
 * The reader's Diff source at its edges (backlog #60, Mortimer's release-#101 part 2): the call and string caps
 * at their exact limits, the ordering of calls with equal or missing times, which calls are admitted at all, the
 * "has the file moved on since" rule, and what is handed to git (argv, options) and made of its answers. Every
 * git call goes through a recording fake `execFile`; nothing here runs git.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { nextId, withResults } = require('./transcript-fixtures');

const {
  claudeCallsFor, renderCalls, pickDiff, gitDiffHead, gitModified, gitUntrackedDiff, diffFor,
  SLACK_MS, MAX_CALLS, MAX_WRITE_LINES, MAX_STRING, MAX_GIT_CHARS,
} = require('../host/repo-diff');

const ROOT = 'C:/Users/ricar/VibeCode/proj';
const T = Date.parse('2026-10-03T12:00:00Z');
const at = (n) => new Date(T + n * 1000).toISOString();

const use = (name, input, n, extra = {}) => ({
  type: 'assistant', ...(n === undefined ? {} : { timestamp: at(n) }),
  message: { content: [{ type: 'tool_use', id: nextId(), name, input }] }, ...extra,
});
const edit = (file, o, nw, n) => use('Edit', { file_path: file, old_string: o, new_string: nw }, n);
const write = (file, content, n) => use('Write', { file_path: file, content }, n);

function projects(sessions, { name = 'C--Users-ricar-VibeCode-proj', raw = false } = {}) {
  const base = tmpDir('cc-diffk-');
  const proj = path.join(base, name);
  fs.mkdirSync(proj, { recursive: true });
  sessions.forEach((entries, i) => fs.writeFileSync(path.join(proj, `s${i}.jsonl`),
    (raw ? entries : withResults(entries)).map((e) => JSON.stringify(e)).join('\n')));
  return base;
}
const callsOf = (dir, rel = 'a.js') => claudeCallsFor({ root: ROOT, rel, projectsDir: dir });

// ---- which calls are admitted ----

test('a call is admitted only when its tool, file_path and strings are the right shape', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[
    use('Edit', { file_path: 5, old_string: 'o', new_string: 'n' }, 1),
    use('Edit', { old_string: 'o', new_string: 'n' }, 2),
    use('Edit', null, 3),
    use('Edit', { file_path: f, old_string: 5, new_string: 'n' }, 4),
    use('Edit', { file_path: f, old_string: 'o', new_string: null }, 5),
    use('Edit', { file_path: f, old_string: 'o' }, 6),
    use('Write', { file_path: f, content: 5 }, 7),
    use('Write', { file_path: f }, 8),
    use('MultiEdit', { file_path: f, edits: 'x' }, 9),
    use('MultiEdit', { file_path: f, edits: [] }, 10),
    use('MultiEdit', { file_path: f, edits: [null, 5, {}, { old_string: 1, new_string: 'n' }, { old_string: 'o' }] }, 11),
    use('Read', { file_path: f }, 12),
    use('Edit', { file_path: 'C:/elsewhere/a.js', old_string: 'o', new_string: 'n' }, 13),
    use('Edit', { file_path: `${ROOT}/b.js`, old_string: 'o', new_string: 'n' }, 14),
    use('Edit', { file_path: `${ROOT}-other/a.js`, old_string: 'o', new_string: 'n' }, 15),
    use('Edit', { file_path: f, old_string: 'good', new_string: '' }, 16),
  ]]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls.map((c) => [c.tool, c.oldString, c.newString]), [['Edit', 'good', '']]);
});

test('a MultiEdit keeps its well-formed pairs and drops the malformed ones', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[use('MultiEdit', { file_path: f, edits: [{ old_string: 'a', new_string: 'b' }, null, { old_string: 'c' }, { old_string: 'd', new_string: 'e' }] }, 1)]]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls[0].edits, [{ oldString: 'a', newString: 'b' }, { oldString: 'd', newString: 'e' }]);
});

test('a file spelled in another case, with backslashes, still names the file; a longer sibling folder does not', async () => {
  const dir = projects([[
    edit('c:\\USERS\\ricar\\vibecode\\PROJ\\A.JS', 'o', 'n', 1),
    edit('C:/Users/ricar/VibeCode/proj-x/a.js', 'o', 'n', 2),
  ]]);
  assert.strictEqual((await callsOf(dir)).calls.length, 1);
});

test('a root spelled with backslashes finds the transcripts of its project folder', async () => {
  const dir = projects([[edit(`${ROOT}/a.js`, 'o', 'n', 1)]]);
  const r = await claudeCallsFor({ root: 'C:\\Users\\ricar\\VibeCode\\proj', rel: 'a.js', projectsDir: dir });
  assert.strictEqual(r.calls.length, 1);
});

test('with no projectsDir the transcripts are read from <home>/.claude/projects', async () => {
  const home = tmpDir('cc-diffk-home-');
  const proj = path.join(home, '.claude', 'projects', 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), withResults([edit(`${ROOT}/a.js`, 'o', 'n', 1)]).map((e) => JSON.stringify(e)).join('\n'));
  const keep = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    assert.strictEqual(os.homedir(), home, 'the override took');
    const r = await claudeCallsFor({ root: ROOT, rel: 'a.js' });
    assert.strictEqual(r.calls.length, 1);
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---- string caps ----

test('a string of exactly MAX_STRING characters is kept whole; one more is cut to MAX_STRING', async () => {
  const f = `${ROOT}/a.js`;
  const whole = 'x'.repeat(MAX_STRING);
  const over = 'y'.repeat(MAX_STRING + 1);
  const dir = projects([[
    write(f, whole, 1), write(f, over, 2),
    edit(f, whole, over, 3),
    use('MultiEdit', { file_path: f, edits: [{ old_string: over, new_string: whole }] }, 4),
  ]]);
  const r = await callsOf(dir);
  assert.strictEqual(r.calls[0].content.length, MAX_STRING);
  assert.strictEqual(r.calls[1].content.length, MAX_STRING);
  assert.strictEqual(r.calls[1].content, over.slice(0, MAX_STRING));
  assert.strictEqual(r.calls[2].oldString.length, MAX_STRING);
  assert.strictEqual(r.calls[2].newString.length, MAX_STRING);
  assert.strictEqual(r.calls[3].edits[0].oldString.length, MAX_STRING);
  assert.strictEqual(r.calls[3].edits[0].newString.length, MAX_STRING);
  assert.strictEqual(r.calls[2].oldString, whole, 'exactly the cap is not touched');
});

test('short strings are returned as they are', async () => {
  const dir = projects([[edit(`${ROOT}/a.js`, 'abc', 'xyz', 1)]]);
  const r = await callsOf(dir);
  assert.deepStrictEqual([r.calls[0].oldString, r.calls[0].newString], ['abc', 'xyz']);
});

// ---- ordering ----

test('calls with the same time keep the order they were written in; a call with no time keeps its place after the one before it', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[edit(f, '1', 'a', 5), edit(f, '2', 'b', 5), edit(f, '3', 'c', 5), edit(f, '4', 'd', undefined), edit(f, '5', 'e', 9)]]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls.map((c) => c.oldString), ['1', '2', '3', '4', '5']);
});

test('a call with no time at all, first in its file, sorts before every dated call of another file, not after', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[edit(f, 'dated', 'x', 3)], [edit(f, 'undated-first', 'x', undefined), edit(f, 'dated-later', 'x', 9)]]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls.map((c) => c.oldString), ['undated-first', 'dated', 'dated-later']);
});

test('calls order by time across sessions, ties broken by where they were found', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[edit(f, 's0-late', 'x', 50), edit(f, 's0-tie', 'x', 20)], [edit(f, 's1-early', 'x', 10), edit(f, 's1-tie', 'x', 20)]]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls.map((c) => c.oldString), ['s1-early', 's0-tie', 's1-tie', 's0-late']);
});

// ---- the call cap ----

test('exactly MAX_CALLS calls are all returned and not "truncated"; one more drops the OLDEST and says so', async () => {
  const f = `${ROOT}/a.js`;
  const make = (n) => projects([Array.from({ length: n }, (_, i) => edit(f, `o${i}`, 'n', i))]);
  const exact = await callsOf(make(MAX_CALLS));
  assert.strictEqual(exact.calls.length, MAX_CALLS);
  assert.strictEqual('truncated' in exact, false);
  assert.strictEqual(exact.calls[0].oldString, 'o0');
  const over = await callsOf(make(MAX_CALLS + 1));
  assert.strictEqual(over.calls.length, MAX_CALLS);
  assert.strictEqual(over.truncated, true);
  assert.strictEqual(over.calls[0].oldString, 'o1');
  assert.strictEqual(over.calls[MAX_CALLS - 1].oldString, `o${MAX_CALLS}`);
});

test('diffFor says truncated, and how many calls it kept, when the cap cut some', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([Array.from({ length: MAX_CALLS + 5 }, (_, i) => edit(f, `o${i}`, 'n', i))]);
  const { run } = recorder({});
  const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.count, MAX_CALLS);
  const small = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: projects([[edit(f, 'o', 'n', 1)]]), execFile: run });
  assert.strictEqual('truncated' in small, false);
  assert.strictEqual(small.count, 1);
});

// ---- the event loop is yielded to ----

test('the scan yields to the event loop once per 500 lines and once per file', async () => {
  const real = global.setImmediate;
  let yields = 0;
  const count = async (lines) => {
    const dir = tmpDir('cc-diffk-yield-');
    const proj = path.join(dir, 'C--Users-ricar-VibeCode-proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 's.jsonl'), Array.from({ length: lines }, () => '{"type":"user"}').join('\n'));
    yields = 0;
    global.setImmediate = (fn, ...a) => { yields += 1; return real(fn, ...a); };
    try { await callsOf(dir); } finally { global.setImmediate = real; }
    return yields;
  };
  assert.strictEqual(await count(499), 1, 'no full batch: just the end of the file');
  assert.strictEqual(await count(500), 2);
  assert.strictEqual(await count(999), 2);
  assert.strictEqual(await count(1000), 3);
});

// ---- drawing ----

test('a Write of exactly MAX_WRITE_LINES lines has no "more" row; three over has one that says 3', () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
  const exact = renderCalls([{ tool: 'Write', at: NaN, content: body(MAX_WRITE_LINES) }]).split('\n');
  assert.strictEqual(exact.length, 1 + MAX_WRITE_LINES);
  assert.ok(!exact.some((l) => /more lines/.test(l)));
  const over = renderCalls([{ tool: 'Write', at: NaN, content: body(MAX_WRITE_LINES + 3) }]).split('\n');
  assert.strictEqual(over.length, 1 + MAX_WRITE_LINES + 1);
  assert.match(over[over.length - 1], /^… 3 more lines$/);
  assert.strictEqual(over[MAX_WRITE_LINES], `+l${MAX_WRITE_LINES - 1}`);
});

test('the same cap applies to each side of an Edit and to every pair of a MultiEdit', () => {
  const body = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n');
  const edit_ = renderCalls([{ tool: 'Edit', at: NaN, oldString: body(MAX_WRITE_LINES + 2, 'o'), newString: body(MAX_WRITE_LINES + 4, 'n') }]).split('\n');
  assert.deepStrictEqual(edit_.filter((l) => /more lines/.test(l)), ['… 2 more lines', '… 4 more lines']);
  const multi = renderCalls([{ tool: 'MultiEdit', at: NaN, edits: [{ oldString: body(MAX_WRITE_LINES + 1, 'a'), newString: 'x' }, { oldString: 'y', newString: body(MAX_WRITE_LINES + 7, 'b') }] }]).split('\n');
  assert.deepStrictEqual(multi.filter((l) => /more lines/.test(l)), ['… 1 more lines', '… 7 more lines']);
});

test('headers count their lines and edits with a plural, and carry the time only when there is one', () => {
  const one = renderCalls([{ tool: 'Write', at: T, content: 'only' }]).split('\n')[0];
  assert.match(one, /^@@ Write \(1 line\) · 2026-10-03 12:00 UTC @@$/);
  const two = renderCalls([{ tool: 'Write', at: NaN, content: 'a\nb' }]).split('\n')[0];
  assert.match(two, /^@@ Write \(2 lines\) @@$/);
  const m1 = renderCalls([{ tool: 'MultiEdit', at: T, edits: [{ oldString: 'a', newString: 'b' }] }]).split('\n')[0];
  assert.match(m1, /^@@ MultiEdit \(1 edit\) · 2026-10-03 12:00 UTC @@$/);
  const m2 = renderCalls([{ tool: 'MultiEdit', at: undefined, edits: [{ oldString: 'a', newString: 'b' }, { oldString: 'c', newString: 'd' }] }]).split('\n')[0];
  assert.match(m2, /^@@ MultiEdit \(2 edits\) @@$/);
  assert.match(renderCalls([{ tool: 'Edit', at: T, oldString: 'a', newString: 'b' }]).split('\n')[0], /^@@ Edit · 2026-10-03 12:00 UTC @@$/);
  assert.match(renderCalls([{ tool: 'Edit', at: NaN, oldString: 'a', newString: 'b' }]).split('\n')[0], /^@@ Edit @@$/);
});

test('an empty side adds no rows: a pure insertion has only + rows, a pure deletion only - rows', () => {
  assert.deepStrictEqual(renderCalls([{ tool: 'Edit', at: NaN, oldString: '', newString: 'new' }]).split('\n'), ['@@ Edit @@', '+new']);
  assert.deepStrictEqual(renderCalls([{ tool: 'Edit', at: NaN, oldString: 'old', newString: '' }]).split('\n'), ['@@ Edit @@', '-old']);
  assert.deepStrictEqual(renderCalls([{ tool: 'MultiEdit', at: NaN, edits: [{ oldString: '', newString: 'n' }, { oldString: 'o', newString: '' }] }]).split('\n'),
    ['@@ MultiEdit (2 edits) @@', '+n', '-o']);
});

// ---- which diff ----

const calls = (...done) => done.map((d, i) => ({ tool: 'Edit', at: T + i, doneAt: d, oldString: 'o', newString: 'n' }));

test('the file has moved on only when its mtime is past the LAST completion plus the slack, whatever order the calls are in', () => {
  const list = calls(T + 10_000, T + 2_000, T + 5_000);
  const last = T + 10_000;
  assert.strictEqual(pickDiff({ calls: list, gitText: 'G', fileMtimeMs: last + SLACK_MS }).source, 'claude', 'exactly the slack: not moved');
  assert.strictEqual(pickDiff({ calls: list, gitText: 'G', fileMtimeMs: last + SLACK_MS + 1 }).source, 'git');
  const rev = calls(T + 2_000, T + 10_000);
  assert.strictEqual(pickDiff({ calls: rev, gitText: 'G', fileMtimeMs: last + SLACK_MS + 1 }).source, 'git');
  assert.strictEqual(pickDiff({ calls: rev, gitText: 'G', fileMtimeMs: last + SLACK_MS }).source, 'claude');
});

test('a call with no completion time is judged by when it was requested, and with neither the calls stand', () => {
  const requested = [{ tool: 'Edit', at: T, doneAt: NaN, oldString: 'o', newString: 'n' }];
  assert.strictEqual(pickDiff({ calls: requested, gitText: 'G', fileMtimeMs: T + SLACK_MS + 1 }).source, 'git');
  assert.strictEqual(pickDiff({ calls: requested, gitText: 'G', fileMtimeMs: T + SLACK_MS }).source, 'claude');
  const nothing = [{ tool: 'Edit', at: NaN, doneAt: NaN, oldString: 'o', newString: 'n' }];
  assert.strictEqual(pickDiff({ calls: nothing, gitText: 'G', fileMtimeMs: 9e15 }).source, 'claude');
  const mixed = [{ tool: 'Edit', at: NaN, doneAt: NaN, oldString: 'o', newString: 'n' }, { tool: 'Edit', at: T, doneAt: T + 1000, oldString: 'o', newString: 'n' }];
  assert.strictEqual(pickDiff({ calls: mixed, gitText: 'G', fileMtimeMs: T + 1000 + SLACK_MS + 1 }).source, 'git');
});

test('an mtime that is not a finite number never says the file moved on', () => {
  const list = calls(T);
  for (const m of ['99999999999999', NaN, Infinity, -Infinity, undefined, null, {}, [9e15], true]) {
    assert.strictEqual(pickDiff({ calls: list, gitText: 'G', fileMtimeMs: m }).source, 'claude', String(m));
  }
});

test('when the file moved on but git has nothing, Claude\'s calls are still the answer; with no calls git or nothing', () => {
  assert.strictEqual(pickDiff({ calls: calls(T), gitText: '', fileMtimeMs: 9e15 }).source, 'claude');
  assert.strictEqual(pickDiff({ calls: calls(T), fileMtimeMs: 9e15 }).source, 'claude');
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: 'G' }), { source: 'git', text: 'G' });
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: '' }), { source: null, text: '' });
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: 5 }), { source: null, text: '' });
  assert.deepStrictEqual(pickDiff(), { source: null, text: '' });
});

// ---- git: argv, options, answers ----

/** A fake execFile: `answer(args)` gives the callback's arguments for the call, or throws to throw. */
function recorder(handlers) {
  const log = [];
  const run = (file, args, opts, cb) => {
    log.push({ file, args, opts });
    const h = args.includes('ls-files') ? handlers.lsFiles
      : args.includes('--no-index') ? handlers.noIndex
        : args.includes('--quiet') ? handlers.quiet
          : handlers.diff;
    if (!h) { cb(null, '', ''); return; }
    const out = h(args);
    cb(...out);
  };
  return { run, log };
}
const failure = (code, message = 'boom') => Object.assign(new Error(message), { code });

test('gitDiffHead asks git for the diff of that one literal path against HEAD, with exactly these options', async () => {
  const { run, log } = recorder({ diff: () => [null, 'DIFF', ''] });
  const r = await gitDiffHead('C:/p', 'app/[id]/page.tsx', { execFile: run });
  assert.deepStrictEqual(r, { ok: true, text: 'DIFF' });
  assert.strictEqual(log[0].file, 'git');
  assert.deepStrictEqual(log[0].args, ['-C', 'C:/p', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ':(literal)app/[id]/page.tsx']);
  assert.deepStrictEqual(log[0].opts, { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
});

test('gitDiffHead: a failure reports the first non-empty line of stderr (CRLF or LF), else the error message, else a reason', async () => {
  const run = (stderr, err = failure(128, 'exit 128')) => gitDiffHead('C:/p', 'a', { execFile: recorder({ diff: () => [err, '', stderr] }).run });
  assert.deepStrictEqual(await run('fatal: bad\r\nhint: more'), { ok: false, error: 'git diff failed: fatal: bad' });
  assert.deepStrictEqual(await run('fatal: bad\nhint: more'), { ok: false, error: 'git diff failed: fatal: bad' });
  assert.deepStrictEqual(await run('\n\r\nfatal: bad\n'), { ok: false, error: 'git diff failed: fatal: bad' });
  assert.deepStrictEqual(await run(''), { ok: false, error: 'git diff failed: exit 128' });
  assert.deepStrictEqual(await run(undefined), { ok: false, error: 'git diff failed: exit 128' });
  const none = await run('', Object.assign(new Error(''), { code: 1 }));
  assert.strictEqual(none.ok, false);
  assert.match(none.error, /^git diff failed: .+/);
});

test('gitDiffHead: a diff of exactly MAX_GIT_CHARS is returned whole; one more is cut with a note of the cap in KB', async () => {
  const diff = (text) => gitDiffHead('C:/p', 'a', { execFile: recorder({ diff: () => [null, text, ''] }).run });
  const whole = 'x'.repeat(MAX_GIT_CHARS);
  assert.deepStrictEqual(await diff(whole), { ok: true, text: whole });
  const over = await diff(whole + 'y');
  assert.strictEqual(over.ok, true);
  assert.ok(over.text.startsWith(whole + '\n'));
  assert.ok(over.text.endsWith(`… diff cut at ${MAX_GIT_CHARS / 1024} KB`));
  assert.match(over.text, /diff cut at 512 KB$/);
  assert.strictEqual(over.text.length, MAX_GIT_CHARS + '\n… diff cut at 512 KB'.length);
});

test('gitDiffHead: no stdout is an empty diff; a git that cannot even be started is reported with its reason', async () => {
  assert.deepStrictEqual(await gitDiffHead('C:/p', 'a', { execFile: recorder({ diff: () => [null, undefined, ''] }).run }), { ok: true, text: '' });
  const throwing = (e) => gitDiffHead('C:/p', 'a', { execFile: () => { throw e; } });
  assert.deepStrictEqual(await throwing(new Error('spawn git ENOENT')), { ok: false, error: 'git diff failed: spawn git ENOENT' });
  assert.deepStrictEqual(await throwing(undefined), { ok: false, error: 'git diff failed: undefined' });
});

test('gitModified: exit 1 means modified, any other failure means "cannot say", a clean diff falls to the untracked check', async () => {
  const modified = (handlers) => gitModified('C:/p', 'a', { execFile: recorder(handlers).run });
  assert.strictEqual(await modified({ quiet: () => [failure(1)] }), true);
  assert.strictEqual(await modified({ quiet: () => [failure(128)] }), null);
  assert.strictEqual(await modified({ quiet: () => [new Error('no code')] }), null);
  assert.strictEqual(await modified({ quiet: () => [null], lsFiles: () => [null, 'a\n'] }), true, 'untracked, so diffable');
  assert.strictEqual(await modified({ quiet: () => [null], lsFiles: () => [null, ''] }), false);
  assert.strictEqual(await modified({ quiet: () => [null], lsFiles: () => [null, '  \r\n\t'] }), false, 'whitespace is not a file name');
  assert.strictEqual(await modified({ quiet: () => [null], lsFiles: () => [null, undefined] }), false);
  assert.strictEqual(await modified({ quiet: () => [null], lsFiles: () => [failure(128)] }), null, 'git cannot say');
});

test('gitModified: asks with --quiet and exactly these options; the untracked check has its own argv and options', async () => {
  const { run, log } = recorder({ quiet: () => [null], lsFiles: () => [null, ''] });
  await gitModified('C:/p', 'src/a.js', { execFile: run });
  assert.deepStrictEqual(log[0].args, ['-C', 'C:/p', '-c', 'core.quotePath=false', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ':(literal)src/a.js']);
  assert.deepStrictEqual(log[0].opts, { timeout: 8000, windowsHide: true });
  assert.deepStrictEqual(log[1].args, ['-C', 'C:/p', '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--', ':(literal)src/a.js']);
  assert.deepStrictEqual(log[1].opts, { encoding: 'utf8', timeout: 8000, windowsHide: true });
});

test('gitModified: a git that throws on start answers "cannot say" instead of hanging', async () => {
  assert.strictEqual(await gitModified('C:/p', 'a', { execFile: () => { throw new Error('x'); } }), null);
  const calls_ = [];
  const run = (file, args, opts, cb) => {
    calls_.push(args);
    if (args.includes('--quiet')) { cb(null); return; }
    throw new Error('ls-files cannot start');
  };
  assert.strictEqual(await gitModified('C:/p', 'a', { execFile: run }), null);
});

test('gitUntrackedDiff: a tracked or ignored file answers an empty text without a diff; "cannot say" is an error', async () => {
  const { run, log } = recorder({ lsFiles: () => [null, ''] });
  assert.deepStrictEqual(await gitUntrackedDiff('C:/p', 'a', { execFile: run }), { ok: true, text: '' });
  assert.strictEqual(log.length, 1, 'no --no-index diff was asked');
  const unsure = await gitUntrackedDiff('C:/p', 'a', { execFile: recorder({ lsFiles: () => [failure(128)] }).run });
  assert.strictEqual(unsure.ok, false);
  assert.match(unsure.error, /untracked/);
});

test('gitUntrackedDiff: an untracked file is diffed against nothing, with exactly this argv and these options', async () => {
  const { run, log } = recorder({ lsFiles: () => [null, 'a\n'], noIndex: () => [failure(1), '+whole file\n', ''] });
  const r = await gitUntrackedDiff('C:/p', 'new.txt', { execFile: run });
  assert.deepStrictEqual(r, { ok: true, text: '+whole file\n' });
  const nothing = process.platform === 'win32' ? 'NUL' : '/dev/null';
  assert.deepStrictEqual(log[1].args, ['-C', 'C:/p', '-c', 'core.quotePath=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', nothing, 'new.txt']);
  assert.deepStrictEqual(log[1].opts, { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
});

test('gitUntrackedDiff: exit 1 is the normal "they differ"; any other failure is an error carrying its message', async () => {
  const diff = (err, out = 'D') => gitUntrackedDiff('C:/p', 'a', { execFile: recorder({ lsFiles: () => [null, 'a'], noIndex: () => [err, out, ''] }).run });
  assert.deepStrictEqual(await diff(failure(1)), { ok: true, text: 'D' });
  assert.deepStrictEqual(await diff(null), { ok: true, text: 'D' });
  assert.deepStrictEqual(await diff(failure(128, 'exit 128')), { ok: false, error: 'git diff failed: exit 128' });
  assert.deepStrictEqual(await diff(failure(undefined, 'killed')), { ok: false, error: 'git diff failed: killed' });
  assert.deepStrictEqual(await diff(failure(1), null), { ok: true, text: '' });
});

test('gitUntrackedDiff: the cut at MAX_GIT_CHARS is the same as the tracked diff\'s', async () => {
  const diff = (text) => gitUntrackedDiff('C:/p', 'a', { execFile: recorder({ lsFiles: () => [null, 'a'], noIndex: () => [failure(1), text, ''] }).run });
  const whole = 'x'.repeat(MAX_GIT_CHARS);
  assert.deepStrictEqual(await diff(whole), { ok: true, text: whole });
  const over = await diff(whole + 'y');
  assert.ok(over.text.startsWith(whole + '\n'));
  assert.match(over.text, /diff cut at 512 KB$/);
  assert.strictEqual(over.text.length, MAX_GIT_CHARS + '\n… diff cut at 512 KB'.length);
});

test('gitUntrackedDiff: a git that throws when asked for the diff is an error, not a hang', async () => {
  const run = (file, args, opts, cb) => { if (args.includes('ls-files')) { cb(null, 'a'); return; } throw new Error('cannot start'); };
  assert.deepStrictEqual(await gitUntrackedDiff('C:/p', 'a', { execFile: run }), { ok: false, error: 'git diff failed: cannot start' });
  const undef = (file, args, opts, cb) => { if (args.includes('ls-files')) { cb(null, 'a'); return; } throw undefined; };
  assert.deepStrictEqual(await gitUntrackedDiff('C:/p', 'a', { execFile: undef }), { ok: false, error: 'git diff failed: undefined' });
});

// ---- diffFor ----

test('with no calls and a git diff, that is the answer, and no untracked check is made', async () => {
  const dir = projects([[]]);
  const { run, log } = recorder({ diff: () => [null, 'GITDIFF', ''] });
  const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: run });
  assert.deepStrictEqual(r, { ok: true, source: 'git', text: 'GITDIFF', count: 0 });
  assert.strictEqual(log.length, 1);
});

test('with no calls and an empty git diff, an untracked file is shown whole, through the same git', async () => {
  const dir = projects([[]]);
  const { run, log } = recorder({ diff: () => [null, '', ''], lsFiles: () => [null, 'a.js\n'], noIndex: () => [failure(1), '+all new\n', ''] });
  const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: run });
  assert.deepStrictEqual(r, { ok: true, source: 'git', text: '+all new\n', count: 0 });
  assert.strictEqual(log.length, 3, 'diff HEAD, ls-files and --no-index all went through the injected execFile');
});

test('with no calls, an empty git diff and nothing untracked there is no diff; if git cannot say about untracked there is none either', async () => {
  const dir = projects([[]]);
  const none = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: recorder({ diff: () => [null, '', ''], lsFiles: () => [null, ''] }).run });
  assert.deepStrictEqual(none, { ok: true, source: null, text: '', count: 0 });
  const unsure = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: recorder({ diff: () => [null, '', ''], lsFiles: () => [failure(128)] }).run });
  assert.deepStrictEqual(unsure, { ok: true, source: null, text: '', count: 0 });
});

test('a failing git with no calls is an error with its reason, never "no changes"; with calls the calls are still the answer', async () => {
  const f = `${ROOT}/a.js`;
  const broken = recorder({ diff: () => [failure(128, 'exit 128'), '', 'fatal: not a repo'] });
  const none = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: projects([[]]), execFile: broken.run });
  assert.deepStrictEqual(none, { ok: false, error: 'git diff failed: fatal: not a repo' });
  const some = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: projects([[edit(f, 'o', 'n', 1)]]), execFile: broken.run });
  assert.strictEqual(some.ok, true);
  assert.strictEqual(some.source, 'claude');
  assert.strictEqual(some.count, 1);
});

test('with calls the file\'s mtime picks between them and git', async () => {
  const f = `${ROOT}/a.js`;
  const dir = projects([[edit(f, 'o', 'n', 0)]]);
  const { run } = recorder({ diff: () => [null, 'GIT', ''] });
  const claude = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: run, fileMtimeMs: T + 1000 });
  assert.strictEqual(claude.source, 'claude');
  const moved = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: run, fileMtimeMs: T + 60_000 });
  assert.deepStrictEqual([moved.source, moved.text, moved.count], ['git', 'GIT', 1]);
});

test('the default git is child_process.execFile, looked up when asked (an injected one is optional)', async () => {
  const dir = projects([[]]);
  const cp = require('child_process');
  const real = cp.execFile;
  const seen = [];
  cp.execFile = (file, args, opts, cb) => { seen.push(file); cb(null, 'VIA DEFAULT', ''); };
  try {
    const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir });
    assert.strictEqual(r.text, 'VIA DEFAULT');
    assert.strictEqual(await gitModified('C:/p', 'a'), true, 'the fake answers every ls-files with a name');
  } finally {
    cp.execFile = real;
  }
  assert.ok(seen.length >= 2 && seen.every((f) => f === 'git'));
});

// ---- the same name in another folder, an unreadable transcript, and ties ----

test('a call on a file of the same NAME in another folder of the project is not a call on this file', async () => {
  const dir = projects([[
    edit(`${ROOT}/sub/a.js`, 'other', 'other2', 1),
    edit(`${ROOT}/a.js`, 'mine', 'mine2', 2),
    edit(`${ROOT}/A.JS`, 'mine-again', 'mine-again2', 3),
  ]]);
  const r = await callsOf(dir, 'a.js');
  assert.deepStrictEqual(r.calls.map((c) => c.oldString), ['mine', 'mine-again']);
  const sub = await callsOf(dir, 'sub/a.js');
  assert.deepStrictEqual(sub.calls.map((c) => c.oldString), ['other']);
});

test('a project with transcripts says so, with or without a call on this file; one with none says it has none', async () => {
  const withCalls = await callsOf(projects([[edit(`${ROOT}/a.js`, 'o', 'n', 1)]]));
  assert.strictEqual(withCalls.transcripts, true);
  const noCalls = await callsOf(projects([[edit(`${ROOT}/b.js`, 'o', 'n', 1)]]));
  assert.strictEqual(noCalls.transcripts, true);
  assert.deepStrictEqual(noCalls.calls, []);
  const none = await callsOf(tmpDir('cc-diffk-empty-'));
  assert.strictEqual(none.transcripts, false);
});

test('calls that share a time stay in written order even when an earlier-written call is newer', async () => {
  const times = [2, 1, 1, 2, 1, 3, 1];
  const dir = projects([times.map((n, i) => edit(`${ROOT}/a.js`, `c${i}`, 'n', n))]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls.map((c) => c.oldString), ['c1', 'c2', 'c4', 'c6', 'c0', 'c3', 'c5']);
});

test('many calls with the same time come back in the order they were written, within a file and across files', async () => {
  const mk = (tag) => Array.from({ length: 12 }, (_, i) => edit(`${ROOT}/a.js`, `${tag}${String(i).padStart(2, '0')}`, 'n', 5));
  const dir = projects([mk('x'), mk('y')]);
  const r = await callsOf(dir);
  assert.deepStrictEqual(r.calls.map((c) => c.oldString), [...mk('x'), ...mk('y')].map((e) => e.message.content[0].input.old_string));
});
