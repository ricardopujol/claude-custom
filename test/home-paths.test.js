'use strict';
/**
 * app/home-paths.js (PR #263 Miguel Y2): Home's disk facts per path, cached until the source lists change, and never a disk call for a
 * UNC or \\?\ path on the main thread.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createHomePaths, isRemote } = require('../app/home-paths');

function rig() {
  const calls = { projectOf: [], exists: [] };
  const paths = createHomePaths({
    projectOf: (p) => { calls.projectOf.push(p); return { kind: 'flat', root: p, dev: p }; },
    exists: (p) => { calls.exists.push(p); return p !== 'C:\\gone'; },
  });
  return { paths, calls };
}

test('each path asks the disk once until clear(): a sync with the same lists does no disk work', () => {
  const t = rig();
  for (let i = 0; i < 3; i++) {
    assert.deepStrictEqual(t.paths.projectOf('C:\\a'), { kind: 'flat', root: 'C:\\a', dev: 'C:\\a' });
    assert.strictEqual(t.paths.exists('C:\\a'), true);
    assert.strictEqual(t.paths.exists('C:\\gone'), false);
  }
  assert.deepStrictEqual(t.calls.projectOf, ['C:\\a']);
  assert.deepStrictEqual(t.calls.exists, ['C:\\a', 'C:\\gone']);
  t.paths.clear();
  t.paths.projectOf('C:\\a');
  t.paths.exists('C:\\a');
  assert.deepStrictEqual(t.calls.projectOf, ['C:\\a', 'C:\\a'], 'asked again after a clear');
  assert.strictEqual(t.calls.exists.length, 3);
});

test('a UNC or \\\\?\\ path never reaches the disk: projectOf null (its own root), exists true (an offline share never freezes main)', () => {
  const t = rig();
  for (const p of ['\\\\server\\share\\repo', '//server/share/repo', '\\\\?\\C:\\long\\repo']) {
    assert.strictEqual(isRemote(p), true, p);
    assert.strictEqual(t.paths.projectOf(p), null);
    assert.strictEqual(t.paths.exists(p), true);
  }
  assert.deepStrictEqual(t.calls, { projectOf: [], exists: [] });
  assert.strictEqual(isRemote('C:\\a'), false);
  assert.strictEqual(isRemote(null), false);
});

test('a throwing disk call is cached as its answer (null, false) and never thrown', () => {
  const paths = createHomePaths({ projectOf: () => { throw new Error('EACCES'); }, exists: () => { throw new Error('EACCES'); } });
  assert.strictEqual(paths.projectOf('C:\\x'), null);
  assert.strictEqual(paths.exists('C:\\x'), false);
});

test('the cache is bounded: past MAX entries it starts again (a long-running Jiandu never grows it without end)', () => {
  const t = rig();
  const { MAX } = require('../app/home-paths');
  for (let i = 0; i <= MAX; i++) t.paths.exists(`C:\\p${i}`);
  t.paths.exists('C:\\p0');
  assert.strictEqual(t.calls.exists.length, MAX + 2, 'p0 was dropped and asked again');
});
