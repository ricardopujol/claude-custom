'use strict';
/**
 * #50: the reader's Compare view lines the disk's version up against yours. The alignment is a shortest-edit
 * line diff; what matters, and what the properties pin, is that it LOSES NOTHING: the rows read back as exactly
 * the two texts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { diffLines, linesOf, MAX_CELLS } = require('../app/repo-linediff');

const disk = (rows) => rows.filter(r => r.kind !== 'add').map(r => r.text);
const mine = (rows) => rows.filter(r => r.kind !== 'del').map(r => r.text);

test('identical texts are all "same" rows, numbered on both sides', () => {
  const rows = diffLines('a\nb\n', 'a\nb\n');
  assert.deepStrictEqual(rows, [
    { kind: 'same', text: 'a', diskNo: 1, mineNo: 1 },
    { kind: 'same', text: 'b', diskNo: 2, mineNo: 2 },
  ]);
});

test('a changed line is a del then an add, with the right numbers either side of it', () => {
  const rows = diffLines('a\nb\nc', 'a\nB\nc');
  assert.deepStrictEqual(rows, [
    { kind: 'same', text: 'a', diskNo: 1, mineNo: 1 },
    { kind: 'del', text: 'b', diskNo: 2, mineNo: null },
    { kind: 'add', text: 'B', diskNo: null, mineNo: 2 },
    { kind: 'same', text: 'c', diskNo: 3, mineNo: 3 },
  ]);
});

test('an inserted line and a removed line align around the lines they leave alone', () => {
  assert.deepStrictEqual(diffLines('a\nc', 'a\nb\nc').map(r => r.kind), ['same', 'add', 'same']);
  assert.deepStrictEqual(diffLines('a\nb\nc', 'a\nc').map(r => r.kind), ['same', 'del', 'same']);
});

test('empty against something is all adds (or all dels); empty against empty is nothing', () => {
  assert.deepStrictEqual(diffLines('', ''), []);
  assert.deepStrictEqual(diffLines('', 'x\ny').map(r => r.kind), ['add', 'add']);
  assert.deepStrictEqual(diffLines('x\ny', '').map(r => r.kind), ['del', 'del']);
});

test('a trailing newline is not a line: "a\\n" and "a" are the same text to the eye', () => {
  assert.deepStrictEqual(linesOf('a\nb\n'), ['a', 'b']);
  assert.deepStrictEqual(linesOf('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(linesOf(''), []);
  assert.deepStrictEqual(linesOf('\n'), ['']);
  assert.ok(diffLines('a\n', 'a').every(r => r.kind === 'same'));
});

test('a blank line in the middle is a real line', () => {
  assert.deepStrictEqual(diffLines('a\n\nb', 'a\nb').map(r => `${r.kind}:${r.text}`), ['same:a', 'del:', 'same:b']);
});

test('a pair too big to align cell by cell still loses nothing: the middle shows as dels then adds', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  assert.ok(3000 * 3000 > MAX_CELLS);
  const rows = diffLines(a, b);
  assert.deepStrictEqual(disk(rows), linesOf(a));
  assert.deepStrictEqual(mine(rows), linesOf(b));
  assert.strictEqual(rows.filter(r => r.kind === 'same').length, 0);
  assert.ok(rows.slice(0, 3000).every(r => r.kind === 'del'));
});

test('a shared head and tail are kept even when the middle is too big to align', () => {
  const mid = (p) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`);
  const a = ['top', ...mid('a'), 'bottom'].join('\n');
  const b = ['top', ...mid('b'), 'bottom'].join('\n');
  const rows = diffLines(a, b);
  assert.deepStrictEqual([rows[0].kind, rows[rows.length - 1].kind], ['same', 'same']);
  assert.deepStrictEqual(disk(rows), linesOf(a));
  assert.deepStrictEqual(mine(rows), linesOf(b));
});

const lines = fc.array(fc.constantFrom('a', 'b', 'c', '', 'x y', 'a'), { maxLength: 12 });
const text = lines.map(l => l.join('\n'));

test('PROPERTY: the rows read back as exactly the two texts (nothing lost, nothing invented, order kept)', () => {
  fc.assert(fc.property(text, text, (a, b) => {
    const rows = diffLines(a, b);
    assert.deepStrictEqual(disk(rows), linesOf(a));
    assert.deepStrictEqual(mine(rows), linesOf(b));
  }), { numRuns: 300 });
});

test('PROPERTY: line numbers count each side up from 1 with no gaps, and only on the rows that have that side', () => {
  fc.assert(fc.property(text, text, (a, b) => {
    const rows = diffLines(a, b);
    const d = rows.filter(r => r.diskNo !== null).map(r => r.diskNo);
    const m = rows.filter(r => r.mineNo !== null).map(r => r.mineNo);
    assert.deepStrictEqual(d, d.map((_, i) => i + 1));
    assert.deepStrictEqual(m, m.map((_, i) => i + 1));
    for (const r of rows) {
      assert.strictEqual(r.diskNo === null, r.kind === 'add');
      assert.strictEqual(r.mineNo === null, r.kind === 'del');
    }
  }), { numRuns: 300 });
});

test('PROPERTY: the same text against itself has no del and no add', () => {
  fc.assert(fc.property(text, (a) => {
    assert.ok(diffLines(a, a).every(r => r.kind === 'same'));
  }), { numRuns: 200 });
});

test('PROPERTY: the number of "same" rows is a common subsequence, so never more than the shorter side', () => {
  fc.assert(fc.property(text, text, (a, b) => {
    const same = diffLines(a, b).filter(r => r.kind === 'same').length;
    assert.ok(same <= Math.min(linesOf(a).length, linesOf(b).length));
  }), { numRuns: 200 });
});
