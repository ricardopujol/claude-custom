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

// Miguel M6 (PR #91): sRGB -> OKLab is written twice, here (the page) and in host/palette-gen.js
// (the host). They stay separate copies; this holds them to the same numbers, so a constant edited
// in one and not the other fails here instead of quietly skewing what "this background's hue" means.
test('PROPERTY M6: colour-seeds and palette-gen convert every sRGB colour to the same OKLab', () => {
  const { oklabOfByte } = require('../app/colour-seeds');
  const { hexToOklch } = require('../host/palette-gen');
  const byte = fc.integer({ min: 0, max: 255 });
  const hex = (v) => v.toString(16).padStart(2, '0');
  const check = (r, g, b) => {
    const [L, a, bb] = oklabOfByte(r, g, b);
    const o = hexToOklch(`#${hex(r)}${hex(g)}${hex(b)}`);
    assert.ok(Math.abs(L - o.L) < 1e-12, `L ${L} vs ${o.L}`);
    if (o.h === null) {
      assert.ok(Math.hypot(a, bb) < 1e-4, 'palette-gen calls it grey, so its chroma is under the cut-off here too');
    } else {
      const rad = (o.h * Math.PI) / 180;
      assert.ok(Math.abs(a - o.C * Math.cos(rad)) < 1e-12 && Math.abs(bb - o.C * Math.sin(rad)) < 1e-12,
        `(${r},${g},${b}): a ${a} b ${bb} vs C ${o.C} h ${o.h}`);
    }
  };
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255], [31, 79, 154]]) check(r, g, b);
  fc.assert(fc.property(byte, byte, byte, check), { numRuns: 2000 });
});

// --- Mortimer, release PR #101 gate (backlog #58) --------------------------------------------------------------

test('only a real pixel buffer is read: an array or typed array whose length is a whole number of pixels', () => {
  const px = [10, 20, 30, 255];
  assert.strictEqual(dominantColours(px).length, 1, 'a plain array of one pixel');
  assert.strictEqual(dominantColours(Uint8ClampedArray.from(px)).length, 1);
  assert.strictEqual(dominantColours(Uint8Array.from([...px, ...px])).length, 1, 'two pixels of one colour');
  assert.deepStrictEqual(dominantColours([...px, 1]), [], 'length 5');
  assert.deepStrictEqual(dominantColours([...px, 1, 2, 3]), [], 'length 7');
  assert.deepStrictEqual(dominantColours([1, 2, 3]), [], 'length 3');
  assert.deepStrictEqual(dominantColours([]), [], 'empty');
  assert.deepStrictEqual(dominantColours(null), []);
  assert.deepStrictEqual(dominantColours(undefined), []);
  assert.deepStrictEqual(dominantColours('abcd'), []);
  assert.deepStrictEqual(dominantColours(4), []);
  assert.deepStrictEqual(dominantColours(new ArrayBuffer(8)), [], 'a bare ArrayBuffer is not a view');
  // an object that merely LOOKS like a pixel list is not one
  assert.deepStrictEqual(dominantColours({ 0: 10, 1: 20, 2: 30, 3: 255, length: 4 }), []);
});

test('a share exactly at the minimum is kept; just under it is dropped', () => {
  // 98 + 2 pixels: the small colour is exactly 2%, the default minimum
  const r = dominantColours(pixels([[[200, 40, 40, 255], 98], [[20, 40, 200, 255], 2]]));
  assert.deepStrictEqual(r.map((c) => c.hex), ['#c82828', '#1428c8']);
  assert.strictEqual(r[1].share, 0.02);
  const under = dominantColours(pixels([[[200, 40, 40, 255], 99], [[20, 40, 200, 255], 1]]));
  assert.deepStrictEqual(under.map((c) => c.hex), ['#c82828']);
  // an explicit minimum is honoured the same way
  const quarter = dominantColours(pixels([[[200, 40, 40, 255], 3], [[20, 40, 200, 255], 1]]), { minShare: 0.25 });
  assert.deepStrictEqual(quarter.map((c) => c.hex), ['#c82828', '#1428c8']);
  const over = dominantColours(pixels([[[200, 40, 40, 255], 4], [[20, 40, 200, 255], 1]]), { minShare: 0.25 });
  assert.deepStrictEqual(over.map((c) => c.hex), ['#c82828']);
});

