'use strict';
/**
 * Open PRs for the git tree (documentation/PLAN_GIT_TREE.md Task 6): the PR number and title of every
 * open PR's head branch, from `gh` when it's there. Optional: anything short of a clean answer is
 * null (unknown), never an empty Map, which would say "no PR is open".
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseOpenPrs, readOpenPrs, GH_ARGS } = require('../host/open-prs');

test('gh JSON -> Map(head branch -> { pr, title })', () => {
  const m = parseOpenPrs('[{"headRefName":"feat/a","number":77,"title":"feat(strip): the menu"}]');
  assert.deepStrictEqual([...m], [['feat/a', { pr: 77, title: 'feat(strip): the menu' }]]);
});

test('no open PRs is an empty Map: a real answer', () => {
  assert.deepStrictEqual([...parseOpenPrs('[]\n')], []);
});

test('not JSON, not an array, or not a string is null: unknown', () => {
  assert.strictEqual(parseOpenPrs('gh: not logged in'), null);
  assert.strictEqual(parseOpenPrs('{"a":1}'), null);
  assert.strictEqual(parseOpenPrs(undefined), null);
});

test('an entry without a usable head or number is skipped; a missing title is null', () => {
  const m = parseOpenPrs('[{"headRefName":"","number":1},{"headRefName":"x","number":"2"},{"headRefName":"ok","number":3}]');
  assert.deepStrictEqual([...m], [['ok', { pr: 3, title: null }]]);
});

test('readOpenPrs runs gh with the agreed arguments and parses its output', async () => {
  let seen;
  const m = await readOpenPrs('C:/p/dev', { run: async (args, cwd) => { seen = [args, cwd]; return '[{"headRefName":"a","number":5,"title":"t"}]'; } });
  assert.deepStrictEqual(seen, [GH_ARGS, 'C:/p/dev']);
  assert.strictEqual(m.get('a').pr, 5);
});

test('gh missing, failing or timing out is null', async () => {
  assert.strictEqual(await readOpenPrs('C:/p', { run: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } }), null);
});

// PR #93 Miguel I3: main's own re-check before Type /merged types anything.
test('openPrFor: true for a branch with an open PR, false for one without, null when gh can not say', async () => {
  const { openPrFor } = require('../host/open-prs');
  const read = async () => new Map([['feat/b', { pr: 91, title: 't' }]]);
  assert.strictEqual(await openPrFor('C:/p', 'feat/b', { read }), true);
  assert.strictEqual(await openPrFor('C:/p', 'feat/c', { read }), false);
  assert.strictEqual(await openPrFor('C:/p', 'feat/b', { read: async () => null }), null);
  assert.strictEqual(await openPrFor('C:/p', 'feat/b', { read: async () => { throw new Error('boom'); } }), null);
  assert.strictEqual(await openPrFor('C:/p', '', { read }), false);
});

// --- Mortimer, release PR #101 gate (backlog #58): the parser's admit/refuse edges, the real runner, and
// openPrFor's own guard. Every case below varies ONE thing against a well-formed baseline.

test('the argv gh is run with is exactly the agreed one (a flag changed or dropped changes what the tree believes)', () => {
  assert.deepStrictEqual(GH_ARGS,
    ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '100']);
});

test('a head that is not a non-empty string, or a number that is not an integer, is refused; the rest are kept', () => {
  const text = JSON.stringify([
    { number: 1, headRefName: 42, title: 't' },
    { number: 1.5, headRefName: 'frac', title: 't' },
    { number: '7', headRefName: 'stringy', title: 't' },
    null,
    { headRefName: 'nonumber', title: 't' },
    { number: 2, headRefName: 'c', title: '' },
    { number: 3, headRefName: 'd', title: 5 },
    { number: 4, headRefName: 'e', title: 'real' },
  ]);
  assert.deepStrictEqual([...parseOpenPrs(text)], [
    ['c', { pr: 2, title: null }],
    ['d', { pr: 3, title: null }],
    ['e', { pr: 4, title: 'real' }],
  ]);
});

test('a truthy non-string head is refused on its own (the number and title are fine)', () => {
  assert.deepStrictEqual([...parseOpenPrs('[{"number":9,"headRefName":{"a":1},"title":"t"}]')], []);
  assert.deepStrictEqual([...parseOpenPrs('[{"number":9,"headRefName":["x"],"title":"t"}]')], []);
});

test('a non-integer or non-numeric number is refused on its own (the head and title are fine)', () => {
  assert.deepStrictEqual([...parseOpenPrs('[{"number":2.5,"headRefName":"h","title":"t"}]')], []);
  assert.deepStrictEqual([...parseOpenPrs('[{"number":"2","headRefName":"h","title":"t"}]')], []);
  assert.deepStrictEqual([...parseOpenPrs('[{"number":null,"headRefName":"h","title":"t"}]')], []);
});

// defaultRun has no seam, so child_process.execFile is replaced for a fresh load of the module. The module
// destructures execFile at load, which is why it is re-required here rather than patched afterwards.
function withExecFile(fake, body) {
  const cp = require('child_process');
  const real = cp.execFile;
  const key = require.resolve('../host/open-prs');
  const saved = require.cache[key];
  cp.execFile = fake;
  delete require.cache[key];
  const fresh = require('../host/open-prs');
  const restore = () => {
    cp.execFile = real;
    if (saved) require.cache[key] = saved; else delete require.cache[key];
  };
  return Promise.resolve().then(() => body(fresh)).finally(restore);
}

test('the real runner calls gh with the argv and exactly these options, and returns stdout', async () => {
  let call;
  await withExecFile((file, args, opts, cb) => { call = { file, args, opts }; cb(null, '[{"headRefName":"z","number":8,"title":"T"}]'); },
    async (fresh) => {
      const m = await fresh.readOpenPrs('C:/p/dev');
      assert.deepStrictEqual([...m], [['z', { pr: 8, title: 'T' }]]);
    });
  assert.strictEqual(call.file, 'gh');
  assert.deepStrictEqual(call.args, ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '100']);
  assert.deepStrictEqual(call.opts, { cwd: 'C:/p/dev', encoding: 'utf8', windowsHide: true, timeout: 2000 });
});

test('the real runner rejects on an error, so a failing gh is null (unknown), never an empty Map', async () => {
  await withExecFile((file, args, opts, cb) => cb(new Error('exit 1'), '[]'), async (fresh) => {
    assert.strictEqual(await fresh.readOpenPrs('C:/p'), null);
  });
});

test('openPrFor refuses a branch that is not a non-empty string without asking gh, even if the map holds that key', async () => {
  const { openPrFor } = require('../host/open-prs');
  let asked = 0;
  const read = async () => { asked += 1; return new Map([['', { pr: 1, title: null }], [42, { pr: 2, title: null }], [null, { pr: 3, title: null }]]); };
  for (const bad of ['', null, undefined, 42]) {
    assert.strictEqual(await openPrFor('C:/p', bad, { read }), false, String(bad));
  }
  assert.strictEqual(asked, 0, 'a bad branch never reaches gh');
});

test('openPrFor: a read that answers something other than a Map is unknown (null), not "no PR"', async () => {
  const { openPrFor } = require('../host/open-prs');
  assert.strictEqual(await openPrFor('C:/p', 'a', { read: async () => [] }), null);
  assert.strictEqual(await openPrFor('C:/p', 'a', { read: async () => ({}) }), null);
  assert.strictEqual(await openPrFor('C:/p', 'a', { read: async () => undefined }), null);
});

test('a non-string that would still parse as JSON once coerced is unknown, not an answer', () => {
  assert.strictEqual(parseOpenPrs({ toString: () => '[]' }), null);
  assert.strictEqual(parseOpenPrs(['[]']), null);
});
