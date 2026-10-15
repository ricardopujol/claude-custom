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

test('a bare file name that is unique in the index is resolved to its path', () => {
  const r = extractCitations('it is in a.js:7 (see also README.md:1)', files);
  assert.deepStrictEqual(r.citations, [{ file: 'host/a.js', line: 7, endLine: 7 }, { file: 'README.md', line: 1, endLine: 1 }]);
});

test('a bare file name that two indexed files share is dropped, not guessed', () => {
  const two = new Map([['host/x.js', 50], ['app/x.js', 50]]);
  const r = extractCitations('x.js:7', two);
  assert.deepStrictEqual([r.citations, r.dropped], [[], ['x.js:7']]);
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

// PR #136 Dexter D4: a citation must land inside an excerpt the model was actually shown.
test('D4: with the sent ranges, a real file and line the model never saw is dropped (the prompt example, parroted)', () => {
  const big = new Map([['host/session-lock.js', 246], ['host/a.js', 100]]);
  const ranges = new Map([['host/a.js', [[10, 40]]]]);
  const r = extractCitations('see host/session-lock.js:217 and host/a.js:20 and host/a.js:90', big, { ranges });
  assert.deepStrictEqual(r.citations, [{ file: 'host/a.js', line: 20, endLine: 20 }]);
  assert.deepStrictEqual(r.dropped, ['host/session-lock.js:217', 'host/a.js:90']);
});

test('D4: a range that runs past the sent excerpt is clamped to it', () => {
  const ranges = new Map([['host/a.js', [[10, 40]]]]);
  assert.deepStrictEqual(extractCitations('host/a.js:30-80', files, { ranges }).citations, [{ file: 'host/a.js', line: 30, endLine: 40 }]);
});

test('D4 P: with ranges, every citation sits inside a sent range', () => {
  const ranges = new Map([['host/a.js', [[5, 20], [60, 70]]], ['app/b.js', [[1, 10]]]]);
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom('host/a.js', 'app/b.js', 'README.md'), fc.integer({ min: -3, max: 120 }), fc.integer({ min: -3, max: 120 })), { maxLength: 8 }), (cs) => {
    const text = cs.map(([f, a, b]) => ` ${f}:${a}-${b} `).join(' ');
    for (const c of extractCitations(text, files, { ranges }).citations) {
      assert.ok(ranges.get(c.file).some(([s, e]) => c.line >= s && c.line <= e && c.endLine <= e), JSON.stringify(c));
    }
  }));
});

// PR #136 Dexter D6
test('D6: a path with a space is cited whole, and never cut at the space and resolved to a different file', () => {
  const two = new Map([['docs/my notes.md', 120], ['app/notes.md', 40]]);
  const r = extractCitations('see docs/my notes.md:12', two);
  assert.deepStrictEqual(r.citations, [{ file: 'docs/my notes.md', line: 12, endLine: 12 }]);
  const none = extractCitations('see docs/other notes.md:12', two);
  assert.ok(!none.citations.some(c => c.file === 'app/notes.md'), 'the tail of a cut path resolved to another file');
});

test('r2 #5: an unsent docs/my notes.md is not cited as the sent root my notes.md', () => {
  const two = new Map([['my notes.md', 40]]); // ask() passes only the files that were sent
  const ranges = new Map([['my notes.md', [[1, 40]]]]);
  const r = extractCitations('docs/my notes.md:12', two, { ranges });
  assert.ok(!r.citations.some(c => c.file === 'my notes.md'), JSON.stringify(r));
  assert.strictEqual(extractCitations('see my notes.md:12', two, { ranges }).citations[0].file, 'my notes.md');
});

// --- kill tests for the release-176 survivors (BACKLOG #94, M4) --------------------------------------------------------

test('M4: repeated ./ prefixes are stripped from the front only', () => {
  assert.deepStrictEqual(extractCitations('see ./././host/a.js:3', files).citations, [{ file: 'host/a.js', line: 3, endLine: 3 }]);
  assert.deepStrictEqual(extractCitations('see /host/a.js:3', files).citations, [{ file: 'host/a.js', line: 3, endLine: 3 }]);
  const mid = extractCitations('see host/./a.js:3', files);
  assert.deepStrictEqual(mid.citations, [], 'a ./ inside a path names no indexed file');
  assert.deepStrictEqual(mid.dropped, ['host/./a.js:3']);
});

test('M4: a path with a space is matched whole from the index\'s own names, and the citations come out in the order of the text', () => {
  const withSpace = new Map([['host/a.js', 100], ['docs/my notes.md', 40], ['app/b.js', 10]]);
  const r = extractCitations('first host/a.js:1, then docs/my notes.md:12-14, then app/b.js:3 and docs/my notes.md:2', withSpace);
  assert.deepStrictEqual(r.citations, [
    { file: 'host/a.js', line: 1, endLine: 1 },
    { file: 'docs/my notes.md', line: 12, endLine: 14 },
    { file: 'app/b.js', line: 3, endLine: 3 },
    { file: 'docs/my notes.md', line: 2, endLine: 2 },
  ]);
  assert.deepStrictEqual(r.dropped, []);
});

