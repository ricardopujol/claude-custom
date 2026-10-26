'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { rowsOf, formatReport } = require('../host/usage-report');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

test('rows are sorted by count, ties by key, with whole days since last use', () => {
  const rows = rowsOf({
    'b:x': { count: 3, last: at(2.5) }, 'a:x': { count: 3, last: at(0) }, 'c:x': { count: 10, last: at(14) },
  }, NOW);
  assert.deepStrictEqual(rows.map((r) => [r.key, r.count, r.days]), [['c:x', 10, 14], ['a:x', 3, 0], ['b:x', 3, 2]]);
});

test('bad entries are skipped, a bad date is "unknown", the future is today', () => {
  const rows = rowsOf({ ok: { count: 1, last: 'nope' }, neg: { count: -1, last: at(1) }, str: 'x', fut: { count: 2, last: at(-3) } }, NOW);
  assert.deepStrictEqual(rows.map((r) => [r.key, r.days]), [['fut', 0], ['ok', null]]);
  assert.deepStrictEqual(rowsOf(null, NOW), []);
  assert.deepStrictEqual(rowsOf([], NOW), []);
});

test('the table has a header, aligned columns and the days in words', () => {
  const out = formatReport({ 'panel:git': { count: 42, last: at(0) }, 'wand:click': { count: 7, last: at(1) }, 'lean:on': { count: 1, last: at(9) } }, NOW);
  assert.strictEqual(out, [
    'key         count  last used',
    'panel:git      42  today',
    'wand:click      7  1 day ago',
    'lean:on         1  9 days ago',
  ].join('\n'));
});

test('an empty set says so', () => {
  assert.strictEqual(formatReport({}, NOW), 'No usage recorded yet.');
});
