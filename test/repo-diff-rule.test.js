'use strict';
/**
 * PR #95 Dexter D2: WHICH diff the reader shows, defined once.
 *
 *   1. Claude's own Edit / Write calls are the answer while they still describe the file: the file has not
 *      changed since the last of them COMPLETED (its tool_result time; a call waiting at the permission prompt
 *      is written long after it was requested).
 *   2. Once the file has changed since (a Bash sed, a hand edit, another session), those calls describe a past
 *      state and may already be committed: show `git diff HEAD` of the CURRENT state, when it is non-empty.
 *   3. With no calls at all, git's diff, when non-empty; else nothing.
 *   A file git calls modified gets the Diff toggle even with no overlay entry (host: `modified` on a read).
 */
const test = require('node:test');
const assert = require('node:assert');
const { pickDiff, diffFor, gitModified, SLACK_MS } = require('../host/repo-diff');
const { tmpDir } = require('./tmp-dir');
const fs = require('fs');
const path = require('path');

const T = Date.parse('2026-10-03T12:00:00Z');
const call = (over = {}) => ({ tool: 'Edit', at: T, doneAt: T + 500, oldString: 'x', newString: 'y', ...over });
const GIT = 'diff --git a/a.js b/a.js\n-y\n+z';

test('1: the file has not changed since the last call finished: Claude\'s calls', () => {
  const r = pickDiff({ calls: [call()], gitText: GIT, fileMtimeMs: T + 500 + SLACK_MS });
  assert.strictEqual(r.source, 'claude');
});

test('1: a file written moments after the call finished (the write itself) is not "changed since"', () => {
  assert.strictEqual(pickDiff({ calls: [call()], gitText: GIT, fileMtimeMs: T + 800 }).source, 'claude');
});

test('2: changed since the last call (a Bash sed): the git diff of the CURRENT state wins', () => {
  const r = pickDiff({ calls: [call()], gitText: GIT, fileMtimeMs: T + 500 + SLACK_MS + 1 });
  assert.deepStrictEqual(r, { source: 'git', text: GIT });
});

test('2: ...unless git has nothing (the change was reverted, or it equals HEAD): then Claude\'s calls are all there is', () => {
  assert.strictEqual(pickDiff({ calls: [call()], gitText: '', fileMtimeMs: T + 1e9 }).source, 'claude');
  assert.strictEqual(pickDiff({ calls: [call()], gitText: null, fileMtimeMs: T + 1e9 }).source, 'claude');
});

test('2: the LAST of several calls decides, by when it finished', () => {
  const calls = [call({ doneAt: T }), call({ doneAt: T + 60000 })];
  assert.strictEqual(pickDiff({ calls, gitText: GIT, fileMtimeMs: T + 61000 }).source, 'claude');
  assert.strictEqual(pickDiff({ calls, gitText: GIT, fileMtimeMs: T + 60000 + SLACK_MS + 1 }).source, 'git');
});

test('2: a call with no finish time falls back to its request time, and with neither the calls stand (cannot tell)', () => {
  assert.strictEqual(pickDiff({ calls: [call({ doneAt: NaN })], gitText: GIT, fileMtimeMs: T + SLACK_MS + 1 }).source, 'git');
  assert.strictEqual(pickDiff({ calls: [call({ doneAt: NaN, at: NaN })], gitText: GIT, fileMtimeMs: T + 1e9 }).source, 'claude');
});

test('2: an unknown file time (stat failed, or not asked) leaves Claude\'s calls in place', () => {
  for (const m of [undefined, null, NaN, 'x']) assert.strictEqual(pickDiff({ calls: [call()], gitText: GIT, fileMtimeMs: m }).source, 'claude');
});

test('3: no calls: git when non-empty, else nothing', () => {
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: GIT }), { source: 'git', text: GIT });
  assert.deepStrictEqual(pickDiff({ calls: [], gitText: '' }), { source: null, text: '' });
});

// ---- diffFor wires the rule to git and the file's time ----

test('diffFor asks git even when calls exist, because the file may have moved on', async () => {
  const dir = tmpDir('cc-rule-');
  const proj = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(proj, { recursive: true });
  const ROOT = 'C:/Users/ricar/VibeCode/proj';
  const lines = [
    { type: 'assistant', timestamp: new Date(T).toISOString(), message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' } }] } },
    { type: 'user', timestamp: new Date(T + 400).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ].map(l => JSON.stringify(l)).join('\n');
  fs.writeFileSync(path.join(proj, 's.jsonl'), lines);
  const execFile = (f, a, o, cb) => cb(null, GIT, '');
  const moved = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile, fileMtimeMs: T + 3600000 });
  assert.strictEqual(moved.source, 'git');
  const still = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile, fileMtimeMs: T + 450 });
  assert.strictEqual(still.source, 'claude');
  assert.strictEqual(still.count, 1);
});

test('diffFor: calls exist and git FAILS: Claude\'s calls are shown, not an error (git is only a refinement here)', async () => {
  const dir = tmpDir('cc-rule2-');
  const proj = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(proj, { recursive: true });
  const ROOT = 'C:/Users/ricar/VibeCode/proj';
  fs.writeFileSync(path.join(proj, 's.jsonl'), [
    { type: 'assistant', timestamp: new Date(T).toISOString(), message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' } }] } },
    { type: 'user', timestamp: new Date(T + 400).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ].map(l => JSON.stringify(l)).join('\n'));
  const r = await diffFor({ root: ROOT, rel: 'a.js', projectsDir: dir, execFile: (f, a, o, cb) => cb(new Error('x'), '', 'fatal: bad'), fileMtimeMs: T + 1e9 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'claude');
});

// ---- is the file modified? (the Diff toggle's reach) ----

test('gitModified: git diff --quiet exits 1 for a modified file, 0 for a clean one', async () => {
  let seen;
  const mk = (code) => (f, a, o, cb) => { seen = a; cb(code === 0 ? null : Object.assign(new Error('x'), { code })); };
  assert.strictEqual(await gitModified('C:\\r', 'a.js', { execFile: mk(1) }), true);
  assert.strictEqual(await gitModified('C:\\r', 'a.js', { execFile: mk(0) }), false);
  assert.ok(seen.includes('--quiet') && seen.includes('--no-ext-diff') && seen.includes('--no-textconv'));
  assert.deepStrictEqual(seen.slice(-3), ['HEAD', '--', ':(literal)a.js']);
});

test('gitModified: any other failure is "can\'t tell" (null), never false', async () => {
  const bad = (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 128 }));
  assert.strictEqual(await gitModified('C:\\r', 'a.js', { execFile: bad }), null);
  const enoent = (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }));
  assert.strictEqual(await gitModified('C:\\r', 'a.js', { execFile: enoent }), null);
});
