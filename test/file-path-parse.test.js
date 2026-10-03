'use strict';
/**
 * #37: where a local file path sits in a line of terminal text
 * (app/file-path-parse.js). It offers candidates and endings; main decides
 * which exist (app/file-link.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { findCandidates, pickLinks, MAX_PATH_LENGTH } = require('../app/file-path-parse');

const paths = (text, breaks) => findCandidates(text, breaks).map(c => c.options.map(o => o.path));
const first = (text) => findCandidates(text)[0].options[0];

test('an absolute path with backslashes or forward slashes, either drive case', () => {
  assert.deepStrictEqual(paths('see C:\\Users\\ricar\\x.txt now')[0], ['C:\\Users\\ricar\\x.txt now', 'C:\\Users\\ricar\\x.txt']);
  assert.deepStrictEqual(paths('see c:/Users/ricar/x.txt')[0], ['c:/Users/ricar/x.txt']);
});

test('a path with spaces offers every ending, longest first', () => {
  assert.deepStrictEqual(paths('at C:\\Reaper Projects\\Pinshot\\a b.xlsx is saved')[0], [
    'C:\\Reaper Projects\\Pinshot\\a b.xlsx is saved',
    'C:\\Reaper Projects\\Pinshot\\a b.xlsx is',
    'C:\\Reaper Projects\\Pinshot\\a b.xlsx',
    'C:\\Reaper Projects\\Pinshot\\a',
    'C:\\Reaper',
  ]);
});

test('backticks, quotes and markdown link brackets bound a path', () => {
  assert.strictEqual(first('wrote `C:\\a\\b.html` there').path, 'C:\\a\\b.html');
  assert.strictEqual(first('wrote "C:\\a\\b c.html" there').path, 'C:\\a\\b c.html');
  assert.ok(paths('[mocks](C:\\a\\b.html)')[0].includes('C:\\a\\b.html'));
});

test('trailing punctuation is offered both stripped and kept (parens are legal in names)', () => {
  assert.ok(paths('done (C:\\a\\b.txt).')[0].includes('C:\\a\\b.txt'));
  assert.ok(paths('C:\\Program Files (x86)\\x')[0].includes('C:\\Program Files (x86)\\x'));
});

test(':line, :line:col and :line-line are carried, not part of the path', () => {
  const o = first('at `app/renderer.js:594` and');
  assert.deepStrictEqual([o.path, o.line, o.col], ['app/renderer.js', 594, null]);
  const c = first('C:\\a\\b.js:12:5');
  assert.deepStrictEqual([c.path, c.line, c.col], ['C:\\a\\b.js', 12, 5]);
  assert.strictEqual(first('x/b.md:12-30').line, 12);
  assert.strictEqual(first('C:\\a\\b.txt now').line, null);
  // the link covers the suffix
  const t = 'see C:\\a\\b.js:12 ok';
  assert.strictEqual(t.slice(findCandidates(t)[0].start, first(t).end), 'C:\\a\\b.js:12');
});

test('relative paths: one token with a separator and a dotted last segment, or name.ext:line', () => {
  assert.strictEqual(first('edit documentation/handoffs/CURRENT-x.md please').path, 'documentation/handoffs/CURRENT-x.md');
  assert.strictEqual(first('run .venv/Scripts/python.exe').path, '.venv/Scripts/python.exe');
  assert.strictEqual(first('see app\\link-click.js, then').path, 'app\\link-click.js');
  assert.strictEqual(first('in renderer.js:594').path, 'renderer.js');
  assert.deepStrictEqual(paths('and/or, either/or, 3/4 of it, renderer.js alone, e.g. this'), []);
});

test('never UNC, device, drive-relative, rooted or URL paths', () => {
  for (const t of ['\\\\server\\share\\x.txt', '\\\\?\\C:\\x.txt', 'C:foo\\x.txt',
                   'file:///C:/x.txt', 'https://h.example/C:/x.txt', 'https://h.example/a/b.html', '\\x\\y.txt']) {
    for (const p of paths(t).flat()) {
      assert.ok(!/^[\\/]/.test(p) && !/^[A-Za-z]:(?![\\/])/.test(p), `${t} -> ${p}`);
    }
  }
  assert.deepStrictEqual(paths('file:///C:/x.txt'), []);
  assert.deepStrictEqual(paths('\\\\server\\share\\x.txt'), []);
  assert.deepStrictEqual(paths('https://h.example/a/b.html'), []);
});

test('a second drive letter ends the first path (a colon is not legal in a name)', () => {
  const c = findCandidates('C:\\a\\x.txt and D:\\b\\y.txt');
  assert.strictEqual(c.length, 2);
  assert.ok(c[0].options.some(o => o.path === 'C:\\a\\x.txt'));
  assert.deepStrictEqual(c[1].options.map(o => o.path), ['D:\\b\\y.txt']);
});

test('a row break is an extra ending', () => {
  const text = 'C:\\a\\b.txtNext steps';           // the rows met after "b.txt", at offset 10
  assert.ok(paths(text, [10])[0].includes('C:\\a\\b.txt'));
  assert.ok(!paths(text)[0].includes('C:\\a\\b.txt'));
});

test('a bare drive is not a path', () => {
  assert.deepStrictEqual(paths('drive C:\\ is full'), []);
});

test('caps: no path over MAX_PATH_LENGTH, no more than 8 options, no more than 32 candidates', () => {
  assert.deepStrictEqual(paths(`C:\\${'a'.repeat(MAX_PATH_LENGTH + 10)}.txt`), []);
  assert.ok(findCandidates(`C:\\${'a '.repeat(50)}`)[0].options.length <= 8);
  assert.ok(findCandidates('C:\\a.txt '.repeat(100)).length <= 32);
});

test('not a string: no candidates', () => {
  for (const v of [null, undefined, 42, {}]) assert.deepStrictEqual(findCandidates(v), []);
});

test('pickLinks: the answered option of each candidate, earlier start wins an overlap, null skipped', () => {
  const text = 'C:\\a b\\x.txt and C:\\y.txt and b\\x.txt';
  const cands = findCandidates(text);
  const answers = cands.map((c) => {
    const i = c.options.findIndex(o => o.path === 'C:\\a b\\x.txt' || o.path === 'b\\x.txt');
    return i === -1 ? null : { option: i, path: 'resolved' };
  });
  const links = pickLinks(cands, answers);
  assert.deepStrictEqual(links.map(l => text.slice(l.start, l.end)), ['C:\\a b\\x.txt', 'b\\x.txt']);
  assert.strictEqual(links[0].answer.path, 'resolved');
  // overlap: two answers covering the same text -> only the first
  const both = pickLinks([{ start: 0, options: [{ end: 10 }] }, { start: 5, options: [{ end: 12 }] }],
    [{ option: 0 }, { option: 0 }]);
  assert.strictEqual(both.length, 1);
  // a bad answer (option out of range, wrong shape) is skipped, never thrown on
  assert.deepStrictEqual(pickLinks(cands, [{ option: 99 }, 'x', undefined]), []);
  assert.deepStrictEqual(pickLinks(cands, null), []);
});

// --- properties ---------------------------------------------------------------
const seg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_. -]{0,10}[A-Za-z0-9_-]$/);
const absPath = fc.tuple(fc.constantFrom('C', 'c', 'D'), fc.constantFrom('\\', '/'),
  fc.array(seg, { minLength: 1, maxLength: 5 }))
  .map(([d, s, parts]) => `${d}:${s}${parts.join(s)}`);
const prose = fc.stringMatching(/^[a-z ,.!]{0,30}$/);

test('PROPERTY: a backticked absolute path in any prose is found exactly, with its line', () => {
  fc.assert(fc.property(prose, absPath, fc.option(fc.integer({ min: 1, max: 99999 })), prose,
    (pre, p, line, post) => {
      const shown = line === null ? p : `${p}:${line}`;
      const text = `${pre}\`${shown}\`${post}`;
      const c = findCandidates(text).find(x => x.start === pre.length + 1);
      if (!c) return false;
      const o = c.options.find(x => x.path === p);
      return !!o && o.line === line && text.slice(c.start, o.end) === shown;
    }));
});

test('PROPERTY: options lie in the text, end after their start, shrink, and are never UNC or drive-relative', () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), fc.array(fc.nat(200), { maxLength: 4 }), (text, breaks) => {
    let lastStart = -1;
    for (const c of findCandidates(text, breaks)) {
      if (c.start < lastStart || c.options.length === 0 || c.options.length > 8) return false;
      lastStart = c.start;
      let prevEnd = Infinity;
      for (const o of c.options) {
        if (!(o.end > c.start && o.end <= text.length && o.end < prevEnd)) return false;
        if (o.path.length === 0 || o.path.length > MAX_PATH_LENGTH) return false;
        if (!text.startsWith(o.path, c.start)) return false;
        if (/^[\\/]/.test(o.path) || /^[A-Za-z]:(?![\\/])/.test(o.path)) return false;
        prevEnd = o.end;
      }
    }
    return true;
  }));
});
