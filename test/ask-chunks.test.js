'use strict';
/**
 * Chunking for "ask the repo" (BACKLOG #33). PROPERTIES:
 *   P1  every line of the file is in at least one chunk, and in exactly one chunk's OWN range [ownStart, end]
 *   P2  a chunk's text is exactly its lines, and it never exceeds the line or char cap (a single long line aside)
 *   P3  chunks advance: starts strictly increase, overlap never exceeds the configured overlap
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { chunkFile, DEFAULTS } = require('../host/ask-chunks');

// A file's last newline ends its last line, it does not start another: trailing blank lines are not modelled.
const linesArb = fc.array(fc.string({ maxLength: 120 }).filter(s => !s.includes('\n') && !s.includes('\r')), { maxLength: 400 })
  .map((ls) => { while (ls.length && ls[ls.length - 1] === '') ls.pop(); return ls; });
const optsArb = fc.record({
  maxLines: fc.integer({ min: 1, max: 80 }),
  maxChars: fc.integer({ min: 20, max: 2000 }),
  overlap: fc.integer({ min: 0, max: 15 }),
});

test('an empty file has no chunks', () => {
  assert.deepStrictEqual(chunkFile('a.js', ''), []);
});

test('a short file is one chunk with its header range', () => {
  const [c, ...rest] = chunkFile('a.js', 'x\ny\nz\n');
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual({ file: c.file, start: c.start, end: c.end, ownStart: c.ownStart }, { file: 'a.js', start: 1, end: 3, ownStart: 1 });
  assert.strictEqual(c.text, 'x\ny\nz');
});

test('CRLF files chunk like LF files', () => {
  const a = chunkFile('a.js', 'x\r\ny\r\nz');
  const b = chunkFile('a.js', 'x\ny\nz');
  assert.deepStrictEqual(a, b);
});

test('a long file splits at the line cap with the overlap repeated', () => {
  const text = Array.from({ length: 130 }, (_, i) => `l${i + 1}`).join('\n');
  const cs = chunkFile('a.js', text, { maxLines: 60, maxChars: 100000, overlap: 10 });
  assert.deepStrictEqual(cs.map(c => [c.start, c.end, c.ownStart]), [[1, 60, 1], [51, 110, 61], [101, 130, 111]]);
});

test('P1 every line is covered, and owned by exactly one chunk', () => {
  fc.assert(fc.property(linesArb, optsArb, (lines, opts) => {
    const cs = chunkFile('f.js', lines.join('\n'), opts);
    const n = lines.length === 0 ? 0 : lines.length;
    const owners = new Array(n).fill(0);
    const seen = new Array(n).fill(0);
    for (const c of cs) {
      for (let l = c.start; l <= c.end; l++) seen[l - 1]++;
      for (let l = c.ownStart; l <= c.end; l++) owners[l - 1]++;
    }
    assert.ok(seen.every(x => x >= 1), 'a line fell between chunks');
    assert.ok(owners.every(x => x === 1), 'a line is owned by zero or two chunks');
  }));
});

test('P2 text is exactly the lines, within the caps', () => {
  fc.assert(fc.property(linesArb, optsArb, (lines, opts) => {
    const cs = chunkFile('f.js', lines.join('\n'), opts);
    for (const c of cs) {
      assert.strictEqual(c.text, lines.slice(c.start - 1, c.end).join('\n'));
      const count = c.end - c.start + 1;
      assert.ok(count <= opts.maxLines);
      if (count > 1) assert.ok(c.text.length <= opts.maxChars, 'a multi-line chunk went past the char cap');
    }
  }));
});

test('P3 chunks advance and overlap no more than asked', () => {
  fc.assert(fc.property(linesArb, optsArb, (lines, opts) => {
    const cs = chunkFile('f.js', lines.join('\n'), opts);
    for (let i = 1; i < cs.length; i++) {
      assert.ok(cs[i].start > cs[i - 1].start, 'no progress');
      assert.ok(cs[i - 1].end - cs[i].start + 1 <= opts.overlap, 'overlap too big');
      assert.strictEqual(cs[i].ownStart, cs[i - 1].end + 1);
    }
  }));
});

test('defaults match the 2026-10-03 measurement', () => {
  assert.deepStrictEqual(DEFAULTS, { maxLines: 60, maxChars: 1500, overlap: 10 });
});
