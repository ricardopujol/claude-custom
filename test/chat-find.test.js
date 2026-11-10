'use strict';
/**
 * BACKLOG #203: the chat view's find searches from the bottom up (the newest match first, Enter goes up to an older one,
 * Shift+Enter down to a newer one). The order is an option of the find, so the old top-down order is still one word away.
 */
const test = require('node:test');
const assert = require('node:assert');
const { findMatches, firstIndex, stepIndex, isFindKey, DEFAULT_ORDER } = require('../app/chat-find');

test('the default order is bottom-up', () => {
  assert.strictEqual(DEFAULT_ORDER, 'bottom-up');
});

test('findMatches: every non-overlapping match in document order, case-insensitive unless asked', () => {
  assert.deepStrictEqual(findMatches('Foo bar foo FOO', 'foo'), [{ start: 0, end: 3 }, { start: 8, end: 11 }, { start: 12, end: 15 }]);
  assert.deepStrictEqual(findMatches('Foo bar foo FOO', 'foo', { caseSensitive: true }), [{ start: 8, end: 11 }]);
  assert.deepStrictEqual(findMatches('aaaa', 'aa'), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test('findMatches: offsets stay the text\'s own when lower-casing changes its length', () => {
  const text = 'İ x İ x';   // "İ" lower-cases to two code units
  assert.deepStrictEqual(findMatches(text, 'x'), [{ start: 2, end: 3 }, { start: 6, end: 7 }]);
});

test('#203 Dexter 5: an "İ" elsewhere never changes which other matches are found', () => {
  const cases = [['i̇', 'İ'], ['abc ABC', 'abc'], ['İ x', 'x'], ['i̇ i̇', 'İ'], ['aaaa', 'aa']];
  for (const [t, q] of cases) {
    const before = findMatches(t, q);
    const after = findMatches(`${t} İ`, q);
    for (const m of before) assert.ok(after.some(a => a.start === m.start && a.end === m.end), `${JSON.stringify(t)} / ${JSON.stringify(q)}: ${JSON.stringify(m)} lost`);
  }
  assert.deepStrictEqual(findMatches('i̇ İ', 'İ'), [{ start: 0, end: 2 }, { start: 3, end: 4 }]);
  assert.deepStrictEqual(findMatches('İ', 'i'), [], 'a match may not end inside one character\'s lower-case form');
});

test('findMatches: no query, no text or a non-string is no match, never a throw or an endless loop', () => {
  for (const [t, q] of [['abc', ''], ['', 'a'], [null, 'a'], ['abc', null], [undefined, undefined], [5, 5]]) {
    assert.deepStrictEqual(findMatches(t, q), []);
  }
});

test('firstIndex: bottom-up starts on the LAST match, top-down on the first, none on no match', () => {
  assert.strictEqual(firstIndex(5, 'bottom-up'), 4);
  assert.strictEqual(firstIndex(5, 'top-down'), 0);
  assert.strictEqual(firstIndex(5), 4, 'bottom-up by default');
  assert.strictEqual(firstIndex(0, 'bottom-up'), -1);
  assert.strictEqual(firstIndex(0, 'top-down'), -1);
  assert.strictEqual(firstIndex(3, 'sideways'), 2, 'an unknown order is the default');
});

test('stepIndex bottom-up: Enter goes up to an older match, Shift+Enter down to a newer one, both wrap', () => {
  assert.strictEqual(stepIndex({ index: 4, count: 5, shift: false }), 3);
  assert.strictEqual(stepIndex({ index: 0, count: 5, shift: false }), 4, 'past the oldest: back to the newest');
  assert.strictEqual(stepIndex({ index: 3, count: 5, shift: true }), 4);
  assert.strictEqual(stepIndex({ index: 4, count: 5, shift: true }), 0, 'past the newest: round to the oldest');
});

test('stepIndex top-down: Enter goes down, Shift+Enter up (the order option reverses the keys)', () => {
  assert.strictEqual(stepIndex({ index: 0, count: 5, shift: false, order: 'top-down' }), 1);
  assert.strictEqual(stepIndex({ index: 4, count: 5, shift: false, order: 'top-down' }), 0);
  assert.strictEqual(stepIndex({ index: 0, count: 5, shift: true, order: 'top-down' }), 4);
});

test('stepIndex: one match stays put, none is -1, a stale index is pulled back into range', () => {
  assert.strictEqual(stepIndex({ index: 0, count: 1, shift: false }), 0);
  assert.strictEqual(stepIndex({ index: 0, count: 0, shift: false }), -1);
  assert.strictEqual(stepIndex({ index: 9, count: 3, shift: true }), 0, 'index past the end (the chat shrank)');
  // Dexter 4: past the end is newer than every match, so the nearest older one is the last, with nothing skipped.
  assert.strictEqual(stepIndex({ index: 5, count: 3, shift: false }), 2);
  assert.strictEqual(stepIndex({ index: 5, count: 3, shift: false, order: 'top-down' }), 0);
  assert.strictEqual(stepIndex({ index: -1, count: 3, shift: false }), 2, 'no current match: Enter starts at the first of the order');
  assert.strictEqual(stepIndex({ index: -1, count: 3, shift: true, order: 'top-down' }), 0, 'top-down starts at the top too');
});

test('stepIndex walks every match exactly once in a full lap, newest first', () => {
  let i = firstIndex(4);
  const seen = [i];
  for (let k = 0; k < 3; k++) { i = stepIndex({ index: i, count: 4, shift: false }); seen.push(i); }
  assert.deepStrictEqual(seen, [3, 2, 1, 0]);
});

test('isFindKey: Ctrl+F on keydown only, no Shift, Alt or Meta', () => {
  const key = (o) => ({ type: 'keydown', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'f', code: 'KeyF', ...o });
  assert.strictEqual(isFindKey(key({})), true);
  assert.strictEqual(isFindKey(key({ key: 'F' })), true, 'Caps Lock');
  assert.strictEqual(isFindKey(key({ key: 'f', code: 'KeyY' })), true, 'Dvorak: the F letter on another position');
  assert.strictEqual(isFindKey(key({ key: 'u', code: 'KeyF' })), false, 'Dvorak: Ctrl+U sits on the KeyF position');
  assert.strictEqual(isFindKey(key({ type: 'keyup' })), false);
  assert.strictEqual(isFindKey(key({ shiftKey: true })), false);
  assert.strictEqual(isFindKey(key({ ctrlKey: false })), false);
  assert.strictEqual(isFindKey(key({ altKey: true })), false);
  assert.strictEqual(isFindKey(key({ key: 'g', code: 'KeyG' })), false);
  assert.strictEqual(isFindKey(key({ key: undefined })), false);
  assert.strictEqual(isFindKey(null), false);
});
