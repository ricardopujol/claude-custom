'use strict';
/** app/games-rules.js (BACKLOG #41): the three games' pure rules, by example. The properties are in games-rules-properties.test.js. */
const test = require('node:test');
const assert = require('node:assert');

const G = require('../app/games-rules');

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

// --- Stack the PRs --------------------------------------------------------------------------------------------------

test('stack: the base is 180 wide, and a new block is as wide as the top one, at the left wall, heading right', () => {
  assert.deepStrictEqual(G.stackStart(), [{ x: 110, w: 180 }]);
  assert.deepStrictEqual(G.stackBlock([{ x: 110, w: 150 }]), { x: 0, w: 150, dir: 1 });
});

test('stack: the slide gets faster with every block', () => {
  assert.strictEqual(G.stackSpeed([{ x: 0, w: 1 }]), 139);
  assert.strictEqual(G.stackSpeed([{ x: 0, w: 1 }, { x: 0, w: 1 }, { x: 0, w: 1 }]), 157);
});

test('stack: the block moves speed * dt and bounces off both walls', () => {
  assert.deepStrictEqual(G.stackStep({ x: 10, w: 100, dir: 1 }, 100, 0.5), { x: 60, w: 100, dir: 1 });
  assert.deepStrictEqual(G.stackStep({ x: 280, w: 100, dir: 1 }, 100, 0.5), { x: 300, w: 100, dir: -1 });
  assert.deepStrictEqual(G.stackStep({ x: 20, w: 100, dir: -1 }, 100, 0.5), { x: 0, w: 100, dir: 1 });
});

test('stack: a drop cuts the overhang on both sides', () => {
  const r = G.stackDrop([{ x: 100, w: 100 }], { x: 130, w: 100 });
  assert.strictEqual(r.over, false);
  assert.strictEqual(r.perfect, false);
  assert.deepStrictEqual(r.stack[1], { x: 130, w: 70 });
  const l = G.stackDrop([{ x: 100, w: 100 }], { x: 60, w: 100 });
  assert.deepStrictEqual(l.stack[1], { x: 100, w: 60 });
});

test('stack: a drop that overlaps by 4 px or less is a miss, 5 px is not', () => {
  assert.deepStrictEqual(G.stackDrop([{ x: 100, w: 100 }], { x: 196, w: 100 }), { over: true });
  assert.strictEqual(G.stackDrop([{ x: 100, w: 100 }], { x: 195, w: 100 }).over, false);
  assert.deepStrictEqual(G.stackDrop([{ x: 100, w: 100 }], { x: 0, w: 50 }), { over: true });
});

test('stack: a drop within 3 px is perfect: it snaps to the block below and grows 8 px back, up to 180', () => {
  const r = G.stackDrop([{ x: 100, w: 120 }], { x: 103, w: 120 });
  assert.strictEqual(r.perfect, true);
  assert.deepStrictEqual(r.stack[1], { x: 100, w: 128 });
  const left = G.stackDrop([{ x: 100, w: 120 }], { x: 97, w: 120 });
  assert.deepStrictEqual(left.stack[1], { x: 100, w: 128 });
  const capped = G.stackDrop([{ x: 100, w: 176 }], { x: 100, w: 176 });
  assert.deepStrictEqual(capped.stack[1], { x: 100, w: 180 });
});

test('stack: 4 px off is not perfect', () => {
  const r = G.stackDrop([{ x: 100, w: 120 }], { x: 104, w: 120 });
  assert.strictEqual(r.perfect, false);
  assert.deepStrictEqual(r.stack[1], { x: 104, w: 116 });
});

test('stack: growth never pushes the block off the right wall', () => {
  const r = G.stackDrop([{ x: 300, w: 100 }], { x: 300, w: 100 });
  assert.deepStrictEqual(r.stack[1], { x: 300, w: 100 });
});

test('stack: the score counts the blocks on the base', () => {
  assert.strictEqual(G.stackScore(G.stackStart()), 0);
  assert.strictEqual(G.stackScore([{ x: 0, w: 1 }, { x: 0, w: 1 }, { x: 0, w: 1 }]), 2);
});

test('stack: a drop does not change the stack it was given', () => {
  const stack = Object.freeze([Object.freeze({ x: 100, w: 100 })]);
  G.stackDrop(stack, { x: 130, w: 100 });
  assert.strictEqual(stack.length, 1);
});

// --- Merge 2048 -----------------------------------------------------------------------------------------------------

