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

test('the corners are transparent: the slats stand on nothing, never a block', () => {
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

// ---- Q11, Ricardo's pick A "Bamboo slips" (PR #258): four slats on two cords, on a transparent background ---------------------------
const bgraOf = (hex) => [parseInt(hex.slice(5, 7), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(1, 3), 16), 255];

test('Q11 A: no square behind: the corner (0,0) is fully transparent', () => {
  assert.deepStrictEqual(px(renderTrayIcon(''), 0, 0), [0, 0, 0, 0]);
});

test('Q11 A: the middle of slat 0 (x 5, y 15) is #3fb882, opaque', () => {
  assert.deepStrictEqual(px(renderTrayIcon(''), 5, 15), bgraOf('#3fb882'));
});

test('Q11 A: an odd slat is the darker green: slat 1 (x 12, y 15) is #2f9a6c', () => {
  assert.deepStrictEqual(px(renderTrayIcon(''), 12, 15), bgraOf('#2f9a6c'));
});

test('Q11 A: a cord pixel (x 8, y 10) is #123527, drawn over the slats', () => {
  assert.deepStrictEqual(px(renderTrayIcon(''), 8, 10), bgraOf('#123527'));
  assert.deepStrictEqual(px(renderTrayIcon(''), 5, 22), bgraOf('#123527'), 'the lower cord over slat 0');
});

test('Q11 A: the gap between slat 0 and slat 1 (pixel 9, y 15) is transparent', () => {
  assert.deepStrictEqual(px(renderTrayIcon(''), 9, 15), [0, 0, 0, 0]);
});

test('Q11 A: odd slats are shorter: slat 1 starts at y 3, so (12, 2) is empty and (12, 3) is drawn', () => {
  const img = renderTrayIcon('');
  assert.strictEqual(px(img, 12, 2)[3], 0);
  assert.strictEqual(px(img, 12, 3)[3], 255);
});
