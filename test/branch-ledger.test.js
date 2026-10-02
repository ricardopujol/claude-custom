'use strict';
/**
 * The branch ledger's pure core (documentation/PLAN_GIT_TREE.md Tasks 3-4, G1-G3): one transcript's
 * lines into its record, records merged across hosts, totals per branch.
 */
const test = require('node:test');
const assert = require('node:assert');

const { addLines, emptyRecord, spendOf } = require('../host/branch-ledger');

const ROOT = 'C:\\p';
const a = (id, branch, input, cwd = 'C:\\p\\dev', ts = '2026-09-20T10:00:00Z') => JSON.stringify({
  type: 'assistant', gitBranch: branch, cwd, timestamp: ts,
  message: { id, usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 999 } },
});
const lines = (...l) => l.join('\n') + '\n';

test('spend is input + output + cacheWrite; cache reads never count', () => {
  assert.strictEqual(spendOf({ input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 }), 10);
});

test('a string or null is not a number: no NaN, no coerced value', () => {
  assert.strictEqual(spendOf({ input_tokens: '7', output_tokens: null, cache_creation_input_tokens: NaN }), 0);
  assert.strictEqual(spendOf(null), 0);
});

test('a repeated id on the next line counts once; a line with no id always counts', () => {
  const r = emptyRecord();
  addLines(r, lines(a('m1', 'feat/a', 10), a('m1', 'feat/a', 10), a(undefined, 'feat/a', 4)), ROOT);
  assert.strictEqual(r.branches['feat/a'].spend, 11 + 5);
});

test('lastId carries across calls: a repeat split over two reads still counts once', () => {
  const r = emptyRecord();
  addLines(r, lines(a('m1', 'feat/a', 10)), ROOT);
  addLines(r, lines(a('m1', 'feat/a', 10)), ROOT);
  assert.strictEqual(r.branches['feat/a'].spend, 11);
  assert.strictEqual(r.lastId, 'm1');
});

test('outside the project, no gitBranch, no usage or not JSON: nothing', () => {
  const r = emptyRecord();
  addLines(r, lines(
    a('x', 'feat/a', 10, 'C:\\p-other\\dev'),
    JSON.stringify({ type: 'assistant', cwd: 'C:\\p\\dev', message: { id: 'y', usage: { input_tokens: 1 } } }),
    JSON.stringify({ type: 'user', gitBranch: 'feat/a', cwd: 'C:\\p\\dev', message: { content: 'has "usage" in it' } }),
    '{oops "usage"'), ROOT);
  assert.deepStrictEqual(r.branches, {});
});

test('the project root itself counts, as well as anything inside it', () => {
  const r = emptyRecord();
  addLines(r, lines(a('1', 'develop', 1, 'C:\\p'), a('2', 'develop', 1, 'c:/p/feat-a/sub')), ROOT);
  assert.strictEqual(r.branches.develop.spend, 4);
});

test('first and last day, and the cwds a branch ran in; runBranch is the last counted branch', () => {
  const r = emptyRecord();
  addLines(r, lines(
    a('1', 'feat/a', 1, 'C:\\p\\feat-a', '2026-09-21T01:00:00Z'),
    a('2', 'feat/a', 1, 'c:\\P\\feat-a\\', '2026-09-20T01:00:00Z'),
    a('3', 'feat/b', 1, 'C:\\p\\dev', '2026-09-22T01:00:00Z')), ROOT);
  assert.deepStrictEqual(r.branches['feat/a'], { spend: 4, first: '2026-09-20', last: '2026-09-21', cwds: ['C:\\p\\feat-a'] });
  assert.strictEqual(r.runBranch, 'feat/b');
});

test('the text after the last newline is not counted (the caller keeps it for next time)', () => {
  const r = emptyRecord();
  addLines(r, a('1', 'feat/a', 10), ROOT);
  assert.deepStrictEqual(r.branches, {});
});
