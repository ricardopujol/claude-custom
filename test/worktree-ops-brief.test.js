'use strict';
/**
 * host/worktree-ops.js, the brief's path (BACKLOG #119 A6): `sync-docs\scripts\brief-path.ps1` run on a worktree prints
 * the absolute path of that lane's handoff brief. Same run rules as the other contract scripts.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const ops = require('../host/worktree-ops');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { throw new Error('a script is never killed'); };
  return child;
}
const spawnOf = (child, calls = []) => (exe, args, opts) => { calls.push({ exe, args, opts }); return child; };
const run = (over = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...over });

test('syncDocsScriptsDir: the env override, else the sync-docs skill under the home folder', () => {
  assert.strictEqual(ops.syncDocsScriptsDir({ CLAUDE_CUSTOM_SYNCDOCS_SCRIPTS: 'D:\\stand-ins' }), 'D:\\stand-ins');
  const home = path.join(os.homedir(), '.claude', 'skills', 'sync-docs', 'scripts');
  assert.strictEqual(ops.syncDocsScriptsDir({ CLAUDE_CUSTOM_SYNCDOCS_SCRIPTS: '' }), home);
  assert.strictEqual(ops.syncDocsScriptsDir({}), home);
});

test('parseBriefPath: the last stdout line, when it is an absolute .md path', () => {
  const p = 'C:\\proj\\dev\\documentation\\handoffs\\CURRENT-feat-12-x.md';
  assert.deepStrictEqual(ops.parseBriefPath(run({ stdout: `${p}\r\n` })), { ok: true, path: p });
  assert.deepStrictEqual(ops.parseBriefPath(run({ stdout: `noise\n${p}\n\n` })), { ok: true, path: p });
});

test('parseBriefPath: a path that is not an absolute .md file is refused (nothing is written to it)', () => {
  for (const stdout of ['', 'CURRENT-x.md', 'C:\\x\\notes.txt', '\\\\server\\share\\CURRENT-x.md\0', '{"brief":"x"}']) {
    const r = ops.parseBriefPath(run({ stdout }));
    assert.strictEqual(r.ok, false, JSON.stringify(stdout));
    assert.strictEqual(typeof r.error, 'string');
  }
});

test('parseBriefPath: a failed run says what the script said; a timeout says it may still finish', () => {
  assert.deepStrictEqual(ops.parseBriefPath(run({ code: 1, stderr: 'not a git repo' })), { ok: false, error: 'not a git repo' });
  assert.match(ops.parseBriefPath(run({ timedOut: true, code: null })).error, /didn't finish in time/);
  assert.match(ops.parseBriefPath(run({ spawnError: 'ENOENT', code: null })).error, /couldn't run brief-path\.ps1: ENOENT/);
});

test('createOps.briefPath runs brief-path.ps1 -Path on the worktree and reads its answer', async () => {
  const calls = [];
  const child = fakeChild();
  const o = ops.createOps({ dir: 'D:\\s', syncDir: 'D:\\sync', spawn: spawnOf(child, calls), exists: () => true });
  const pending = o.briefPath({ path: 'C:\\proj\\feat-12-x' });
  child.stdout.emit('data', Buffer.from('C:\\proj\\dev\\documentation\\handoffs\\CURRENT-feat-12-x.md\r\n'));
  child.emit('exit', 0);
  child.emit('close', 0);
  assert.deepStrictEqual(await pending, { ok: true, path: 'C:\\proj\\dev\\documentation\\handoffs\\CURRENT-feat-12-x.md' });
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].args.includes(path.join('D:\\sync', 'brief-path.ps1')));
  assert.ok(calls[0].args.includes('-Path:C:\\proj\\feat-12-x'), 'bound with a colon, like every contract argument');
});

test('createOps.briefPath: no script installed is an answer, not a run', async () => {
  const calls = [];
  const o = ops.createOps({ dir: 'D:\\s', syncDir: 'D:\\sync', spawn: spawnOf(fakeChild(), calls), exists: () => false });
  const r = await o.briefPath({ path: 'C:\\proj\\feat-12-x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /brief-path\.ps1 isn't installed/);
  assert.strictEqual(calls.length, 0);
});

test('createOps.briefPath refuses a worktree path that is not a string, before running anything', async () => {
  const calls = [];
  const o = ops.createOps({ dir: 'D:\\s', syncDir: 'D:\\sync', spawn: spawnOf(fakeChild(), calls), exists: () => true });
  for (const bad of [undefined, null, '', 5]) assert.strictEqual((await o.briefPath({ path: bad })).ok, false);
  assert.strictEqual(calls.length, 0);
});

test('Dexter 7: brief-path.ps1 gets its own 30 s budget, not the 5 minutes of the worktree creator', async (t) => {
  assert.strictEqual(ops.TIMEOUT_MS.brief, 30000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();                     // never exits
  const o = ops.createOps({ dir: 'D:\s', syncDir: 'D:\sync', spawn: spawnOf(child), exists: () => true });
  const pending = o.briefPath({ path: 'C:\proj\feat-12-x' });
  t.mock.timers.tick(29_999);
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.strictEqual(settled, false, 'still waiting at 29.999 s');
  t.mock.timers.tick(2);
  const r = await pending;
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /brief-path\.ps1 didn't finish in time/);
});
