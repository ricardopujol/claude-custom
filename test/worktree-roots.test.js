'use strict';
/**
 * host/worktree-roots.js: the worktree folders `git worktree list` knows, cached, for the occupancy
 * producer (backlog #44 + #47). Every worktree counts -- including one nested under dev\ -- because a
 * subagent's own isolation worktree is exactly where an agent can be working.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createRootsProvider, rootsFromPorcelain } = require('../host/worktree-roots');

const PORCELAIN = [
  'worktree C:/proj/dev', 'HEAD aaa', 'branch refs/heads/develop', '',
  'worktree C:/proj/feat-x', 'HEAD bbb', 'branch refs/heads/feat/x', '',
  'worktree C:/proj/dev/.claude/worktrees/agent-1', 'HEAD ccc', 'detached', '',
  'worktree C:/proj/gone', 'HEAD ddd', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
  'worktree C:/proj/bare.git', 'bare', '',
].join('\n');

test('every listed worktree is a root, nested ones included; prunable and bare ones are not', () => {
  const roots = rootsFromPorcelain(PORCELAIN);
  assert.deepStrictEqual(roots, [path.resolve('C:/proj/dev'), path.resolve('C:/proj/feat-x'),
    path.resolve('C:/proj/dev/.claude/worktrees/agent-1')]);
});

test('junk in is an empty list out', () => {
  for (const v of [null, undefined, 3, '', 'garbage\nlines']) assert.deepStrictEqual(rootsFromPorcelain(v), []);
});

function rig(over = {}) {
  const r = { clock: 1000, calls: [], text: PORCELAIN, logs: [] };
  r.p = createRootsProvider({
    cwd: path.resolve('C:/proj/dev'),
    run: async (args) => { r.calls.push(args); if (r.text instanceof Error) throw r.text; return r.text; },
    now: () => r.clock, ttlMs: 15000, log: (...a) => r.logs.push(a.join(' ')), ...over,
  });
  return r;
}

test('before the first answer the list is just the host\'s own folder, and it is stale', () => {
  const r = rig();
  assert.deepStrictEqual(r.p.get(), [path.resolve('C:/proj/dev')]);
  assert.strictEqual(r.p.stale(), true);
});

test('refresh asks git in the host\'s folder and caches the answer for the ttl', async () => {
  const r = rig();
  const roots = await r.p.refresh();
  assert.strictEqual(roots.length, 3);
  assert.deepStrictEqual(r.calls[0].slice(0, 2), ['-C', path.resolve('C:/proj/dev')]);
  assert.ok(r.calls[0].includes('worktree') && r.calls[0].includes('list') && r.calls[0].includes('--porcelain'));
  assert.strictEqual(r.p.stale(), false);
  r.clock += 14999;
  assert.strictEqual(r.p.stale(), false);
  r.clock += 1;
  assert.strictEqual(r.p.stale(), true);
});

test('overlapping refreshes share one git call', async () => {
  const r = rig();
  await Promise.all([r.p.refresh(), r.p.refresh(), r.p.refresh()]);
  assert.strictEqual(r.calls.length, 1);
});

test('a git failure keeps the last good list, says so once, and counts as stale so it is retried', async () => {
  const r = rig();
  await r.p.refresh();
  r.text = new Error('git exploded');
  r.clock += 20000;
  await r.p.refresh();
  await r.p.refresh();
  assert.strictEqual(r.p.get().length, 3);
  assert.strictEqual(r.logs.filter(l => /git exploded/.test(l)).length, 1);
  assert.strictEqual(r.p.stale(), true);
});

test('an answer with no worktree at all (git said something odd) never wipes the list to nothing', async () => {
  const r = rig();
  await r.p.refresh();
  r.text = 'fatal: not a git repository';
  r.clock += 20000;
  await r.p.refresh();
  assert.strictEqual(r.p.get().length, 3);
});

test('the host\'s own folder is always in the list, even if git doesn\'t name it', async () => {
  const r = rig();
  r.text = 'worktree C:/proj/feat-x\nHEAD b\nbranch refs/heads/x\n';
  await r.p.refresh();
  assert.ok(r.p.get().some(p => p === path.resolve('C:/proj/dev')));
});
