'use strict';
/**
 * The rules of the three wait games (BACKLOG #41): Stack the PRs, Merge 2048 and Pipeline. Ricardo picked them by playing the
 * prototype, so the numbers below are the prototype's (documentation/DESIGN_ROUND_2026-10-09B.md, rounds 10-11).
 *
 * Pure. Nothing here draws, reads a clock or touches the DOM; every function takes the state and returns a NEW one, and anything
 * random takes `rng` (a function returning a number in [0, 1)), so a test can drive a game from a seed and a property can run a
 * thousand of them. app/games-display.js draws the result; app/games-round.js owns the 45-second round.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one global scope (test/renderer-scope.test.js).
 * The page sees one name, `gamesRules`.
 */
(function (root) {

const FIELD = Object.freeze({ width: 400, height: 300 });

// --- Stack the PRs -------------------------------------------------------------------------------------------------
// A block slides left and right over the stack; Space or a click drops it. What overhangs the block below is cut off. A drop
// within PERFECT px of the block below is "perfect": it snaps onto it and grows back a little. The slide speeds up with height.
const STACK = Object.freeze({ start: 180, cap: 180, perfect: 3, grow: 8, miss: 4, speed: 130, ramp: 9, startX: 110 });

function stackStart() { return [{ x: STACK.startX, w: STACK.start }]; }

/** A fresh sliding block above `stack`: as wide as the top block, at the left wall. */
function stackBlock(stack) { return { x: 0, w: stack[stack.length - 1].w, dir: 1 }; }

/** Pixels per second, rising with the height of the stack. */
function stackSpeed(stack) { return STACK.speed + stack.length * STACK.ramp; }

/** Slides `cur` for `dt` seconds and bounces it off both walls. */
function stackStep(cur, speed, dt) {
  let x = cur.x + cur.dir * speed * dt;
  let dir = cur.dir;
  if (x < 0) { x = 0; dir = 1; }
  if (x + cur.w > FIELD.width) { x = FIELD.width - cur.w; dir = -1; }
  return { x, w: cur.w, dir };
}

/**
 * Drops `cur` onto the top of `stack`. -> { over: true } when it missed (an overlap of STACK.miss px or less), else
 * { over: false, stack, perfect }: the new stack, and whether the drop was within STACK.perfect px of the block below.
 */
function stackDrop(stack, cur) {
  const top = stack[stack.length - 1];
  let l = Math.max(top.x, cur.x);
  let r = Math.min(top.x + top.w, cur.x + cur.w);
  if (r - l <= STACK.miss) return { over: true };
  const perfect = Math.abs(cur.x - top.x) <= STACK.perfect;
  if (perfect) { l = top.x; r = Math.min(FIELD.width, top.x + Math.min(STACK.cap, top.w + STACK.grow)); }
  return { over: false, perfect, stack: stack.concat([{ x: l, w: r - l }]) };
}

/** The score: how many blocks sit on the base. */
const stackScore = stack => stack.length - 1;

// --- Merge 2048 -----------------------------------------------------------------------------------------------------
// A 4x4 board, row-major, 0 for an empty cell. A move slides every tile as far as it goes; two equal tiles that meet merge into
// one of twice the value, and a tile that has just merged does not merge again in the same move.
const SIDE = 4;
const DIRS = Object.freeze(['L', 'R', 'U', 'D']);

function mergeStart(rng) { return mergeAdd(mergeAdd(Array(SIDE * SIDE).fill(0), rng), rng); }

/** The board with one new tile (2, or 4 one time in ten) on a random empty cell; the same board when none is empty. */
function mergeAdd(board, rng) {
  const empty = [];
  board.forEach((v, k) => { if (!v) empty.push(k); });
  if (!empty.length) return board;
  const at = empty[Math.floor(rng() * empty.length)];
  const next = board.slice();
  next[at] = rng() < 0.9 ? 2 : 4;
  return next;
}

/** One line slid toward its front: -> { line, gained } where `gained` is the sum of the tiles that merged. */
function mergeSlide(line) {
  const vals = line.filter(Boolean);
  const out = [];
  let gained = 0;
  for (let k = 0; k < vals.length; k += 1) {
    if (vals[k] === vals[k + 1]) { out.push(vals[k] * 2); gained += vals[k] * 2; k += 1; } else out.push(vals[k]);
  }
  while (out.length < line.length) out.push(0);
  return { line: out, gained };
}

// The four cells of line `n`, front first, for a move in `dir`.
function lineCells(dir, n) {
  return [0, 1, 2, 3].map(c => (dir === 'L' ? n * SIDE + c
    : dir === 'R' ? n * SIDE + SIDE - 1 - c
      : dir === 'U' ? c * SIDE + n
        : (SIDE - 1 - c) * SIDE + n));
}

/** Slides the whole board. -> { board, gained, moved }; `moved` is false (and the board unchanged) when nothing could move. */
function mergeMove(board, dir) {
  const next = board.slice();
  let gained = 0;
  let moved = false;
  for (let n = 0; n < SIDE; n += 1) {
    const cells = lineCells(dir, n);
    const slid = mergeSlide(cells.map(k => board[k]));
    gained += slid.gained;
    cells.forEach((k, j) => { if (next[k] !== slid.line[j]) moved = true; next[k] = slid.line[j]; });
  }
  return { board: next, gained, moved };
}

/** Is any move possible: an empty cell, or two equal neighbours. */
function mergeCanMove(board) {
  if (board.includes(0)) return true;
  for (let k = 0; k < board.length; k += 1) {
    if (k % SIDE < SIDE - 1 && board[k] === board[k + 1]) return true;
    if (k < board.length - SIDE && board[k] === board[k + SIDE]) return true;
  }
  return false;
}

/**
 * A move and its consequence: the new tile when the board changed. -> { board, gained, moved, over } where `over` means no move is
 * left. A move that changes nothing adds no tile, so pressing into a wall is free.
 */
function mergeStep(board, dir, rng) {
  const m = mergeMove(board, dir);
  const after = m.moved ? mergeAdd(m.board, rng) : m.board;
  return { board: after, gained: m.gained, moved: m.moved, over: !mergeCanMove(after) };
}

// --- Pipeline -------------------------------------------------------------------------------------------------------
// A square board of pipe tiles, 'I' (straight) and 'L' (a bend). A tile has two open sides, 0 up, 1 right, 2 down, 3 left, turned
// by `rot` quarter-turns. Clicking turns one tile. The board is solved when a pipe runs from the left of the top-left tile to the
// right of the bottom-right one ("src" to "tests"). Each solved board is a point and the next is bigger.
const PIPE = Object.freeze({ min: 4, max: 6, every: 2 });
const STEP = Object.freeze([[-1, 0], [0, 1], [1, 0], [0, -1]]);   // [row, col] of the neighbour through side 0..3
const BASE = Object.freeze({ I: [0, 2], L: [0, 1] });

/** The two open sides of a tile. */
function pipeEnds(cell) { return BASE[cell.type].map(e => (e + cell.rot) % 4); }

/** The side length of the board after `solved` boards. */
function pipeSize(solved) { return Math.min(PIPE.max, PIPE.min + Math.floor(solved / PIPE.every)); }

/** Follows the pipe from the entry. -> true when it reaches the bottom-right tile's right side. */
function pipeSolved(board) {
  const n = board.n;
  const seen = new Set();
  const queue = [[0, 0, 3]];                         // [row, col, the side we came in through]
  while (queue.length) {
    const [r, c, from] = queue.shift();
    if (r < 0 || c < 0 || r >= n || c >= n) continue;
    const ends = pipeEnds(board.cells[r * n + c]);
    if (!ends.includes(from)) continue;
    const key = r * n + c;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r === n - 1 && c === n - 1 && ends.includes(1)) return true;
    for (const d of ends) {
      if (d === from) continue;
      queue.push([r + STEP[d][0], c + STEP[d][1], (d + 2) % 4]);
    }
  }
  return false;
}

/**
 * Can SOME turning of the tiles solve this board? A search over turnings that follows one pipe: at each tile it tries the four
 * turns that open the side the pipe arrives by. Independent of how the board was made, so a test can hold the generator to it.
 */
function pipeSolvable(board) {
  const n = board.n;
  const used = new Set();
  const walk = (r, c, from) => {
    if (r < 0 || c < 0 || r >= n || c >= n || used.has(r * n + c)) return false;
    const cell = board.cells[r * n + c];
    used.add(r * n + c);
    for (let rot = 0; rot < 4; rot += 1) {
      const ends = pipeEnds({ type: cell.type, rot });
      if (!ends.includes(from)) continue;
      const out = ends.find(d => d !== from);
      if (r === n - 1 && c === n - 1 && out === 1) { used.delete(r * n + c); return true; }
      if (walk(r + STEP[out][0], c + STEP[out][1], (out + 2) % 4)) { used.delete(r * n + c); return true; }
    }
    used.delete(r * n + c);
    return false;
  };
  return walk(0, 0, 3);
}

/** A board of side `n`, solvable by construction and never already solved. */
function pipeBoard(n, rng) {
  const path = [[0, 0]];
  let r = 0;
  let c = 0;
  while (r < n - 1 || c < n - 1) {
    if (r === n - 1) c += 1;
    else if (c === n - 1) r += 1;
    else if (rng() < 0.5) c += 1;
    else r += 1;
    path.push([r, c]);
  }
  const at = new Map(path.map((p, k) => [p[0] * n + p[1], k]));
  const side = (from, to) => (to[0] < from[0] ? 0 : to[1] > from[1] ? 1 : to[0] > from[0] ? 2 : 3);
  const cells = [];
  for (let rr = 0; rr < n; rr += 1) {
    for (let cc = 0; cc < n; cc += 1) {
      const k = at.get(rr * n + cc);
      let type = rng() < 0.5 ? 'I' : 'L';
      if (k !== undefined) {
        const prev = k ? path[k - 1] : [rr, cc - 1];
        const next = k < path.length - 1 ? path[k + 1] : [rr, cc + 1];
        type = (side([rr, cc], prev) + 2) % 4 === side([rr, cc], next) ? 'I' : 'L';
      }
      cells.push({ type, rot: Math.floor(rng() * 4) });
    }
  }
  let board = { n, cells };
  // A free point is not a point: turn the first tile until the board is not solved yet.
  for (let guard = 0; pipeSolved(board) && guard < 4; guard += 1) board = pipeTurn(board, 0);
  return board;
}

/** The board with tile `index` turned a quarter. An index off the board changes nothing. */
function pipeTurn(board, index) {
  if (!Number.isInteger(index) || index < 0 || index >= board.cells.length) return board;
  const cells = board.cells.slice();
  cells[index] = { type: cells[index].type, rot: (cells[index].rot + 1) % 4 };
  return { n: board.n, cells };
}

/** Where the board sits in the field: tile size and the top-left corner, so drawing and clicking agree. */
function pipeGeometry(n) {
  const size = Math.min(260 / n, 64);
  return { size, x: (FIELD.width - size * n) / 2, y: (FIELD.height - size * n) / 2 };
}

/** The tile under a point of the field (field pixels), or -1 for a point off the board. */
function pipeCellAt(n, px, py) {
  if (!Number.isFinite(px) || !Number.isFinite(py)) return -1;
  const g = pipeGeometry(n);
  const c = Math.floor((px - g.x) / g.size);
  const r = Math.floor((py - g.y) / g.size);
  return r < 0 || c < 0 || r >= n || c >= n ? -1 : r * n + c;
}

// --- Swipe ----------------------------------------------------------------------------------------------------------------

const SWIPE_MIN = 20;       // px a pointer must travel to count as a swipe rather than a click

/** The move a drag of (dx, dy) means for Merge 2048, or null when it was too short. The longer axis wins. */
function swipeDir(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
}

const API = {
  pipeGeometry, pipeCellAt, swipeDir, SWIPE_MIN,
  FIELD, STACK, DIRS, PIPE,
  stackStart, stackBlock, stackSpeed, stackStep, stackDrop, stackScore,
  mergeStart, mergeAdd, mergeSlide, mergeMove, mergeCanMove, mergeStep,
  pipeEnds, pipeSize, pipeSolved, pipeSolvable, pipeBoard, pipeTurn,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.gamesRules = API;

})(typeof window !== 'undefined' ? window : globalThis);
