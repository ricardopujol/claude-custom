'use strict';
/**
 * PR #95 Dexter D1 end to end: a failed or refused Edit / Write is not a change, in ●N (host/fog.js), in the
 * overlay and in the Diff (host/repo-diff.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { readFog } = require('../host/fog');
const { rollUp } = require('../host/repo-overlay');
const { claudeCallsFor, pickDiff, renderCalls } = require('../host/repo-diff');

const CWD = 'C:/Users/ricar/VibeCode/proj';
const T0 = Date.parse('2026-09-13T12:00:00Z');
const use = (id, name, input, n) => ({ type: 'assistant', timestamp: new Date(T0 + n * 1000).toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, is_error) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error === undefined ? {} : { is_error }) }] } });
const dirWith = (entries) => {
  const dir = tmpDir('cc-failed-edits-');
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));
  return dir;
};
const F = CWD + '/a.js';

// "Found 2 matches", then a retry that worked
const RETRY = [
  use('t1', 'Edit', { file_path: F, old_string: 'foo()', new_string: 'bar()' }, 1),
  res('t1', 'Found 2 matches of the string to replace, but replace_all is false.', true),
  use('t2', 'Edit', { file_path: F, old_string: 'x\nfoo()', new_string: 'x\nbar()' }, 2),
  res('t2', 'The file a.js has been updated.'),
];
// the person said No at the permission prompt
const REJECTED = [
  use('w1', 'Write', { file_path: CWD + '/b.js', content: 'whole new file\n' }, 3),
  res('w1', "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).", true),
];

test('fog: the failed Edit is not counted: a.js is \u25cf1, not \u25cf2', async () => {
  const fog = await readFog({ cwd: CWD, projectsDir: dirWith(RETRY), now: () => T0 });
  const e = fog.files.find(f => f.path === 'a.js');
  assert.strictEqual(e.edits, 1);
  assert.strictEqual(rollUp(fog.files).files.find(f => f.path === 'a.js').edits, 1);
});

test('fog: a refused Write leaves the file untouched: no entry at all, so not "edited" and no Diff toggle', async () => {
  const fog = await readFog({ cwd: CWD, projectsDir: dirWith([...RETRY, ...REJECTED]), now: () => T0 });
  assert.strictEqual(fog.files.find(f => f.path === 'b.js'), undefined);
  assert.deepStrictEqual(rollUp(fog.files).files.map(f => f.path), ['a.js']);
});

test('fog: a Write that was never answered is not counted either, but a Read still is (reads need no result)', async () => {
  const fog = await readFog({ cwd: CWD, projectsDir: dirWith([
    use('w1', 'Write', { file_path: CWD + '/c.js', content: 'x' }, 1),
    use('r1', 'Read', { file_path: CWD + '/d.js' }, 2),
  ]), now: () => T0 });
  assert.deepStrictEqual(fog.files.map(f => [f.path, f.tier]), [['d.js', 'read']]);
});

test('fog: an edit that failed does not make a file edited, even when it was also read', async () => {
  const fog = await readFog({ cwd: CWD, projectsDir: dirWith([
    use('r1', 'Read', { file_path: F }, 1),
    use('t1', 'Edit', { file_path: F, old_string: 'a', new_string: 'b' }, 2),
    res('t1', 'String to replace not found in file.', true),
  ]), now: () => T0 });
  assert.strictEqual(fog.files.find(f => f.path === 'a.js').tier, 'read');
});

test('diff: one hunk for the retry, none for the edit that failed', async () => {
  const r = await claudeCallsFor({ root: CWD, rel: 'a.js', projectsDir: dirWith(RETRY) });
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].oldString, 'x\nfoo()');
  assert.strictEqual(renderCalls(r.calls).split('\n').filter(l => l.startsWith('@@')).length, 1);
});

test('diff: a refused Write gives no calls, so the Diff source is not Claude', async () => {
  const r = await claudeCallsFor({ root: CWD, rel: 'b.js', projectsDir: dirWith(REJECTED) });
  assert.deepStrictEqual(r.calls, []);
  assert.notStrictEqual(pickDiff({ calls: r.calls, gitText: '' }).source, 'claude');
});
