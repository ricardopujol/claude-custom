'use strict';
/**
 * #37: the rows one long path spans, joined into one string
 * (app/terminal-rows.js). The rules are the ones measured on the real CLI in
 * verify/probe-file-link-rows.js: Ink breaks rows itself, so isWrapped is
 * ignored; a continuation row is indented to where its block's text starts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { block } = require('../app/terminal-rows');

// A fake buffer from strings; '\u0000' after a wide char marks its width-0 tail.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/;
function buffer(rows) {
  return (y) => {
    if (y < 0 || y >= rows.length) return null;
    const cells = [];
    for (const ch of rows[y]) {
      cells.push(ch === '\u0000' ? { chars: '', width: 0 } : { chars: ch, width: WIDE.test(ch) ? 2 : 1 });
    }
    return { cells };
  };
}

test('a full row (Ink broke mid-word) joins its continuation with nothing between, from either row', () => {
  const get = buffer(['● C:\\abcdef', '  ghi.txt  ']);
  for (const y of [0, 1]) {
    const b = block(get, y, 11);
    assert.strictEqual(b.text, '● C:\\abcdefghi.txt');
    assert.deepStrictEqual(b.breaks, [11]);
  }
});

test('a row broken at a space joins with a virtual space that maps to no cell', () => {
  const get = buffer(['● C:\\Reaper   ', '  Projects\\x  ']);
  const b = block(get, 0, 14);
  assert.strictEqual(b.text, '● C:\\Reaper Projects\\x');
  assert.strictEqual(b.cellAt[b.text.indexOf(' Projects')], null);
  assert.deepStrictEqual(b.cellAt[b.text.indexOf('Projects')], { y: 1, x: 2 });
  assert.deepStrictEqual(b.breaks, [11]);
});

test('the measured shape: "  ⎿  " output continues at indent 5, and a new marker starts a new block', () => {
  const cols = 29;                    // full = last non-blank at x >= 27
  const get = buffer([
    '! echo C:\\Users\\ricar\\VibeCo',   // 28 chars, last x = 27: full
    '  de\\x.txt',
    '  ⎿  C:\\Users\\ricar\\VibeCode\\',  // a marker: not a continuation of the row above
    '     x.txt and more',
  ]);
  assert.strictEqual(block(get, 1, cols).text, '! echo C:\\Users\\ricar\\VibeCode\\x.txt');
  assert.strictEqual(block(get, 3, cols).text, '  ⎿  C:\\Users\\ricar\\VibeCode\\x.txt and more');
});

test('a row whose indent is not the text start above is its own block', () => {
  const get = buffer(['● first line', '    deeper', 'x']);
  assert.strictEqual(block(get, 1, 40).text, '    deeper');
  assert.strictEqual(block(get, 2, 40).text, 'x');
});

test('list items are separate blocks; an item continues at its text start', () => {
  const get = buffer(['  - one C:\\a', '    b.txt', '  - two']);
  assert.strictEqual(block(get, 0, 40).text, '  - one C:\\a b.txt');
  assert.strictEqual(block(get, 2, 40).text, '  - two');
});

test('a blank row ends a block; maxRows caps it both ways', () => {
  assert.strictEqual(block(buffer(['C:\\a', '', 'b.txt']), 0, 40).text, 'C:\\a');
  const many = buffer(Array.from({ length: 30 }, (_, i) => `w${i}`));
  const b = block(many, 15, 40, { maxRows: 2 });
  assert.strictEqual(b.text, 'w13 w14 w15 w16 w17');
});

test('a wide character maps both its cells to one char and shifts nothing after it', () => {
  const b = block(buffer(['漢\u0000 C:\\x.txt']), 0, 12);
  assert.strictEqual(b.text, '漢 C:\\x.txt');
  assert.deepStrictEqual(b.cellAt[b.text.indexOf('C')], { y: 0, x: 3 });
});

test('no row, or an unreadable one: an empty block', () => {
  assert.deepStrictEqual(block(() => null, 0, 40), { text: '', cellAt: [], breaks: [] });
  assert.deepStrictEqual(block(() => ({}), 0, 40), { text: '', cellAt: [], breaks: [] });
});

// --- properties: Ink-like wrapping, then joining, gives the text back ---------
const MARK = '● ';
// Ink: content width cols-1; the first row after the marker, the rest indented.
function inkWrap(words, cols) {
  const width = cols - 1 - MARK.length;
  const rows = [];
  let cur = '';
  const push = () => { rows.push((rows.length ? ' '.repeat(MARK.length) : MARK) + cur); cur = ''; };
  for (const w of words) {
    if (cur && cur.length + 1 + w.length <= width) { cur += ` ${w}`; continue; }
    if (cur) push();
    let rest = w;
    while (rest.length > width) { cur = rest.slice(0, width); push(); rest = rest.slice(width); }
    cur = rest;
  }
  if (cur) push();
  return rows;
}

test('PROPERTY: a long spaceless path hard-broken across rows joins back exactly, cell-exact', () => {
  fc.assert(fc.property(fc.stringMatching(/^[!-~]{1,200}$/), fc.integer({ min: 8, max: 60 }), (p, cols) => {
    const rows = inkWrap([p], cols);
    const b = block(buffer(rows), rows.length - 1, cols, { maxRows: 64 });
    if (b.text !== MARK + p) return false;
    const width = cols - 1 - MARK.length;
    for (let i = 0; i < p.length; i++) {
      const c = b.cellAt[MARK.length + i];
      if (!c || c.y !== Math.floor(i / width) || c.x !== MARK.length + (i % width)) return false;
    }
    return true;
  }));
});

test('PROPERTY: word-wrapped prose joins back to the words with single spaces', () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-zA-Z_\/:][a-zA-Z0-9_\/:.]{0,11}$/), { minLength: 1, maxLength: 30 }),
    fc.integer({ min: 16, max: 60 }), (words, cols) => {
      const rows = inkWrap(words, cols);
      // The known ambiguity: a row full at a word's end looks like a mid-word break.
      fc.pre(rows.slice(0, -1).every(r => r.length < cols - 1 || !words.some(w => r.endsWith(w))));
      const b = block(buffer(rows), 0, cols, { maxRows: 64 });
      return b.text === MARK + words.join(' ') && b.breaks.length === rows.length - 1;
    }));
});
