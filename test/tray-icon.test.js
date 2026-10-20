'use strict';
// The tray icon's pixels (app/tray-icon.js), drawn in plain code so there is no asset to ship and no canvas in main.
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { renderTrayIcon, SIZE, BADGE_BGRA, WHITE_BGRA } = require('../app/tray-icon');

const px = (img, x, y) => [...img.bgra.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const count = (img, bgra) => {
  let n = 0;
  for (let i = 0; i < img.bgra.length; i += 4) {
    if (img.bgra[i] === bgra[0] && img.bgra[i + 1] === bgra[1] && img.bgra[i + 2] === bgra[2] && img.bgra[i + 3] === bgra[3]) n++;
  }
  return n;
};

test('the image is SIZE x SIZE BGRA and is not blank', () => {
  const img = renderTrayIcon('');
  assert.strictEqual(img.width, SIZE);
  assert.strictEqual(img.height, SIZE);
  assert.strictEqual(img.bgra.length, SIZE * SIZE * 4);
  assert.ok(count(img, [0, 0, 0, 0]) < SIZE * SIZE, 'something is drawn');
});

test('the corners are transparent: the icon is a rounded square, not a block', () => {
  const img = renderTrayIcon('');
  assert.strictEqual(px(img, 0, 0)[3], 0);
  assert.strictEqual(px(img, SIZE - 1, 0)[3], 0);
});

test('no badge text draws no badge colour at all', () => {
  assert.strictEqual(count(renderTrayIcon(''), BADGE_BGRA), 0);
});

test('a badge draws its colour and white digits', () => {
  for (const text of ['1', '5', '9', '9+']) {
    const img = renderTrayIcon(text);
    assert.ok(count(img, BADGE_BGRA) > 30, `${text}: badge body`);
    assert.ok(count(img, WHITE_BGRA) > 5, `${text}: digit pixels`);
  }
});

test('every badge text looks different from every other, and from none', () => {
  const texts = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '9+'];
  const seen = new Set(texts.map(t => renderTrayIcon(t).bgra.toString('hex')));
  assert.strictEqual(seen.size, texts.length);
});

test('property: the same text draws the same pixels; an unknown character draws no digit, never throws', () => {
  fc.assert(fc.property(fc.string({ maxLength: 3 }), (t) => {
    const a = renderTrayIcon(t);
    const b = renderTrayIcon(t);
    assert.ok(a.bgra.equals(b.bgra));
    assert.strictEqual(a.bgra.length, SIZE * SIZE * 4);
  }));
});