test('equal shares are ordered by hex, whichever order the colours appear in the picture', () => {
  const red = [[200, 40, 40, 255], 50];
  const blue = [[20, 40, 200, 255], 50];
  const green = [[40, 200, 40, 255], 50];
  const want = ['#1428c8', '#28c828', '#c82828'];
  for (const order of [[red, blue, green], [blue, green, red], [green, red, blue], [green, blue, red], [blue, red, green], [red, green, blue]]) {
    const r = dominantColours(pixels(order));
    assert.deepStrictEqual(r.map((c) => c.hex), want, order.map((o) => o[0].join()).join(' | '));
    assert.deepStrictEqual(r.map((c) => c.share), [1 / 3, 1 / 3, 1 / 3]);
  }
  // and a bigger share still beats a smaller hex
  const mixed = dominantColours(pixels([[[20, 40, 200, 255], 10], [[200, 40, 40, 255], 40]]));
  assert.deepStrictEqual(mixed.map((c) => c.hex), ['#c82828', '#1428c8']);
});

// Three pictures with MORE distinct colours than clusters, so which colours seed the clusters (the farthest
// from the picture's mean first, each next the farthest from every one chosen) and how k-means then moves the
// centroids both decide the answer. The expected values are the algorithm's documented deterministic output
// (farthest-point seeding, ten k-means passes in OKLab), measured once and pinned: a change to the mean, the
// seeding, the tie rules or the refinement moves a share or a colour here.
const picture = (runs) => pixels(runs.map(([r, g, b, n]) => [[r, g, b, 255], n]));

test('seeding and refinement: a picture with far more colours than clusters gives these exact answers', () => {
  const nine = picture([[116, 249, 19, 9], [37, 235, 207, 1], [59, 156, 42, 2], [240, 245, 60, 10], [249, 126, 30, 2],
    [195, 125, 176, 8], [124, 83, 152, 6], [165, 70, 12, 2], [243, 112, 220, 7]]);
  assert.deepStrictEqual(dominantColours(nine, { count: 1, minShare: 0 }), [{ hex: '#c66eba', share: 21 / 47 }]);

  const eight = picture([[216, 0, 205, 1], [11, 177, 173, 10], [164, 49, 207, 7], [78, 190, 108, 11], [100, 158, 43, 4],
    [26, 149, 88, 9], [53, 19, 101, 10], [140, 248, 223, 10]]);
  assert.deepStrictEqual(dominantColours(eight, { count: 4, minShare: 0 }), [
    { hex: '#3d984d', share: 13 / 62 }, { hex: '#4ebe6c', share: 11 / 62 },
    { hex: '#0bb1ad', share: 10 / 62 }, { hex: '#351365', share: 10 / 62 },
  ]);

  const also = picture([[224, 186, 135, 11], [174, 194, 228, 1], [0, 121, 126, 1], [139, 58, 28, 10], [70, 216, 28, 7],
    [100, 41, 101, 9], [6, 57, 123, 4], [128, 174, 139, 3]]);
  assert.deepStrictEqual(dominantColours(also, { count: 2, minShare: 0.02 }), [
    { hex: '#703455', share: 23 / 46 }, { hex: '#ceb891', share: 15 / 46 },
  ]);
});

test('seeding and refinement do not depend on the order the pixels come in', () => {
  const runs = [[224, 186, 135, 11], [174, 194, 228, 1], [0, 121, 126, 1], [139, 58, 28, 10], [70, 216, 28, 7],
    [100, 41, 101, 9], [6, 57, 123, 4], [128, 174, 139, 3]];
  const forward = dominantColours(picture(runs), { count: 2 });
  const backward = dominantColours(picture([...runs].reverse()), { count: 2 });
  assert.deepStrictEqual(backward, forward);
});

// A plain <script> has no `module`: evaluating the file the way the page does proves BOTH load paths.
// `process` is injected because Stryker reads the active mutant through it; real code never touches it.
test('load path: with module.exports it exports, without it it hangs colourSeeds off window or the global', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require.resolve('../app/colour-seeds'), 'utf8');
  const load = (sandbox) => {
    const ctx = vm.createContext({ process, ...sandbox });
    vm.runInContext(src, ctx, { filename: 'colour-seeds-as-script' });
    return ctx;
  };

  const mod = { exports: {} };
  const asModule = load({ module: mod });
  assert.strictEqual(typeof mod.exports.dominantColours, 'function');
  assert.strictEqual(asModule.colourSeeds, undefined, 'a module load leaves no global behind');

  const win = {};
  load({ window: win });
  assert.strictEqual(typeof win.colourSeeds.dominantColours, 'function');

  assert.strictEqual(typeof load({}).colourSeeds.seedsOf, 'function');
  assert.strictEqual(typeof load({ module: {} }).colourSeeds.seedsOf, 'function', 'a `module` without exports is not CommonJS');
});
