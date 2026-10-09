'use strict';
/**
 * Kill tests for the release-gate survivors S4 and S5 (Mortimer, 2026-10-09): host/task-logs.js `parseTaskPath` (the only thing a
 * delete may be aimed at) and host/task-logs-fs.js `deleteTaskLog` (the re-check at the moment of unlinking). The delete runs against
 * a fake `fsp`, so the stat each look sees can be chosen and every unlink is recorded; nothing here touches a real disk.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseTaskPath, classify } = require('../host/task-logs');
const { deleteTaskLog } = require('../host/task-logs-fs');

const ROOT = 'C:\\T\\claude';

test('S4: parseTaskPath refuses every shape that is not root/project/session/tasks/<id>.output', () => {
  const no = (root, p, why) => assert.strictEqual(parseTaskPath(root, p), null, why || p);
  no('', 'a/b/tasks/x.output', 'an empty root would let any 4-segment path through');
  no('', 'a/b/c/tasks/x.output', 'an empty root, whatever the depth');
  no(ROOT, `${ROOT}\\a\\b\\c\\tasks\\x.output`, 'one level too deep');
  no(ROOT, `${ROOT}\\b\\tasks\\x.output`, 'one level too shallow');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x.output\\`, 'trailing backslash');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x.output/`, 'trailing slash');
  no(ROOT, `${ROOT}\\.\\s\\tasks\\x.output`, 'a . project');
  no(ROOT, `${ROOT}\\p\\.\\tasks\\x.output`, 'a . session');
  no(ROOT, `${ROOT}\\..\\s\\tasks\\x.output`, 'a .. project');
  no(ROOT, `${ROOT}\\p\\..\\tasks\\x.output`, 'a .. session');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x.output.exe`, 'the .output suffix is anchored at the end');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x.outputs`, 'the .output suffix is anchored at the end (plural)');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\.output`, 'no empty name');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x`, 'no .output suffix at all');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x:y.output`, 'an alternate data stream');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x*.output`, 'a wildcard');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x?.output`, 'a wildcard (?)');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x"y.output`, 'a quote');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x<y.output`, '<');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x>y.output`, '>');
  no(ROOT, `${ROOT}\\p\\s\\tasks\\x|y.output`, '|');
  no(ROOT, `${ROOT}\\p:q\\s\\tasks\\x.output`, 'a colon in the project');
  no(ROOT, `${ROOT}\\p\\s:q\\tasks\\x.output`, 'a colon in the session');
  no(ROOT, `${ROOT}\\p\\s\\task\\x.output`, 'the folder must be named tasks');
  no(ROOT, `C:\\Other\\claude\\p\\s\\tasks\\x.output`, 'another root');
  no(ROOT, '', 'an empty path');
  no(null, `${ROOT}\\p\\s\\tasks\\x.output`);
  no(ROOT, null);
});

test('S4: parseTaskPath accepts the exact shape, with either separator, a trailing separator on the root and doubled separators', () => {
  const want = { project: 'p', session: 's', name: 'x.output' };
  assert.deepStrictEqual(parseTaskPath(ROOT, `${ROOT}\\p\\s\\tasks\\x.output`), want);
  assert.deepStrictEqual(parseTaskPath('C:\\T\\claude\\', `C:\\T\\claude\\p\\s\\tasks\\x.output`), want, 'a trailing separator on the root');
  assert.deepStrictEqual(parseTaskPath(ROOT, `${ROOT}\\\\p\\\\s\\tasks\\x.output`), want, 'doubled separators in the middle');
  assert.deepStrictEqual(parseTaskPath(ROOT, 'C:/T/claude/p/s/tasks/x.output'), want, 'forward slashes');
  assert.deepStrictEqual(parseTaskPath(ROOT, `c:\\t\\CLAUDE\\p\\s\\tasks\\x.output`), want, 'the root compares without case');
  assert.deepStrictEqual(parseTaskPath(ROOT, `${ROOT}\\p.q\\s\\tasks\\x.y.output`), { project: 'p.q', session: 's', name: 'x.y.output' });
});

// ---- S5 ---------------------------------------------------------------------------------------------------------------------------

const NOW = 2_000_000_000_000;
const IDLE = 15 * 60_000;
const MTIME = NOW - IDLE - 1000;
const BYTES = 1000;
const P1 = path.join(ROOT, 'p', 's', 'tasks', 'a.output');
const P2 = path.join(ROOT, 'p', 's', 'tasks', 'b.output');

const stat = (o = {}) => ({ isFile: () => true, dev: 1n, ino: 10n, mtimeMs: BigInt(MTIME), size: BigInt(BYTES), nlink: 1n, ...o });
const row = (o = {}) => ({ deletable: true, paths: [P1], mtimeMs: MTIME, bytes: BYTES, dev: '1', ino: '10', ...o });

/** `looks[path]` is the list of stats successive lstat calls on that path return (the last repeats); `unlinkErr[path]` an error code. */
function fakeFsp({ looks = {}, unlinkErr = {}, realpath = (p) => p, statfs } = {}) {
  const calls = { lstat: [], unlink: [] };
  const seen = {};
  const fsp = {
    async realpath(p) { const r = typeof realpath === 'function' ? realpath(p) : realpath; if (r instanceof Error) throw r; return r; },
    async lstat(p) {
      calls.lstat.push(p);
      const list = looks[p] || [stat()];
      const i = seen[p] = (seen[p] || 0) + 1;
      const s = list[Math.min(i, list.length) - 1];
      if (s instanceof Error) throw s;
      return s;
    },
    async unlink(p) { if (unlinkErr[p]) { const e = new Error('x'); e.code = unlinkErr[p]; throw e; } calls.unlink.push(p); },
    async statfs(r) { if (!statfs) throw new Error('no statfs'); return statfs(r); },
  };
  return { fsp, calls };
}
const run = (r, f, extra = {}) => deleteTaskLog(ROOT, r, { fsp: f.fsp, now: () => NOW, idleMs: IDLE, settleMs: 0, ...extra });

