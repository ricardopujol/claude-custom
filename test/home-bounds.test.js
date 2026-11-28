'use strict';
/**
 * app/home-bounds.js: Home remembers its size and place (the brief's default), and never comes back off every screen.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { boundsToUse, boundsToSave, DEFAULT_SIZE, MIN_SIZE } = require('../app/home-bounds');

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

test('saved bounds on a screen come back as they were', () => {
  assert.deepStrictEqual(boundsToUse({ x: 100, y: 80, width: 900, height: 600 }, [AREA]), { x: 100, y: 80, width: 900, height: 600 });
  assert.deepStrictEqual(boundsToUse({ x: 2100, y: 100, width: 1000, height: 700 }, [AREA, RIGHT]), { x: 2100, y: 100, width: 1000, height: 700 });
});

test('bounds on a screen that is gone (the second monitor unplugged) are not used: the window centres at its default size', () => {
  assert.strictEqual(boundsToUse({ x: 2100, y: 100, width: 1000, height: 700 }, [AREA]), null);
});

test('a window whose title bar is barely on screen is not used (it could not be dragged back)', () => {
  assert.strictEqual(boundsToUse({ x: 1880, y: 100, width: 900, height: 600 }, [AREA]), null, 'only 40 px across');
  assert.strictEqual(boundsToUse({ x: 100, y: 1020, width: 900, height: 600 }, [AREA]), null, 'only 20 px down');
  assert.strictEqual(boundsToUse({ x: 100, y: -20, width: 900, height: 600 }, [AREA]), null, 'the title bar is above the screen');
});

test('a size below the minimum grows to it; a size past the screen shrinks to it', () => {
  assert.deepStrictEqual(boundsToUse({ x: 10, y: 10, width: 100, height: 100 }, [AREA]), { x: 10, y: 10, width: MIN_SIZE.width, height: MIN_SIZE.height });
  assert.deepStrictEqual(boundsToUse({ x: 0, y: 0, width: 5000, height: 3000 }, [AREA]), { x: 0, y: 0, width: 1920, height: 1040 });
});

test('anything that is not four strict whole numbers is no bounds (Number(null) is 0)', () => {
  for (const bad of [null, undefined, {}, { x: null, y: 0, width: 900, height: 600 }, { x: '1', y: 0, width: 900, height: 600 },
    { x: 1.5, y: 0, width: 900, height: 600 }, { x: 0, y: 0, width: NaN, height: 600 }, [1, 2, 3, 4]]) {
    assert.strictEqual(boundsToUse(bad, [AREA]), null, JSON.stringify(bad));
    assert.strictEqual(boundsToSave(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(boundsToUse({ x: 0, y: 0, width: 900, height: 600 }, null), null, 'no screens: no bounds');
});

test('PR #263 Dexter 5: Electron\'s -8 px maximised edge is allowed: moved onto the screen, not refused', () => {
  assert.deepStrictEqual(boundsToUse({ x: -8, y: -8, width: 1936, height: 1056 }, [AREA]), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepStrictEqual(boundsToUse({ x: 1912, y: -8, width: 1000, height: 700 }, [AREA, RIGHT]), { x: 1920, y: 0, width: 1000, height: 700 });
  assert.strictEqual(boundsToUse({ x: 100, y: -9, width: 900, height: 600 }, [AREA]), null, 'past the edge is still off the screen');
});

test('boundsToSave keeps the four numbers and nothing else', () => {
  assert.deepStrictEqual(boundsToSave({ x: 5, y: 6, width: 900, height: 600, extra: 1 }), { x: 5, y: 6, width: 900, height: 600 });
  assert.deepStrictEqual(DEFAULT_SIZE, { width: 980, height: 680 });
});

test('property: bounds that come back always keep a draggable strip of the title bar on some screen', () => {
  const n = fc.integer({ min: -4000, max: 6000 });
  fc.assert(fc.property(fc.record({ x: n, y: n, width: n, height: n }), (b) => {
    const r = boundsToUse(b, [AREA, RIGHT]);
    if (r === null) return;
    const on = [AREA, RIGHT].some((a) => Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x) >= 100
      && r.y >= a.y && r.y + 30 <= a.y + a.height);
    assert.ok(on, JSON.stringify({ b, r }));
    assert.ok(r.width >= MIN_SIZE.width && r.height >= MIN_SIZE.height);
  }));
});
