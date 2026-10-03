'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { dominantColours, seedsOf, MAX_COLOURS } = require('../app/colour-seeds');

const HEX = /^#[0-9a-f]{6}$/;

// An RGBA buffer from [[r,g,b,a], count] runs.
function pixels(runs) {
  const out = [];
  for (const [rgba, n] of runs) for (let i = 0; i < n; i++) out.push(...rgba);
  return Uint8ClampedArray.from(out);
}

test('the cap is five colours', () => {
  assert.strictEqual(MAX_COLOURS, 5);
});

test('a solid picture is one colour, exactly', () => {
  const r = dominantColours(pixels([[[0x2a, 0x5a, 0x8a, 255], 400]]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].hex, '#2a5a8a');
  assert.strictEqual(r[0].share, 1);
});

test('two flat areas are two colours, biggest first, with their shares', () => {
  const r = dominantColours(pixels([[[200, 40, 40, 255], 300], [[20, 40, 200, 255], 100]]));
  assert.deepStrictEqual(r.map((c) => c.hex), ['#c82828', '#1428c8']);
  assert.strictEqual(r[0].share, 0.75);
  assert.strictEqual(r[1].share, 0.25);
});

test('five distinct areas come back as five; seven come back as at most five', () => {
  const five = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
  assert.strictEqual(dominantColours(pixels(five.map((c) => [[...c, 255], 100]))).length, 5);
  const seven = [...five, [0, 255, 255], [128, 128, 128]];
  const r = dominantColours(pixels(seven.map((c, i) => [[...c, 255], 100 + i])));
  assert.ok(r.length <= 5 && r.length >= 3);
});

test('transparent pixels are not colours', () => {
  const r = dominantColours(pixels([[[255, 0, 0, 0], 500], [[0, 0, 255, 255], 100]]));
  assert.deepStrictEqual(r.map((c) => c.hex), ['#0000ff']);
  assert.strictEqual(r[0].share, 1, 'the share is of the pixels that count');
  assert.deepStrictEqual(dominantColours(pixels([[[1, 2, 3, 0], 50]])), []);
  assert.strictEqual(dominantColours(pixels([[[0, 0, 255, 127], 10]])).length, 0, 'under half opaque is not counted');
  assert.strictEqual(dominantColours(pixels([[[0, 0, 255, 128], 10]])).length, 1, 'half opaque and over is');
});

test('a speck below the minimum share is dropped', () => {
  const r = dominantColours(pixels([[[40, 90, 140, 255], 990], [[250, 250, 20, 255], 10]]));
  assert.deepStrictEqual(r.map((c) => c.hex), ['#285a8c']);
  const kept = dominantColours(pixels([[[40, 90, 140, 255], 990], [[250, 250, 20, 255], 10]]), { minShare: 0.005 });
  assert.strictEqual(kept.length, 2);
});

test('nothing usable in, nothing out -- never a made-up colour', () => {
  for (const bad of [null, undefined, [], new Uint8ClampedArray(0), 'x', 5, {}, new Uint8ClampedArray(3), [1, 2, 3, 4, 5]]) {
    assert.deepStrictEqual(dominantColours(bad), [], String(bad));
  }
});

test('count is honoured and bounded', () => {
  const five = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
  const px = pixels(five.map((c) => [[...c, 255], 100]));
  assert.ok(dominantColours(px, { count: 2 }).length <= 2);
  assert.ok(dominantColours(px, { count: 99 }).length <= MAX_COLOURS, 'never more than the cap');
  assert.deepStrictEqual(dominantColours(px, { count: 0 }), []);
});

test('it is deterministic: the same picture gives the same colours', () => {
  const px = pixels([[[10, 200, 30, 255], 123], [[200, 10, 90, 255], 77], [[90, 90, 90, 255], 50]]);
  assert.deepStrictEqual(dominantColours(px), dominantColours(px));
});

test('a gradient\'s colours are dominant colours of it, not a flat average', () => {
  const run = [];
  for (let i = 0; i < 256; i++) run.push([[i, 0, 255 - i, 255], 4]);
  const r = dominantColours(pixels(run));
  assert.ok(r.length >= 3, 'a red-to-blue ramp is several colours');
});

test('seedsOf is the hex list the host is sent: no shares, no pixels', () => {
  const r = seedsOf(pixels([[[200, 40, 40, 255], 300], [[20, 40, 200, 255], 100]]));
  assert.deepStrictEqual(r, ['#c82828', '#1428c8']);
  assert.deepStrictEqual(seedsOf(null), []);
});

test('PROPERTY: any pixels give at most five valid colours, shares in (0, 1], largest first', () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)), { maxLength: 300 }), (px) => {
    const r = dominantColours(Uint8ClampedArray.from(px.flat()));
    assert.ok(r.length <= MAX_COLOURS);
    for (let i = 0; i < r.length; i++) {
      assert.match(r[i].hex, HEX);
      assert.ok(r[i].share > 0 && r[i].share <= 1);
      if (i) assert.ok(r[i - 1].share >= r[i].share);
    }
    const total = r.reduce((a, c) => a + c.share, 0);
    assert.ok(total <= 1 + 1e-9);
  }));
});

test('PROPERTY: every dominant colour lies inside the picture\'s own colour range', () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)), { minLength: 1, maxLength: 200 }), (px) => {
    const r = dominantColours(Uint8ClampedArray.from(px.flatMap(([a, b, c]) => [a, b, c, 255])), { minShare: 0 });
    for (const { hex } of r) {
      const n = parseInt(hex.slice(1), 16);
      const got = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      for (let ch = 0; ch < 3; ch++) {
        const vals = px.map((p) => p[ch]);
        // one 8-bit step of slack for the linear-light mean's rounding
        assert.ok(got[ch] >= Math.min(...vals) - 1 && got[ch] <= Math.max(...vals) + 1, `${hex} channel ${ch}`);
      }
    }
  }));
});

test('D4: a pixel with a channel that is not a number is skipped, never thrown on', () => {
  const { dominantColours } = require('../app/colour-seeds');
  for (const bad of [[NaN, 0, 0, 255], [undefined, undefined, undefined, 255], [0, Infinity, 0, 255], ['12', 0, 0, 255]]) {
    assert.deepStrictEqual(dominantColours(bad), [], JSON.stringify(bad));
  }
  assert.deepStrictEqual(dominantColours([0, 0, 0, 255, NaN, 0, 0, 255]), [{ hex: '#000000', share: 1 }]);
});
