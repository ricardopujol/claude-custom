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