test('S5: the happy path unlinks the one file and counts it once', async () => {
  const f = fakeFsp();
  const res = await run(row(), f);
  assert.deepStrictEqual(f.calls.unlink, [P1]);
  assert.strictEqual(res.deleted, 1);
  assert.strictEqual(res.kept, 0);
  assert.strictEqual(res.failed, 0);
  assert.deepStrictEqual(res.deletedPaths, [P1]);
  assert.strictEqual(res.freed, BYTES, 'with no volume reading the claim is allowed');
});

test('S5: a file that is not the one the scan saw is kept, at the first look and at the second', async () => {
  const swaps = {
    'another inode': { ino: 11n },
    'another device': { dev: 2n },
    'a newer mtime': { mtimeMs: BigInt(MTIME + 1) },
    'a changed size': { size: BigInt(BYTES + 1) },
    'a directory named like the file': { isFile: () => false },
  };
  for (const [why, change] of Object.entries(swaps)) {
    for (const look of [0, 1]) {
      const looks = look === 0 ? [stat(change)] : [stat(), stat(change)];
      const f = fakeFsp({ looks: { [P1]: looks } });
      const res = await run(row(), f);
      assert.deepStrictEqual(f.calls.unlink, [], `${why}, look ${look + 1}: nothing is unlinked`);
      assert.strictEqual(res.kept, 1, `${why}, look ${look + 1}`);
      assert.strictEqual(res.deleted, 0, `${why}, look ${look + 1}`);
      assert.strictEqual(res.freed, 0, `${why}, look ${look + 1}`);
    }
  }
});

test('S5: the idle test is >= : exactly idleMs old is deleted, one ms younger is kept', async () => {
  const exact = fakeFsp({ looks: { [P1]: [stat({ mtimeMs: BigInt(NOW - IDLE) })] } });
  const r1 = await run(row({ mtimeMs: NOW - IDLE }), exact);
  assert.deepStrictEqual(exact.calls.unlink, [P1]);
  assert.strictEqual(r1.deleted, 1);
  const young = fakeFsp({ looks: { [P1]: [stat({ mtimeMs: BigInt(NOW - IDLE + 1) })] } });
  const r2 = await run(row({ mtimeMs: NOW - IDLE + 1 }), young);
  assert.deepStrictEqual(young.calls.unlink, []);
  assert.strictEqual(r2.kept, 1);
});

test('S5: one deleted and one kept is not reported as all deleted (nothing freed, kept counted)', async () => {
  const f = fakeFsp({ looks: { [P2]: [stat({ ino: 99n })] } });
  const res = await run(row({ paths: [P1, P2] }), f);
  assert.deepStrictEqual(f.calls.unlink, [P1]);
  assert.strictEqual(res.deleted, 1);
  assert.strictEqual(res.kept, 1);
  assert.strictEqual(res.freed, 0, 'a link is still there: the data is still there');
  assert.strictEqual(res.held, false);
});

test('S5: a failed or locked unlink is counted as such and claims no space', async () => {
  const failed = await run(row({ paths: [P1, P2] }), fakeFsp({ unlinkErr: { [P2]: 'EIO' } }));
  assert.deepStrictEqual([failed.deleted, failed.failed, failed.locked, failed.freed], [1, 1, 0, 0]);
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const locked = await run(row({ paths: [P1, P2] }), fakeFsp({ unlinkErr: { [P2]: code } }));
    assert.deepStrictEqual([locked.deleted, locked.failed, locked.locked, locked.freed], [1, 0, 1, 0], code);
  }
  const gone = await run(row({ paths: [P1, P2] }), fakeFsp({ unlinkErr: { [P2]: 'ENOENT' } }));
  assert.deepStrictEqual([gone.deleted, gone.gone, gone.failed, gone.freed], [1, 1, 0, BYTES], 'already gone counts as not failed');
});

