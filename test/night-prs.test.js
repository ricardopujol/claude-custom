'use strict';
/**
 * "PRs so far" for the bedtime chip (host/night-prs.js, backlog #52). gh is optional: any failure is null
 * (unknown, drawn "PRs: ?"), never 0, and a night that opened no PR is a real 0 only when gh said so.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { countNightPrs, parseCount, nightPrArgs } = require('../host/night-prs');

const SINCE = Date.UTC(2026, 9, 3, 6, 15, 0);

test('parseCount: the length of the list gh printed; anything else is unknown, not zero', () => {
  assert.strictEqual(parseCount('[]'), 0);
  assert.strictEqual(parseCount('[{"number":1},{"number":2},{"number":9}]'), 3);
  for (const bad of ['', 'not json', '{}', 'null', '"x"', '5', null, undefined, 4, {}]) assert.strictEqual(parseCount(bad), null, String(bad));
});

test('parseCount: entries that are not PRs are not counted', () => {
  assert.strictEqual(parseCount('[{"number":1},null,3,{"x":1},{"number":"7"}]'), 1);
});

test('the query is my PRs created at or after the start, as a UTC timestamp, in any state, with room to count', () => {
  const args = nightPrArgs(SINCE);
  assert.deepStrictEqual(args, ['pr', 'list', '--author', '@me', '--state', 'all', '--search', 'created:>=2026-10-03T06:15:00Z',
    '--json', 'number', '--limit', '200']);
});

test('the query is built only from a real time: a missing or absurd start asks nothing', async () => {
  for (const bad of [undefined, null, NaN, Infinity, 'x', -1, 0]) {
    assert.strictEqual(nightPrArgs(bad), null, String(bad));
    let ran = false;
    assert.strictEqual(await countNightPrs('C:/p', bad, { run: async () => { ran = true; return '[]'; } }), null);
    assert.strictEqual(ran, false);
  }
});

test('countNightPrs asks in the project folder and counts what gh lists', async () => {
  const seen = [];
  const n = await countNightPrs('C:/proj/dev', SINCE, { run: async (args, cwd) => { seen.push([args, cwd]); return '[{"number":96},{"number":97}]'; } });
  assert.strictEqual(n, 2);
  assert.strictEqual(seen[0][1], 'C:/proj/dev');
  assert.deepStrictEqual(seen[0][0], nightPrArgs(SINCE));
});

test('gh missing, logged out, offline, slow or garbled: null, never 0', async () => {
  assert.strictEqual(await countNightPrs('C:/p', SINCE, { run: async () => { throw new Error('ENOENT'); } }), null);
  assert.strictEqual(await countNightPrs('C:/p', SINCE, { run: () => { throw new Error('sync'); } }), null);
  assert.strictEqual(await countNightPrs('C:/p', SINCE, { run: async () => 'HTTP 401' }), null);
  assert.strictEqual(await countNightPrs('C:/p', SINCE, { run: async () => '' }), null);
});

test('property: the count is never negative, never fractional, and null exactly when the list is not a list', () => {
  fc.assert(fc.property(fc.jsonValue(), (v) => {
    const n = parseCount(JSON.stringify(v));
    if (!Array.isArray(v)) return n === null;
    return Number.isInteger(n) && n >= 0 && n <= v.length;
  }));
});