test('merge: a line slides to its front and equal neighbours merge once', () => {
  assert.deepStrictEqual(G.mergeSlide([0, 2, 0, 2]), { line: [4, 0, 0, 0], gained: 4 });
  assert.deepStrictEqual(G.mergeSlide([2, 2, 2, 2]), { line: [4, 4, 0, 0], gained: 8 });
  assert.deepStrictEqual(G.mergeSlide([4, 2, 2, 0]), { line: [4, 4, 0, 0], gained: 4 });
  assert.deepStrictEqual(G.mergeSlide([2, 2, 2, 0]), { line: [4, 2, 0, 0], gained: 4 });
  assert.deepStrictEqual(G.mergeSlide([2, 4, 2, 4]), { line: [2, 4, 2, 4], gained: 0 });
});

test('merge: a move in each direction', () => {
  const b = [
    2, 0, 0, 2,
    0, 0, 0, 0,
    4, 4, 0, 0,
    0, 0, 2, 0,
  ];
  assert.deepStrictEqual(G.mergeMove(b, 'L').board, [4, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 2, 0, 0, 0]);
  assert.deepStrictEqual(G.mergeMove(b, 'R').board, [0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 2]);
  assert.deepStrictEqual(G.mergeMove(b, 'U').board, [2, 4, 2, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(G.mergeMove(b, 'D').board, [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 4, 2, 2]);
  assert.strictEqual(G.mergeMove(b, 'L').gained, 12);
});

test('merge: a move that changes nothing says so and adds no tile', () => {
  const b = [2, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0];
  const m = G.mergeMove(b, 'L');
  assert.strictEqual(m.moved, false);
  const s = G.mergeStep(b, 'L', seq(0, 0));
  assert.deepStrictEqual(s.board, b);
  assert.strictEqual(s.moved, false);
});

test('merge: a move that changes the board adds one tile: a 2, or a 4 one time in ten', () => {
  const b = [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const two = G.mergeStep(b, 'L', seq(0, 0.5));
  assert.deepStrictEqual(two.board.filter(Boolean).sort(), [2, 2]);
  const four = G.mergeStep(b, 'L', seq(0, 0.95));
  assert.deepStrictEqual(four.board.filter(Boolean).sort(), [2, 4]);
});

test('merge: the new tile lands on an empty cell chosen by the rng', () => {
  const b = Array(16).fill(0);
  assert.strictEqual(G.mergeAdd(b, seq(0, 0))[0], 2);
  assert.strictEqual(G.mergeAdd(b, seq(0.999, 0))[15], 2);
  const full = Array(16).fill(2);
  assert.strictEqual(G.mergeAdd(full, seq(0)), full);
});

test('merge: a new game starts with two tiles', () => {
  assert.strictEqual(G.mergeStart(Math.random).filter(Boolean).length, 2);
});

test('merge: the board is over only when it is full and nothing merges', () => {
  const stuck = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  assert.strictEqual(G.mergeCanMove(stuck), false);
  assert.strictEqual(G.mergeCanMove(stuck.map((v, k) => (k === 15 ? 0 : v))), true);
  assert.strictEqual(G.mergeCanMove(stuck.map((v, k) => (k === 15 ? 4 : v))), true, 'two 4s side by side');
  const down = stuck.slice(); down[12] = 2;      // 2 above 2 in the first column
  assert.strictEqual(G.mergeCanMove(down), true);
  assert.strictEqual(G.mergeStep(stuck, 'L', seq(0)).over, true);
});

// --- Pipeline -------------------------------------------------------------------------------------------------------

test('pipe: a straight piece opens opposite sides, a bend opens neighbouring ones, and a turn moves them clockwise', () => {
  assert.deepStrictEqual(G.pipeEnds({ type: 'I', rot: 0 }), [0, 2]);
  assert.deepStrictEqual(G.pipeEnds({ type: 'I', rot: 1 }), [1, 3]);
  assert.deepStrictEqual(G.pipeEnds({ type: 'L', rot: 0 }), [0, 1]);
  assert.deepStrictEqual(G.pipeEnds({ type: 'L', rot: 3 }), [3, 0]);
});

test('pipe: boards grow from 4 to 6, one size per two solved', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 40].map(G.pipeSize), [4, 4, 5, 5, 6, 6, 6, 6]);
});

