'use strict';
/** host/game-scores.js (BACKLOG #41): the wait games' best scores, against the REAL store on a temp dir. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { createStore } = require('../host/store');
const { createScoreStore, clean, GAMES, KEY, MAX_SCORE } = require('../host/game-scores');
const { tmpDir } = require('./tmp-dir');

const rig = () => {
  const dir = tmpDir('cc-games-');
  const store = createStore({ dir });
  return { dir, store, scores: createScoreStore(store), file: path.join(dir, `${KEY}.json`) };
};
const zero = { stack: 0, merge: 0, pipeline: 0 };

test('the three games are stack, merge and pipeline, and nothing stored reads as 0 for each', () => {
  assert.deepStrictEqual([...GAMES], ['stack', 'merge', 'pipeline']);
  assert.deepStrictEqual(rig().scores.read(), zero);
});

test('a submitted score is kept, and survives a new store on the same folder', () => {
  const { dir, scores } = rig();
  assert.deepStrictEqual(scores.submit('merge', 340), { stack: 0, merge: 340, pipeline: 0 });
  assert.deepStrictEqual(createScoreStore(createStore({ dir })).read(), { stack: 0, merge: 340, pipeline: 0 });
});

test('a best is raised, never lowered, and a tie writes nothing', () => {
  const { scores, file } = rig();
  scores.submit('stack', 10);
  assert.strictEqual(scores.submit('stack', 4).stack, 10);
  assert.strictEqual(scores.submit('stack', 25).stack, 25);
  const before = fs.statSync(file).mtimeMs;
  const raw = fs.readFileSync(file, 'utf8');
  assert.strictEqual(scores.submit('stack', 25).stack, 25);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
  assert.strictEqual(fs.statSync(file).mtimeMs, before);
});

test('each game keeps its own best', () => {
  const { scores } = rig();
  scores.submit('stack', 7);
  scores.submit('pipeline', 3);
  assert.deepStrictEqual(scores.read(), { stack: 7, merge: 0, pipeline: 3 });
});

test('a game we don\'t have, or a score that isn\'t a whole count, is refused and writes nothing', () => {
  const { scores, file } = rig();
  for (const g of ['bugs', '', undefined, null, 7, '__proto__', 'constructor']) assert.strictEqual(scores.submit(g, 5), null, String(g));
  for (const v of [-1, 1.5, NaN, Infinity, '5', null, undefined, MAX_SCORE + 1, 1e306, {}]) assert.strictEqual(scores.submit('stack', v), null, String(v));
  assert.strictEqual(fs.existsSync(file), false);
});

test('the best is written atomically: a replaced file, no temp left behind', () => {
  const { scores, dir, file } = rig();
  scores.submit('stack', 5);
  scores.submit('stack', 9);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { stack: 9, merge: 0, pipeline: 0 });
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp')), []);
});

test('a corrupt file reads as no bests, and the next best replaces it', () => {
  const { scores, file } = rig();
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(scores.read(), zero);
  assert.deepStrictEqual(scores.submit('merge', 12), { stack: 0, merge: 12, pipeline: 0 });
});

test('a stored value that isn\'t a plain count reads as 0 for that game only', () => {
  const { scores, file } = rig();
  fs.writeFileSync(file, JSON.stringify({ stack: '12', merge: 5, pipeline: -3 }));
  assert.deepStrictEqual(scores.read(), { stack: 0, merge: 5, pipeline: 0 });
  for (const bad of ['[]', 'null', '"x"', '7', '{"stack":null,"merge":1.5,"pipeline":1e306}']) {
    fs.writeFileSync(file, bad);
    assert.deepStrictEqual(scores.read(), zero, bad);
  }
});

test('a store that throws reads as no bests and a submit answers null instead of raising', () => {
  const scores = createScoreStore({ read: () => { throw new Error('EBUSY'); }, write: () => { throw new Error('EBUSY'); } });
  assert.deepStrictEqual(scores.read(), zero);
  assert.strictEqual(scores.submit('stack', 3), null);
});

test('a store whose write fails answers null and keeps the old bests', () => {
  const { store, scores } = rig();
  scores.submit('stack', 4);
  const failing = createScoreStore({ read: store.read, withLock: store.withLock, write: () => { throw new Error('EPERM'); } });
  assert.strictEqual(failing.submit('stack', 9), null);
  assert.strictEqual(scores.read().stack, 4);
});

test('a lock that can\'t be taken refuses the raise rather than writing unlocked', () => {
  const { store } = rig();
  let wrote = false;
  const locked = createScoreStore({ read: () => ({}), write: () => { wrote = true; }, withLock: () => { throw new Error('locked'); } });
  assert.strictEqual(locked.submit('stack', 9), null);
  assert.strictEqual(wrote, false);
  assert.ok(store);
});

test('the raise runs inside the store\'s lock, under the games key', () => {
  const calls = [];
  const scores = createScoreStore({
    read: () => ({ stack: 2 }),
    write: (k, v) => calls.push(['write', k, v]),
    withLock: (k, fn) => { calls.push(['lock', k]); return fn(); },
  });
  scores.submit('stack', 5);
  assert.deepStrictEqual(calls, [['lock', KEY], ['write', KEY, { stack: 5, merge: 0, pipeline: 0 }]]);
});

test('P: whatever is stored, clean() gives all three games as whole counts in range', () => {
  fc.assert(fc.property(fc.anything(), (raw) => {
    const c = clean(raw);
    assert.deepStrictEqual(Object.keys(c), [...GAMES]);
    for (const g of GAMES) assert.ok(Number.isInteger(c[g]) && c[g] >= 0 && c[g] <= MAX_SCORE);
  }), { numRuns: 300 });
});

test('P: after any run of submits the best of each game is the max of what was accepted', () => {
  const sub = fc.record({ g: fc.constantFrom(...GAMES, 'nope'), v: fc.oneof(fc.integer({ min: -5, max: 500 }), fc.double()) });
  fc.assert(fc.property(fc.array(sub, { maxLength: 25 }), (subs) => {
    const { scores } = rig();
    const want = { ...zero };
    for (const { g, v } of subs) {
      scores.submit(g, v);
      if (GAMES.includes(g) && Number.isInteger(v) && v >= 0 && v <= MAX_SCORE) want[g] = Math.max(want[g], v);
    }
    assert.deepStrictEqual(scores.read(), want);
  }), { numRuns: 40 });
});
