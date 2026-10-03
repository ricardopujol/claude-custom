'use strict';
/**
 * "@ in prompt" (#32): the text typed into the CLI's input box for a file or a line range.
 * `@relative/path.js#L40-60`, forward slashes, relative to the worktree. Never submitted.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mentionText, rangeOfLines } = require('../app/repo-mention');

test('a file is @ and its path relative to the worktree', () => {
  assert.deepStrictEqual(mentionText('src/app.js'), { ok: true, text: '@src/app.js' });
});

test('backslashes become forward slashes and a leading ./ goes', () => {
  assert.strictEqual(mentionText('.\\src\\deep\\app.js').text, '@src/deep/app.js');
});

test('a line range is #Lfrom-to; one line is #Lfrom', () => {
  assert.strictEqual(mentionText('a.js', { from: 40, to: 60 }).text, '@a.js#L40-60');
  assert.strictEqual(mentionText('a.js', { from: 7, to: 7 }).text, '@a.js#L7');
});

test('a range picked bottom-up is put the right way round', () => {
  assert.strictEqual(mentionText('a.js', { from: 60, to: 40 }).text, '@a.js#L40-60');
});

test('no range, null and undefined all mean the whole file', () => {
  for (const r of [undefined, null]) assert.strictEqual(mentionText('a.js', r).text, '@a.js');
});

test('a range that is not whole positive line numbers is refused, never typed as the whole file', () => {
  for (const r of [{ from: 0, to: 3 }, { from: -1, to: 3 }, { from: 1.5, to: 3 }, { from: NaN, to: 3 }, { from: 1 }, { from: '4', to: '5' }, {}, 7]) {
    const m = mentionText('a.js', r);
    assert.strictEqual(m.ok, false, JSON.stringify(r));
    assert.match(m.reason, /line range/);
  }
});

test('a path the CLI\'s @ can\'t carry is refused with the reason, not typed half-broken', () => {
  for (const p of ['my file.js', 'tab\there.js', 'a#b.js', 'new\nline.js', 'x\u0000y']) {
    const m = mentionText(p);
    assert.strictEqual(m.ok, false, JSON.stringify(p));
    assert.ok(m.reason.length > 0);
  }
});

test('an empty, absolute, parent-relative or non-string path is refused', () => {
  for (const p of ['', '/etc/passwd', 'C:\\x\\a.js', 'C:/x/a.js', '../a.js', 'a/../../b.js', null, undefined, 5]) {
    assert.strictEqual(mentionText(p).ok, false, String(p));
  }
});

test('non-ASCII names are fine', () => {
  assert.strictEqual(mentionText('docs/caf\u00e9.md').text, '@docs/caf\u00e9.md');
});

test('rangeOfLines turns an editor selection into 1-based lines', () => {
  assert.deepStrictEqual(rangeOfLines({ fromLine: 40, toLine: 60, empty: false }), { from: 40, to: 60 });
});

test('an empty selection (just a cursor) is no range: the whole file', () => {
  assert.strictEqual(rangeOfLines({ fromLine: 5, toLine: 5, empty: true }), null);
});

test('a selection that ends at the start of a line does not include that line', () => {
  assert.deepStrictEqual(rangeOfLines({ fromLine: 10, toLine: 12, empty: false, toCol0: true }), { from: 10, to: 11 });
});

test('rangeOfLines of nothing usable is null', () => {
  for (const s of [null, undefined, {}, { fromLine: 'x', toLine: 2, empty: false }]) assert.strictEqual(rangeOfLines(s), null);
});