test('pipe: a hand-built straight 2x2 board is solved only when a pipe runs from src to tests', () => {
  // (0,0) I(rot 1: left-right) -> (0,1) L opening left+down -> (1,1) L opening up+right
  const solved = { n: 2, cells: [{ type: 'I', rot: 1 }, { type: 'L', rot: 2 }, { type: 'I', rot: 0 }, { type: 'L', rot: 0 }] };
  // (0,1): L rot 2 opens 2,3 = down+left. (1,1) must open up+right = 0,1 = L rot 0.
  assert.strictEqual(G.pipeSolved(solved), true);
  assert.strictEqual(G.pipeSolved(G.pipeTurn(solved, 0)), false);
  assert.strictEqual(G.pipeSolved(G.pipeTurn(solved, 3)), false);
});

test('pipe: a pipe that wanders off the edge is not solved', () => {
  const b = { n: 2, cells: [{ type: 'I', rot: 0 }, { type: 'I', rot: 0 }, { type: 'I', rot: 0 }, { type: 'I', rot: 0 }] };
  assert.strictEqual(G.pipeSolved(b), false);
});

test('pipe: a turn changes one tile by a quarter, wraps at four, and ignores an index off the board', () => {
  const b = { n: 2, cells: [{ type: 'I', rot: 3 }, { type: 'L', rot: 0 }, { type: 'L', rot: 0 }, { type: 'L', rot: 0 }] };
  const t = G.pipeTurn(b, 0);
  assert.strictEqual(t.cells[0].rot, 0);
  assert.strictEqual(b.cells[0].rot, 3, 'the old board is untouched');
  assert.strictEqual(t.cells[1], b.cells[1]);
  for (const bad of [-1, 4, 1.5, NaN, undefined, '0']) assert.strictEqual(G.pipeTurn(b, bad), b);
});

test('pipe: the solvability search says yes for a board that can be solved and no for one that cannot', () => {
  assert.strictEqual(G.pipeSolvable({ n: 2, cells: [{ type: 'I', rot: 0 }, { type: 'L', rot: 0 }, { type: 'L', rot: 0 }, { type: 'L', rot: 0 }] }), true);
  // all bends: the entry tile cannot be a straight run, and a 2x2 of bends cannot end on the right of the last one with a left entry
  assert.strictEqual(G.pipeSolvable({ n: 1, cells: [{ type: 'L', rot: 0 }] }), false);
  assert.strictEqual(G.pipeSolvable({ n: 1, cells: [{ type: 'I', rot: 0 }] }), true);
});

test('pipe: a made board has the asked side, n*n tiles, and is not solved yet', () => {
  for (const n of [4, 5, 6]) {
    const b = G.pipeBoard(n, Math.random);
    assert.strictEqual(b.n, n);
    assert.strictEqual(b.cells.length, n * n);
    assert.strictEqual(G.pipeSolved(b), false);
  }
});

test('pipe: the board is centred in the field, tiles at most 64 px, and a point maps to the tile under it', () => {
  assert.deepStrictEqual(G.pipeGeometry(4), { size: 64, x: 72, y: 22 });
  assert.deepStrictEqual(G.pipeGeometry(6), { size: 260 / 6, x: (400 - 260) / 2, y: (300 - 260) / 2 });
  assert.strictEqual(G.pipeCellAt(4, 72, 22), 0);
  assert.strictEqual(G.pipeCellAt(4, 72 + 64 * 4 - 1, 22 + 64 * 4 - 1), 15);
  assert.strictEqual(G.pipeCellAt(4, 72 + 64, 22), 1);
  assert.strictEqual(G.pipeCellAt(4, 72, 22 + 64), 4);
});

test('pipe: a point off the board, or not a number, is no tile', () => {
  for (const [x, y] of [[71, 30], [30, 21], [72 + 256, 30], [100, 22 + 256], [NaN, 30], [30, Infinity], [undefined, 3]]) {
    assert.strictEqual(G.pipeCellAt(4, x, y), -1, `${x},${y}`);
  }
});

test('swipe: the longer axis wins, 20 px is the shortest swipe, and anything else is null', () => {
  assert.strictEqual(G.swipeDir(30, 5), 'R');
  assert.strictEqual(G.swipeDir(-30, 5), 'L');
  assert.strictEqual(G.swipeDir(5, 30), 'D');
  assert.strictEqual(G.swipeDir(5, -30), 'U');
  assert.strictEqual(G.swipeDir(20, 0), 'R');
  assert.strictEqual(G.swipeDir(19, 19), null);
  assert.strictEqual(G.swipeDir(NaN, 40), null);
  assert.strictEqual(G.swipeDir(25, 25), 'D', 'a tie goes vertical, as the prototype did');
});
