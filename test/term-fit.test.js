'use strict';
/**
 * app/term-fit.js (BACKLOG #177): the terminal is fitted until the fit agrees with itself, and the pty is told only a changed size.
 *
 * The fake terminal follows xterm's own rule for the CSS cell width, `round(cols * D) / cols` (D = device cell / dpr), with D fitted to
 * the four cells the trace measured on 2026-11-06 at probe-repo-browser --width=839: 8.208333 at 72 cols, 8.21875 at 32, 8.197183 at
 * 71, 8.216216 at 37. The box has 591 px for text (600 px less the 9 px scrollbar), and FitAddon's proposal is floor(591 / cell).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const TF = require('../app/term-fit');

const D = 8.2036;
const cellAt = (cols) => Math.round(cols * D) / cols;

function fakeTerm({ cols, rows = 37, avail = 591, availH = 600, cellH = 16 }) {
  const t = { cols, rows, resizes: [] };
  return {
    t,
    size: () => ({ cols: t.cols, rows: t.rows }),
    propose: () => ({ cols: Math.floor(avail / cellAt(t.cols)), rows: Math.floor(availH / cellH) }),
    resize: (c, r) => { t.resizes.push([c, r]); t.cols = c; t.rows = r; },
  };
}

test('the fitted cells match the trace: the model is the measured terminal', () => {
  assert.strictEqual(cellAt(72).toFixed(6), '8.208333');
  assert.strictEqual(cellAt(32).toFixed(6), '8.218750');
  assert.strictEqual(cellAt(71).toFixed(6), '8.197183');
  assert.strictEqual(cellAt(37).toFixed(6), '8.216216');
});

test('#177 closing the reader from 32 columns at a 620 px box: one fit lands on 71, the settled fit on 72 (what fits), with two resizes', () => {
  const once = fakeTerm({ cols: 32 });
  const p = once.propose();
  assert.strictEqual(p.cols, 71, 'the bug: a single fit, asked at the 32-col cell, says 71');
  const f = fakeTerm({ cols: 32 });
  const end = TF.settleFit(f);
  assert.deepStrictEqual(end, { cols: 72, rows: 37 });
  assert.deepStrictEqual(f.t.resizes, [[71, 37], [72, 37]]);
  assert.deepStrictEqual(f.propose(), { cols: 72, rows: 37 }, 'and the box agrees with the size it settled on');
});

test('#177 the divider drag (37 cols, the box narrowed to 300 px): it settles on a size the box agrees with, in one resize', () => {
  // The trace's own numbers: the drag took the box from 335 to 300 px and the terminal from 37 to 32 columns. 32 is a size the box
  // agrees with at its own cells, so it is settled (33 is one too: a second fixed point, which a proposal-only fit can't reach
  // without trying a resize to it; recorded as a follow-up in the lane's handoff, not decided here).
  const f = fakeTerm({ cols: 37, avail: 271 });
  const end = TF.settleFit(f);
  assert.deepStrictEqual(f.propose(), end);
  assert.ok(end.cols * cellAt(end.cols) <= 271, 'and its own cells fit the box');
  assert.strictEqual(f.t.resizes.length, 1);
});

test('#177 the reader OPENING (72 -> a 300 px box) and a wider box settle at once, with one resize each', () => {
  const open = fakeTerm({ cols: 72, avail: 271 });
  assert.deepStrictEqual(TF.settleFit(open), { cols: 33, rows: 37 });
  assert.strictEqual(open.t.resizes.length, 1);
  const wide = fakeTerm({ cols: 72, avail: 916 });   // the default 945 px box
  assert.deepStrictEqual(TF.settleFit(wide), { cols: 111, rows: 37 });
  assert.strictEqual(wide.t.resizes.length, 1);
});

test('a fit that already agrees changes nothing', () => {
  const f = fakeTerm({ cols: 72 });
  assert.deepStrictEqual(TF.settleFit(f), { cols: 72, rows: 37 });
  assert.deepStrictEqual(f.t.resizes, []);
});

test('no usable proposal (no box or no renderer yet: FitAddon gives nothing, or NaN) changes nothing', () => {
  for (const p of [undefined, null, { cols: NaN, rows: 3 }, { cols: 0, rows: 3 }, { cols: 3.5, rows: 3 }]) {
    const resizes = [];
    const end = TF.settleFit({ size: () => ({ cols: 80, rows: 24 }), propose: () => p, resize: (c, r) => resizes.push([c, r]) });
    assert.deepStrictEqual(end, { cols: 80, rows: 24 });
    assert.deepStrictEqual(resizes, [], JSON.stringify(p));
  }
});

test('a knife-edge cycle (n proposes m, m proposes n) ends on the smaller size, the one that fits, and stops', () => {
  const t = { cols: 50, rows: 20 };
  const resizes = [];
  const end = TF.settleFit({
    size: () => ({ ...t }),
    propose: () => ({ cols: t.cols === 50 ? 51 : 50, rows: 20 }),
    resize: (c, r) => { resizes.push([c, r]); t.cols = c; t.rows = r; },
  });
  assert.deepStrictEqual(end, { cols: 50, rows: 20 });
  assert.deepStrictEqual(resizes, [[51, 20], [50, 20]]);
});

test('property: from any column count and any box, the fit settles within MAX_STEPS on a size the box agrees with (or the smaller of a cycle)', () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 400 }), fc.integer({ min: 20, max: 3000 }), (cols, avail) => {
    const f = fakeTerm({ cols, avail });
    const end = TF.settleFit(f);
    assert.ok(f.t.resizes.length <= TF.MAX_STEPS);
    const p = f.propose();
    // Settled: the box agrees; or, at a cycle's end, the size is the smaller one, so it proposes a bigger one it can't hold.
    assert.ok(p.cols === end.cols || p.cols > end.cols, `ended at ${end.cols} cols, the box proposes ${p.cols} (avail ${avail}, from ${cols})`);
    // And what it ended on fits: its own cells fit the box.
    assert.ok(end.cols * cellAt(end.cols) <= avail || end.cols === 2, `${end.cols} cols of ${cellAt(end.cols)} px overflow ${avail}`);
  }), { numRuns: 500 });
});

test('the pty is told only a size it was not told last: an unchanged refit sends nothing', () => {
  assert.strictEqual(TF.needsSend({ cols: 72, rows: 37 }, null), true, 'never told');
  assert.strictEqual(TF.needsSend({ cols: 72, rows: 37 }, { cols: 71, rows: 37 }), true);
  assert.strictEqual(TF.needsSend({ cols: 72, rows: 37 }, { cols: 72, rows: 36 }), true);
  assert.strictEqual(TF.needsSend({ cols: 72, rows: 37 }, { cols: 72, rows: 37 }), false);
});
