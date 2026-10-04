'use strict';
/**
 * The real `gh` runner behind the bedtime chip's PR count, and the count's entry filter (backlog #60,
 * Mortimer's release-#101 part 2): the same gap part 1 found in open-prs. The parser and the query were tested
 * through an injected runner; the real one, its options and its failure path were not.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseCount, nightPrArgs } = require('../host/night-prs');

// defaultRun has no seam, so child_process.execFile is replaced for a fresh load of the module. The module
// destructures execFile at load, which is why it is re-required here rather than patched afterwards.
function withExecFile(fake, body) {
  const cp = require('child_process');
  const real = cp.execFile;
  const key = require.resolve('../host/night-prs');
  const saved = require.cache[key];
  cp.execFile = fake;
  delete require.cache[key];
  const fresh = require('../host/night-prs');
  const restore = () => {
    cp.execFile = real;
    if (saved) require.cache[key] = saved; else delete require.cache[key];
  };
  return Promise.resolve().then(() => body(fresh)).finally(restore);
}

test('the real runner calls gh with the query for the night and exactly these options, and counts what it prints', async () => {
  let call;
  const since = Date.parse('2026-10-03T01:02:03.456Z');
  await withExecFile((file, args, opts, cb) => { call = { file, args, opts }; cb(null, '[{"number":1},{"number":2}]'); },
    async (fresh) => {
      assert.strictEqual(await fresh.countNightPrs('C:/p/dev', since), 2);
    });
  assert.strictEqual(call.file, 'gh');
  assert.deepStrictEqual(call.args, nightPrArgs(since));
  assert.deepStrictEqual(call.args, ['pr', 'list', '--author', '@me', '--state', 'all', '--search', 'created:>=2026-10-03T01:02:03Z',
    '--json', 'number', '--limit', '200']);
  assert.deepStrictEqual(call.opts, { cwd: 'C:/p/dev', encoding: 'utf8', windowsHide: true, timeout: 4000 });
});

test('the date sent to gh carries no milliseconds, whatever the start time had', () => {
  for (const ms of [0, 1, 999]) {
    const args = nightPrArgs(Date.parse('2026-10-03T01:02:03.000Z') + ms);
    assert.strictEqual(args[args.indexOf('--search') + 1], 'created:>=2026-10-03T01:02:03Z', String(ms));
  }
});

test('the real runner rejects on an error, so a failing gh is null (unknown), never 0', async () => {
  await withExecFile((file, args, opts, cb) => cb(new Error('exit 1'), '[{"number":1}]'), async (fresh) => {
    assert.strictEqual(await fresh.countNightPrs('C:/p', Date.now()), null);
  });
});

test('the real runner hands back stdout only when there is no error', async () => {
  await withExecFile((file, args, opts, cb) => cb(null, '[]'), async (fresh) => {
    assert.strictEqual(await fresh.countNightPrs('C:/p', Date.now()), 0);
  });
});

test('a start that is not a positive finite number asks gh nothing and answers null', async () => {
  let asked = 0;
  await withExecFile((file, args, opts, cb) => { asked += 1; cb(null, '[]'); }, async (fresh) => {
    for (const since of [0, -1, NaN, Infinity, -Infinity, '5', null, undefined, {}, [5]]) {
      assert.strictEqual(await fresh.countNightPrs('C:/p', since), null, String(since));
      assert.strictEqual(nightPrArgs(since), null, String(since));
    }
  });
  assert.strictEqual(asked, 0);
});

test('a positive start of 1 ms is a real time', () => {
  assert.notStrictEqual(nightPrArgs(1), null);
});

test('parseCount counts only entries that are objects with an integer number; null and non-object entries do not throw', () => {
  assert.strictEqual(parseCount(JSON.stringify([{ number: 1 }, { number: '2' }, null, {}, 7, 'x', { number: 1.5 }, { number: 3 }, [], true])), 2);
  assert.strictEqual(parseCount('[null]'), 0);
  assert.strictEqual(parseCount('[null, {"number": 4}]'), 1);
});

test('parseCount: text that is not a string is unknown even when it would parse as JSON once coerced', () => {
  assert.strictEqual(parseCount({ toString: () => '[]' }), null);
  assert.strictEqual(parseCount(['[]']), null);
  assert.strictEqual(parseCount(undefined), null);
  assert.strictEqual(parseCount(null), null);
});

test('parseCount: invalid JSON and JSON that is not a list are unknown', () => {
  for (const t of ['{bad', '', '{"number":1}', '"x"', '5', 'null']) assert.strictEqual(parseCount(t), null, t);
});