test('M4: with no spaced names in the index, a bare :line is not a citation of anything', () => {
  const r = extractCitations('at 10 :30 or (:45) and [:7]', files);
  assert.deepStrictEqual(r, { citations: [], dropped: [] });
});

test('M4: a bare name after a cut path is the tail of that path only when the path ends right before it', () => {
  const idx = new Map([['docs/notes.md', 30], ['src/x.js', 5]]);
  const kept = extractCitations('see src/x then notes.md:3', idx);
  assert.deepStrictEqual(kept.citations, [{ file: 'docs/notes.md', line: 3, endLine: 3 }], 'a slash-word further back is not a cut path');
  const cut = extractCitations('see docs/other notes.md:3', idx);
  assert.deepStrictEqual(cut.citations, []);
  assert.deepStrictEqual(cut.dropped, ['notes.md:3']);
});

test('M4: a cut path is never cited, even when its tail is the name of a real root file', () => {
  const idx = new Map([['notes.md', 5], ['docs/x.md', 3]]);
  const r = extractCitations('see docs/other notes.md:2', idx);
  assert.deepStrictEqual(r.citations, []);
  assert.deepStrictEqual(r.dropped, ['notes.md:2']);
  assert.deepStrictEqual(extractCitations('see notes.md:2', idx).citations, [{ file: 'notes.md', line: 2, endLine: 2 }], 'the same name, plainly, is a root file');
});

test('M4: a bare name resolves only when it carries no folder and exactly one indexed file has it', () => {
  const idx = new Map([['lib/ghost.js', 10], ['a/same.js', 4], ['b/same.js', 4], ['top.js', 9]]);
  assert.deepStrictEqual(extractCitations('ghost.js:3', idx).citations, [{ file: 'lib/ghost.js', line: 3, endLine: 3 }]);
  assert.deepStrictEqual(extractCitations('docs/ghost.js:3', idx).citations, [], 'a named folder is a claim about that folder');
  assert.deepStrictEqual(extractCitations('same.js:2', idx), { citations: [], dropped: ['same.js:2'] }, 'two files share the name');
  assert.deepStrictEqual(extractCitations('top.js:2', idx).citations, [{ file: 'top.js', line: 2, endLine: 2 }]);
});

test('M4: a range written backwards is turned round, and a dropped range is reported with both ends once', () => {
  assert.deepStrictEqual(extractCitations('host/a.js:50-40', files).citations, [{ file: 'host/a.js', line: 40, endLine: 50 }]);
  assert.deepStrictEqual(extractCitations('host/a.js:7-7', files).citations, [{ file: 'host/a.js', line: 7, endLine: 7 }]);
  const r = extractCitations('host/ghost.js:3-9 and again host/ghost.js:3-9, plus host/ghost.js:3 and app/b.js:99', files);
  assert.deepStrictEqual(r.dropped, ['host/ghost.js:3-9', 'host/ghost.js:3', 'app/b.js:99']);
});

test('M4: with the ranges the model was shown, a citation must start inside one, end no later than it, and the edges count as inside', () => {
  const ranges = new Map([['host/a.js', [[10, 20], [50, 60]]]]);
  const cite = (t) => extractCitations(t, files, { ranges });
  assert.deepStrictEqual(cite('host/a.js:10').citations, [{ file: 'host/a.js', line: 10, endLine: 10 }]);
  assert.deepStrictEqual(cite('host/a.js:20').citations, [{ file: 'host/a.js', line: 20, endLine: 20 }]);
  assert.deepStrictEqual(cite('host/a.js:9').citations, []);
  assert.deepStrictEqual(cite('host/a.js:21').citations, []);
  assert.deepStrictEqual(cite('host/a.js:15-90').citations, [{ file: 'host/a.js', line: 15, endLine: 20 }], 'clamped to the range it starts in');
  assert.deepStrictEqual(cite('host/a.js:55-58').citations, [{ file: 'host/a.js', line: 55, endLine: 58 }]);
  assert.deepStrictEqual(cite('app/b.js:2').citations, [], 'a file that was not sent at all');
  assert.deepStrictEqual(cite('app/b.js:2').dropped, ['app/b.js:2']);
});

test('M4: a citation seen twice is kept once, by its file, line and end', () => {
  const r = extractCitations('host/a.js:5-9 and host/a.js:5-9 and host/a.js:5 and host/a.js:5-10', files);
  assert.deepStrictEqual(r.citations.map(c => [c.line, c.endLine]), [[5, 9], [5, 5], [5, 10]]);
});

test('M4: no text or no index is no citations', () => {
  for (const t of [null, undefined, 5, {}]) assert.deepStrictEqual(extractCitations(t, files), { citations: [], dropped: [] });
  for (const f of [null, undefined, {}, [], 'x']) assert.deepStrictEqual(extractCitations('host/a.js:1', f), { citations: [], dropped: [] });
});
