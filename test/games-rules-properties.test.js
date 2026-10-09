'use strict';
/**
 * PROPERTIES of the wait games' rules (BACKLOG #41): what must hold after ANY play, not just the plays the examples picked.
 * 2048's two are the ones the brief names: a move conserves the sum of the tiles (only the new tile adds to it), and no tile
 * merges twice in one move. Pipeline's is that a board is always solvable, held to a search that never looks at how it was made.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const G = require('../app/games-rules');

const RUNS = { numRuns: Number(process.env.GAMES_RUNS) || 300 };
const sum = a => a.reduce((s, v) => s + v, 0);

// A seeded generator: fast-check hands over the seed, so a failure replays.
const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const seedArb = fc.integer({ min: 0, max: 0xffffffff });

const tileArb = fc.constantFrom(0, 0, 0, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048);
const boardArb = fc.array(tileArb, { minLength: 16, maxLength: 16 });
const dirArb = fc.constantFrom(...G.DIRS);

// --- Merge 2048 -----------------------------------------------------------------------------------------------------

test('P1: a move conserves the sum of the tiles; the reported gain is what merged', () => {
  fc.assert(fc.property(boardArb, dirArb, (b, d) => {
    const m = G.mergeMove(b, d);
    assert.strictEqual(sum(m.board), sum(b));
    assert.ok(m.gained >= 0 && m.gained <= sum(b));
  }), RUNS);
});

test('P2: a full step (move, then the new tile) adds exactly the new tile, and only when something moved', () => {
  fc.assert(fc.property(boardArb, dirArb, seedArb, (b, d, seed) => {
    const s = G.mergeStep(b, d, lcg(seed));
    const grown = sum(s.board) - sum(b);
    if (!s.moved) { assert.deepStrictEqual(s.board, b); return; }
    const full = !G.mergeMove(b, d).board.includes(0);
    if (full) assert.strictEqual(grown, 0, 'no empty cell, no new tile');
    else assert.ok(grown === 2 || grown === 4, `the new tile is a 2 or a 4 (grew by ${grown})`);
  }), RUNS);
});

// The reference: pair the front two when equal, else keep the front and carry on. Written recursively, unlike the loop under test.
const ref = v => (v.length < 2 ? v : v[0] === v[1] ? [v[0] * 2, ...ref(v.slice(2))] : [v[0], ...ref(v.slice(1))]);

test('P3: no tile merges twice: a line slides exactly like "pair the front two once, move on"', () => {
  fc.assert(fc.property(fc.array(tileArb, { minLength: 4, maxLength: 4 }), (line) => {
    const expected = ref(line.filter(Boolean));
    while (expected.length < 4) expected.push(0);
    assert.deepStrictEqual(G.mergeSlide(line).line, expected);
  }), RUNS);
});

test('P4: no tile ever exceeds twice the biggest tile before the move (a double merge would)', () => {
  fc.assert(fc.property(boardArb, dirArb, (b, d) => {
    const m = G.mergeMove(b, d);
    assert.ok(Math.max(...m.board) <= 2 * Math.max(...b));
    // and a tile only appears from the line it was in: the count of tiles never grows
    assert.ok(m.board.filter(Boolean).length <= b.filter(Boolean).length);
  }), RUNS);
});

test('P6: the game is over exactly when no direction moves anything', () => {
  fc.assert(fc.property(boardArb, (b) => {
    const anyMoves = G.DIRS.some(d => G.mergeMove(b, d).moved);
    assert.strictEqual(G.mergeCanMove(b), anyMoves);
  }), RUNS);
});

// --- Pipeline -------------------------------------------------------------------------------------------------------

test('P7: every board the generator makes is solvable, and is not solved already', () => {
  fc.assert(fc.property(fc.integer({ min: 4, max: 6 }), seedArb, (n, seed) => {
    const b = G.pipeBoard(n, lcg(seed));
    assert.strictEqual(G.pipeSolvable(b), true);
    assert.strictEqual(G.pipeSolved(b), false);
  }), RUNS);
});

test('P8: turning any tile keeps a board solvable (a turn only changes which way a tile faces)', () => {
  fc.assert(fc.property(fc.integer({ min: 4, max: 6 }), seedArb, fc.nat(35), (n, seed, i) => {
    let b = G.pipeBoard(n, lcg(seed));
    b = G.pipeTurn(b, i % (n * n));
    assert.strictEqual(G.pipeSolvable(b), true);
  }), RUNS);
});

test('P9: four turns of one tile bring it back', () => {
  fc.assert(fc.property(seedArb, fc.nat(15), (seed, i) => {
    const b = G.pipeBoard(4, lcg(seed));
    let t = b;
    for (let k = 0; k < 4; k += 1) t = G.pipeTurn(t, i);
    assert.deepStrictEqual(t, b);
  }), RUNS);
});

// --- Stack the PRs ----------------------------------------------------------------------------------------------------

const stackArb = fc.record({ x: fc.integer({ min: 0, max: 220 }), w: fc.integer({ min: 20, max: 180 }) })
  .filter(b => b.x + b.w <= 400);
const dropXArb = fc.integer({ min: 0, max: 400 });

test('P11: a drop only ever lands inside the block below, and the stack stays inside the field', () => {
  fc.assert(fc.property(stackArb, dropXArb, (top, x) => {
    const cur = { x: Math.min(x, 400 - top.w), w: top.w };
    const r = G.stackDrop([top], cur);
    if (r.over) return;
    const nb = r.stack[1];
    assert.ok(nb.x >= 0 && nb.x + nb.w <= 400);
    assert.ok(nb.w <= G.STACK.cap);
    if (!r.perfect) {
      assert.ok(nb.x >= top.x && nb.x + nb.w <= top.x + top.w, 'a cut block sits on the one below');
      assert.ok(nb.w <= top.w, 'a cut never grows');
    }
  }), RUNS);
});

test('P12: a perfect drop never shrinks the stack and keeps its left edge', () => {
  fc.assert(fc.property(stackArb, fc.integer({ min: -3, max: 3 }), (top, off) => {
    const x = top.x + off;
    if (x < 0 || x + top.w > 400) return;
    const r = G.stackDrop([top], { x, w: top.w });
    assert.strictEqual(r.over, false);
    assert.strictEqual(r.perfect, true);
    assert.strictEqual(r.stack[1].x, top.x);
    assert.ok(r.stack[1].w >= top.w);
  }), RUNS);
});

test('P13: the sliding block never leaves the field, whatever the speed and step', () => {
  fc.assert(fc.property(
    fc.integer({ min: 20, max: 180 }), fc.double({ min: 0, max: 2000, noNaN: true }), fc.double({ min: 0, max: 0.05, noNaN: true }),
    fc.integer({ min: 1, max: 300 }),
    (w, speed, dt, steps) => {
      let cur = { x: 0, w, dir: 1 };
      for (let k = 0; k < steps; k += 1) {
        cur = G.stackStep(cur, speed, dt);
        assert.ok(cur.x >= 0 && cur.x + cur.w <= 400 + 1e-9);
      }
    },
  ), RUNS);
});