test('S5: the space is claimed only when the volume grew by at least half the bytes; otherwise it is held', async () => {
  const reads = (...free) => { let i = 0; return () => ({ bavail: free[Math.min(i++, free.length - 1)], bsize: 1 }); };
  const grew = await run(row(), fakeFsp({ statfs: reads(10_000, 10_000 + BYTES / 2) }));
  assert.strictEqual(grew.freed, BYTES);
  assert.strictEqual(grew.held, false);
  const held = await run(row(), fakeFsp({ statfs: reads(10_000, 10_000 + BYTES / 2 - 1) }));
  assert.strictEqual(held.freed, 0);
  assert.strictEqual(held.held, true);
});

test('S5: a row that is not deletable, a bad row, a path of the wrong shape or an unresolvable root keeps everything and unlinks nothing', async () => {
  const cases = [
    ['not deletable', row({ deletable: false })],
    ['no paths array', row({ paths: 'x' })],
    ['mtime not finite', row({ mtimeMs: NaN })],
    ['bytes not finite', row({ bytes: Infinity })],
  ];
  for (const [why, r] of cases) {
    const f = fakeFsp();
    const res = await run(r, f);
    assert.deepStrictEqual(f.calls.unlink, [], why);
    assert.strictEqual(res.deleted, 0, why);
    assert.strictEqual(res.kept, Array.isArray(r.paths) ? r.paths.length : 0, why);
  }
  const manual = await run(row({ deletable: false, manualDelete: true }), fakeFsp());
  assert.strictEqual(manual.deleted, 1, 'a manual delete is allowed');
  const wrongShape = fakeFsp();
  const w = await run(row({ paths: [path.join(ROOT, 'p', 's', 'x.output')] }), wrongShape);
  assert.deepStrictEqual([w.kept, w.deleted, wrongShape.calls.unlink.length, wrongShape.calls.lstat.length], [1, 0, 0, 0], 'refused before it is stat-ed');
  const noRoot = fakeFsp({ realpath: (p) => (p === ROOT ? new Error('gone') : p) });
  const n = await run(row({ paths: [P1, P2] }), noRoot);
  assert.deepStrictEqual([n.kept, n.deleted, noRoot.calls.unlink.length], [2, 0, 0]);
});

test('S5: a folder that resolves outside the root (a junction swapped in) is kept', async () => {
  const f = fakeFsp({ realpath: (p) => (p === ROOT ? ROOT : 'C:\\Elsewhere') });
  const res = await run(row(), f);
  assert.deepStrictEqual([res.kept, res.deleted, f.calls.unlink.length], [1, 0, 0]);
  const moved = fakeFsp({ realpath: (p) => (p === ROOT ? ROOT : path.join(ROOT, 'q', 's', 'tasks')) });
  const m = await run(row(), moved);
  assert.deepStrictEqual([m.kept, m.deleted, moved.calls.unlink.length], [1, 0, 0], 'inside the root, but not where the path says');
});

test('S5: a file gone at the first look is counted gone, another error as failed; the wait only happens when something is left to delete', async () => {
  const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
  const eio = Object.assign(new Error('x'), { code: 'EIO' });
  const slept = [];
  const gone = await run(row(), fakeFsp({ looks: { [P1]: [enoent] } }), { settleMs: 50, sleep: async (ms) => { slept.push(ms); } });
  assert.deepStrictEqual([gone.gone, gone.failed, gone.deleted, slept.length], [1, 0, 0, 0]);
  const bad = await run(row(), fakeFsp({ looks: { [P1]: [eio] } }), { settleMs: 50, sleep: async (ms) => { slept.push(ms); } });
  assert.deepStrictEqual([bad.gone, bad.failed, bad.deleted, slept.length], [0, 1, 0, 0]);
  const ok = await run(row(), fakeFsp(), { settleMs: 50, sleep: async (ms) => { slept.push(ms); } });
  assert.deepStrictEqual([ok.deleted, slept], [1, [50]]);
});

test('S5 (classify): a manually deletable row carries the same guards the delete re-checks', () => {
  // a smoke check that the row classify produces is accepted by the delete (shape agreement between the two files)
  const files = [{ path: P1, project: 'p', session: 's', name: 'a.output', bytes: 200 * 1024 * 1024, mtimeMs: MTIME, dev: '1', ino: '10', nlink: 1 }];
  const [r] = classify({ files, registry: { ok: true, entries: [{ pid: 5, sessionId: 'other' }] }, listedPids: new Set([5]), now: NOW, seen: new Map([['s', [{ pid: 424242, start: null }]]]) });
  assert.strictEqual(r.deletable, true);
  assert.deepStrictEqual(r.paths, [P1]);
});
