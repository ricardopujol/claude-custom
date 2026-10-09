'use strict';
/**
 * Citations in a local model's answer (BACKLOG #33). A small model invents file names and line numbers. PROPERTY: whatever
 * the model writes, every citation handed on names a file that is in the index and a line that is inside it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { extractCitations } = require('../host/ask-citations');

const files = new Map([['host/a.js', 100], ['app/b.js', 10], ['README.md', 1]]);

test('a real file:line is kept', () => {
  const r = extractCitations('It lives in host/a.js:42.', files);
  assert.deepStrictEqual(r.citations, [{ file: 'host/a.js', line: 42, endLine: 42 }]);
  assert.deepStrictEqual(r.dropped, []);
});

test('a range is kept and its end clamped to the file', () => {
  assert.deepStrictEqual(extractCitations('host/a.js:90-140', files).citations, [{ file: 'host/a.js', line: 90, endLine: 100 }]);
});

test('an unknown file is dropped and reported, never cited', () => {
  const r = extractCitations('see host/ghost.js:3 and host/a.js:3', files);
  assert.deepStrictEqual(r.citations.map(c => c.file), ['host/a.js']);
  assert.deepStrictEqual(r.dropped, ['host/ghost.js:3']);
});

test('a line past the end of the file, or zero, is dropped', () => {
  const r = extractCitations('app/b.js:11 app/b.js:0 app/b.js:10', files);
  assert.deepStrictEqual(r.citations, [{ file: 'app/b.js', line: 10, endLine: 10 }]);
  assert.strictEqual(r.dropped.length, 2);
});

test('windows separators, ./ prefixes, backticks and parentheses are tolerated', () => {
  const r = extractCitations('`.\\host\\a.js:7` (./app/b.js:2-3)', files);
  assert.deepStrictEqual(r.citations, [{ file: 'host/a.js', line: 7, endLine: 7 }, { file: 'app/b.js', line: 2, endLine: 3 }]);
});

test('the same citation twice is returned once', () => {
  assert.strictEqual(extractCitations('host/a.js:5 then host/a.js:5', files).citations.length, 1);
});

test('a reversed range is put the right way round', () => {
  assert.deepStrictEqual(extractCitations('host/a.js:30-20', files).citations, [{ file: 'host/a.js', line: 20, endLine: 30 }]);
});

test('a version number or a URL port is not a citation', () => {
  const r = extractCitations('node v22.1:3 and http://127.0.0.1:11434/api', files);
  assert.deepStrictEqual(r.citations, []);
});

test('P every citation names an indexed file and a line inside it, for any text at all', () => {
  const name = fc.oneof(fc.constantFrom('host/a.js', 'app/b.js', 'README.md', 'host/ghost.js', 'x.y'), fc.string({ maxLength: 12 }));
  const piece = fc.oneof(
    fc.tuple(name, fc.integer({ min: -5, max: 300 }), fc.option(fc.integer({ min: -5, max: 300 }))).map(([f, a, b]) => ` ${f}:${a}${b === null ? '' : '-' + b} `),
    fc.string({ maxLength: 30 }),
  );
  fc.assert(fc.property(fc.array(piece, { maxLength: 12 }), (parts) => {
    const { citations } = extractCitations(parts.join(''), files);
    for (const c of citations) {
      assert.ok(files.has(c.file), `unknown file ${c.file}`);
      assert.ok(Number.isInteger(c.line) && c.line >= 1 && c.line <= files.get(c.file));
      assert.ok(c.endLine >= c.line && c.endLine <= files.get(c.file));
    }
  }));
});

test('non-string input is no citations, not a throw', () => {
  assert.deepStrictEqual(extractCitations(undefined, files), { citations: [], dropped: [] });
});
